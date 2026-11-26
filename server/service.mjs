import express from 'express';
import pg from 'pg';
import Redis from 'ioredis';
import { Queue, UnrecoverableError, Worker } from 'bullmq';
import { randomUUID, randomBytes, createHash, scrypt as derive, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';
import { aiClient } from './ai.mjs';
import { pipeline } from './pipeline.mjs';
import { discover } from './search.mjs';
import { readFile } from 'node:fs/promises';
import { summarizeUsage } from './usage.mjs';

const scrypt = promisify(derive);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const uuid = z.string().uuid();
const scope = z.object({
  subject: z.string(),
  comparison: z.string(),
  outcome: z.string(),
  population: z.string(),
  claimType: z.string(),
});
const plan = z.object({
  planId: uuid.optional(),
  scope: scope.optional(),
  planner: z.string().max(150).optional(),
  claim: z.string().trim().min(12).max(500),
  query: z.string().max(240),
  questions: z.array(z.string().trim().min(5).max(300)).min(1).max(8),
  searchOnline: z.boolean(),
  attachments: z.array(z.string().max(300)).max(5),
});
const upload = z.object({
  source: z.object({
    id: z.string().regex(/^pdf-[a-f0-9]{24}$/),
    title: z.string().max(300),
    provider: z.literal('Local upload'),
    authors: z.array(z.string()).length(0),
    type: z.literal('PDF'),
    access: z.enum(['full', 'metadata']),
    venue: z.string().max(100),
  }),
  warning: z.string().max(500).optional(),
  passages: z.array(z.object({ text: z.string().max(180000), location: z.string().max(100) })).max(60),
});
const account = z.object({
  email: z
    .string()
    .email()
    .max(254)
    .transform((s) => s.toLowerCase()),
  password: z.string().min(10).max(150),
});
const review = z.object({
  citationJudgment: z.enum(['grounded', 'unsupported']).optional(),
  stance: z.enum(['supports', 'contradicts', 'inconclusive']),
  finding: z.string().trim().min(8).max(800),
  explanation: z.string().trim().min(8).max(800),
  question: z.string().max(300),
});
const fail = (status, message) => Object.assign(new Error(message), { status });
const schema = `
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS researchers(id uuid PRIMARY KEY,email text UNIQUE,password_hash text);
CREATE TABLE IF NOT EXISTS logins(token text PRIMARY KEY, researcher uuid REFERENCES researchers,expires timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS investigations(id uuid PRIMARY KEY,owner uuid NOT NULL REFERENCES researchers,run uuid NOT NULL UNIQUE,
  report jsonb NOT NULL, uploads jsonb NOT NULL,created timestamptz DEFAULT now());
CREATE INDEX IF NOT EXISTS investigations_owner ON investigations(owner);
ALTER TABLE investigations ADD COLUMN IF NOT EXISTS queue_name text NOT NULL DEFAULT 'verity-research-v1';
CREATE TABLE IF NOT EXISTS research_plans(id uuid PRIMARY KEY, owner uuid NOT NULL REFERENCES researchers, claim text NOT NULL, usage jsonb NOT NULL, used_run uuid);
CREATE TABLE IF NOT EXISTS model_usage(investigation uuid NOT NULL REFERENCES investigations, run uuid NOT NULL, event jsonb NOT NULL);
CREATE INDEX IF NOT EXISTS model_usage_investigation ON model_usage(investigation);
CREATE TABLE IF NOT EXISTS chunks(job uuid,id integer,source_id text,title text,location text,content text,embedding vector,PRIMARY KEY(job,id));
CREATE TABLE IF NOT EXISTS research_inputs(run uuid PRIMARY KEY, documents jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS report_versions(id uuid, run uuid, saved timestamptz DEFAULT clock_timestamp(), report jsonb NOT NULL);
`;

export async function createService(env) {
  if (!env.DATABASE_URL || !env.REDIS_URL) throw Error('Configure DATABASE_URL and REDIS_URL in .env.');
  const db = new pg.Pool({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 7000 });
  await db.query(schema);
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const queue = new Queue(env.RESEARCH_QUEUE_NAME || 'verity-research-v1', { connection: redis });
  async function enqueue(run) {
    await queue.add(
      'investigate',
      { run },
      {
        jobId: run,
        attempts: 2,
        backoff: { type: 'exponential', delay: 3000 },
        removeOnComplete: 300,
        removeOnFail: 300,
      },
    );
  }
  const worker = new Worker(
    queue.name,
    async (job) => {
      const run = job.data.run;
      const {
        rows: [record],
      } = await db.query('SELECT * FROM investigations WHERE run=$1', [run]);
      if (!record || ['complete', 'failed'].includes(record.report.status)) return;
      async function update(patch) {
        const result = await db.query(
          "UPDATE investigations SET report=report || $2::jsonb WHERE run=$1 AND report->>'status' NOT IN ('complete','failed') RETURNING report",
          [run, JSON.stringify({ ...patch, updatedAt: new Date().toISOString() })],
        );
        if (!result.rowCount) throw Error('This run was stopped or superseded.');
        return result.rows[0].report;
      }
      try {
        const ai = aiClient(env, async (event) => {
          await db.query('INSERT INTO model_usage VALUES($1,$2,$3)', [record.id, run, event]);
        });
        let researchPlan = record.report;
        if (!researchPlan.questions.length) {
          await update({ status: 'queued', detail: 'Generating the research plan' });
          researchPlan = await update({ ...(await ai.plan(researchPlan.claim)), planner: ai.model });
        }
        const output = await pipeline({
          db,
          jobId: run,
          plan: researchPlan,
          uploads: record.uploads,
          env,
          ai,
          stage: (status, detail) => update({ status, detail, attempt: job.attemptsMade + 1 }),
        });
        const { rows: usage } = await db.query('SELECT event FROM model_usage WHERE investigation=$1', [record.id]);
        Object.assign(output.analysis, summarizeUsage(usage.map(({ event }) => event)));
        await update({ ...output, error: null, status: 'complete', detail: 'Citation review complete' });
      } catch (error) {
        const needsRefinement = error.status === 422;
        const last = needsRefinement || job.attemptsMade + 1 >= job.opts.attempts;
        await update({
          status: last ? 'failed' : 'queued',
          detail: last ? 'Investigation interrupted' : 'Retrying after an error',
          error: error.message,
        }).catch(() => {});
        if (needsRefinement) throw new UnrecoverableError(error.message);
        throw error;
      }
    },
    { connection: redis, concurrency: 1 },
  );
  worker.on('error', (e) => console.error('Research worker:', e.message));
  queue.on('error', (e) => console.error('Research queue:', e.message));
  // Reconcile the outbox and runs that exhausted BullMQ's stalled-job recovery.
  async function recover() {
    const { rows } = await db.query(
      "SELECT run FROM investigations WHERE queue_name=$1 AND report->>'status' IN ('queued','searching','reading')",
      [queue.name],
    );
    await Promise.all(rows.map(async ({ run }) => {
      const job = await queue.getJob(run);
      if (!job) return enqueue(run);
      if (await job.getState() !== 'failed') return;
      await db.query(
        "UPDATE investigations SET report=report || $2::jsonb WHERE run=$1 AND report->>'status' IN ('queued','searching','reading')",
        [run, JSON.stringify({
          status: 'failed',
          detail: 'Investigation interrupted',
          error: 'The research queue exhausted recovery attempts. Retry the investigation.',
          updatedAt: new Date().toISOString(),
        })],
      );
    }));
  }
  await recover();
  const timer = setInterval(
    () => recover().catch((e) => console.error('Queue recovery:', e.message)),
    15000,
  );
  timer.unref();
  const app = express();
  app.disable('x-powered-by');
  app.get('/health', async (_req, res) => {
    try {
      await db.query('SELECT 1');
      if (redis.status !== 'ready') return res.status(503).json({ status: 'unavailable' });
      res.json({ status: 'ready' });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (
      !['GET', 'HEAD'].includes(req.method) &&
      req.headers.origin &&
      new URL(req.headers.origin).host !== req.headers.host
    )
      return res.status(403).json({ error: 'Invalid request origin.' });
    next();
  });
  app.use(express.json({ limit: '18mb' }));
  const cookieOptions = {
    httpOnly: true,
    sameSite: 'strict',
    secure: env.COOKIE_SECURE === 'true',
    maxAge: 30 * 86400000,
    path: '/',
  };
  async function issue(res, id) {
    const token = randomBytes(32).toString('hex');
    await db.query("INSERT INTO logins VALUES($1,$2,now()+interval '30 days')", [hash(token), id]);
    res.cookie('verity_session', token, cookieOptions);
  }
  app.use(async (req, res, next) => {
    const token = (req.headers.cookie || '').match(
      /(?:^|;\s*)verity_session=([a-f0-9]{64})(?:;|$)/,
    )?.[1];
    if (token) {
      const {
        rows: [user],
      } = await db.query(
        'SELECT r.id,r.email FROM researchers r JOIN logins l ON r.id=l.researcher WHERE l.token=$1 AND l.expires>now()',
        [hash(token)],
      );
      if (user) {
        req.user = user;
        req.token = hash(token);
        return next();
      }
    }
    const id = randomUUID();
    await db.query('INSERT INTO researchers(id) VALUES($1)', [id]);
    await issue(res, id);
    req.user = { id, email: null };
    next();
  });
  app.get('/account', (req, res) => res.json(req.user));
  app.post('/account/register', async (req, res) => {
    if (req.user.email) throw fail(409, 'This workspace already has an account.');
    const { email, password } = account.parse(req.body);
    const salt = randomBytes(16).toString('hex'),
      digest = (await scrypt(password, salt, 64)).toString('hex');
    try {
      await db.query('UPDATE researchers SET email=$1,password_hash=$2 WHERE id=$3', [
        email,
        salt + '.' + digest,
        req.user.id,
      ]);
    } catch (e) {
      if (e.code === '23505') throw fail(409, 'This email is already registered.');
      throw e;
    }
    if (req.token) await db.query('DELETE FROM logins WHERE token=$1', [req.token]);
    await issue(res, req.user.id);
    res.json({ id: req.user.id, email });
  });
  const failures = new Map();
  app.post('/account/login', async (req, res) => {
    const address = req.socket.remoteAddress;
    const recent = (failures.get(address) || []).filter((t) => Date.now() - t < 60000);
    if (recent.length >= 12) throw fail(429, 'Too many sign-in attempts. Try again in one minute.');
    failures.set(address, [...recent, Date.now()]);
    const { email, password } = account.parse(req.body);
    const {
      rows: [user],
    } = await db.query('SELECT * FROM researchers WHERE email=$1', [email]);
    const [salt, digest] = (user?.password_hash || '0.' + '0'.repeat(128)).split('.');
    const actual = await scrypt(password, salt, 64);
    if (!user || !timingSafeEqual(actual, Buffer.from(digest, 'hex')))
      throw fail(401, 'Incorrect email or password.');
    if (req.token) await db.query('DELETE FROM logins WHERE token=$1', [req.token]);
    failures.delete(address);
    await issue(res, user.id);
    res.json({ id: user.id, email });
  });
  app.post('/account/logout', async (req, res) => {
    if (req.token) await db.query('DELETE FROM logins WHERE token=$1', [req.token]);
    res.clearCookie('verity_session', { path: '/' }).json({ ok: true });
  });
  app.post('/search', async (req, res) => {
    const { query } = z.object({ query: z.string().trim().min(3).max(240) }).parse(req.body);
    res.json(await discover(query, env));
  });
  app.get('/research/:id/chunks/:chunkId', async (req, res) => {
    const chunk = z.coerce.number().int().positive().parse(req.params.chunkId);
    const {
      rows: [item],
    } = await db.query('SELECT id,source_id,title,location,content FROM chunks WHERE job=$1 AND id=$2', [
      req.record.run,
      chunk,
    ]);
    if (!item) throw fail(404, 'Passage unavailable.');
    res.json(item);
  });
  app.post('/plan', async (req, res) => {
    const { claim } = plan.pick({ claim: true }).parse(req.body);
    const usage = [];
    const ai = aiClient(env, async (event) => { usage.push(event); });
    const planned = await ai.plan(claim);
    const planId = randomUUID();
    await db.query('INSERT INTO research_plans (id,owner,claim,usage) VALUES($1,$2,$3,$4)', [
      planId, req.user.id, claim, JSON.stringify(usage),
    ]);
    res.json({
      claim,
      ...planned,
      planId,
      searchOnline: true,
      attachments: [],
      planner: ai.model,
    });
  });
  app.get('/research', async (req, res) => {
    const result = await db.query(
      'SELECT report FROM investigations WHERE owner=$1 ORDER BY created DESC',
      [req.user.id],
    );
    res.json(result.rows.map((x) => x.report));
  });
  app.post('/research', async (req, res) => {
    const input =
      Object.keys(req.body || {}).length === 1 && typeof req.body?.claim === 'string'
        ? {
            ...plan.pick({ claim: true }).parse(req.body),
            questions: [],
            query: '',
            searchOnline: true,
            attachments: [],
          }
        : plan.parse(req.body);
    const uploads = z
      .array(upload)
      .max(5)
      .parse(req.body.uploads ?? []);
    if (!input.searchOnline && !uploads.length) throw fail(400, 'Enable search or attach a document.');
    const id = randomUUID(),
      run = randomUUID(),
      now = new Date().toISOString();
    const record = {
      ...input,
      id,
      createdAt: now,
      updatedAt: now,
      status: 'queued',
      sources: [],
      evidence: [],
      warnings: [],
      serverManaged: true,
    };
    await db.query(`WITH investigation AS (
        INSERT INTO investigations(id,owner,run,report,uploads,queue_name) VALUES($1,$2,$3,$4,$5,$6)
        RETURNING id, run, owner
      ), claimed_plan AS (
        UPDATE research_plans p SET used_run=i.run FROM investigation i
        WHERE p.id=$7 AND p.owner=i.owner AND p.claim=$8 AND p.used_run IS NULL
        RETURNING i.id, i.run, p.usage
      )
      INSERT INTO model_usage (investigation,run,event)
      SELECT id,run,event FROM claimed_plan CROSS JOIN LATERAL jsonb_array_elements(usage) AS event`, [
      id,
      req.user.id,
      run,
      record,
      JSON.stringify(uploads),
      queue.name,
      input.planId ?? null,
      input.claim,
    ]);
    await enqueue(run).catch(() => {});
    res.status(202).json(record);
  });
  app.param('id', async (req, res, next, id) => {
    if (!uuid.safeParse(id).success) throw fail(404, 'Investigation unavailable.');
    const {
      rows: [record],
    } = await db.query('SELECT report,run FROM investigations WHERE id=$1 AND owner=$2', [
      id,
      req.user.id,
    ]);
    if (!record) throw fail(404, 'Investigation unavailable.');
    req.record = record;
    next();
  });
  app.get('/research/:id', (req, res) => res.json(req.record.report));
  app.get('/research/:id/events', async (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
    res.flushHeaders();
    let closed = false;
    res.on('close', () => {
      closed = true;
    });
    let previous = '';
    while (!closed) {
      const {
        rows: [row],
      } = await db.query('SELECT report FROM investigations WHERE id=$1 AND owner=$2', [
        req.params.id,
        req.user.id,
      ]);
      if (!row) break;
      const { status, detail, updatedAt } = row.report;
      if (updatedAt !== previous)
        res.write('data: ' + JSON.stringify({ status, detail, updatedAt }) + '\n\n');
      if (['failed', 'complete'].includes(status)) break;
      previous = updatedAt;
      await new Promise((r) => setTimeout(r, 1200));
    }
    res.end();
  });
  for (const field of ['questions', 'sources', 'evidence', 'report'])
    app.get('/research/:id/' + field, (req, res) =>
      res.json(field === 'report' ? req.record.report : req.record.report[field]),
    );
  app.post('/research/:id/stop', async (req, res) => {
    const result = await db.query(
      "UPDATE investigations SET report=report || $2::jsonb WHERE run=$1 AND report->>'status' NOT IN ('complete','failed') RETURNING report",
      [
        req.record.run,
        JSON.stringify({
          status: 'failed',
          error: 'Investigation stopped.',
          updatedAt: new Date().toISOString(),
        }),
      ],
    );
    res.json(result.rows[0]?.report || req.record.report);
  });
  app.post('/research/:id/retry', async (req, res) => {
    const run = randomUUID();
    const result = await db.query(
      "UPDATE investigations SET run=$2, report=(report-'error') || $3::jsonb WHERE run=$1 AND report->>'status'='failed' RETURNING report",
      [
        req.record.run,
        run,
        JSON.stringify({
          status: 'queued',
          detail: 'Queued for retry',
          updatedAt: new Date().toISOString(),
        }),
      ],
    );
    if (!result.rowCount) throw fail(409, 'Only interrupted investigations can be retried.');
    await enqueue(run).catch(() => {});
    res.status(202).json(result.rows[0].report);
  });
  app.patch('/research/:id/evidence/:evidenceId', async (req, res) => {
    const values = review.parse(req.body),
      current = req.record.report;
    if (
      !current.questions.includes(values.question) ||
      !current.evidence.some((e) => e.id === req.params.evidenceId)
    )
      throw fail(400, 'Unknown passage or question.');
    const record = {
      ...current,
      summary: [],
      updatedAt: new Date().toISOString(),
      evidence: current.evidence.map((e) =>
        e.id === req.params.evidenceId
          ? {
              ...e,
              ...values,
              title: values.finding,
              originalAI: e.originalAI || { stance: e.stance, finding: e.finding },
              reviewed: true,
              aiVerified: false,
            }
          : e,
      ),
    };
    const result = await db.query(
      `WITH old AS (SELECT * FROM investigations WHERE id=$1 AND report->>'updatedAt'=$2 FOR UPDATE),
      version AS (INSERT INTO report_versions SELECT id,run,clock_timestamp(),report FROM old)
      UPDATE investigations i SET report=$3 FROM old WHERE i.id=old.id RETURNING i.report`,
      [current.id, current.updatedAt, record],
    );
    if (!result.rowCount) throw fail(409, 'A newer review exists. Reopen the passage and try again.');
    res.json(result.rows[0].report);
  });
  app.get('/evaluation', async (req, res) => {
    const { rows } = await db.query(
      "SELECT report->'analysis' AS metrics,report->>'claim' AS claim FROM investigations WHERE owner=$1 AND report ? 'analysis' ORDER BY created DESC",
      [req.user.id],
    );
    const benchmarks = await Promise.all(['reranking-results','scifact-results','results','custom-results'].map(async filename=>{
      try{return JSON.parse(await readFile(new URL('../evaluation/'+filename+'.json',import.meta.url),'utf8'));}
      catch(e){if(e.code==='ENOENT')return null;throw e;}
    }));
    const {
      rows: [judgments],
    } = await db.query(
      `SELECT count(*)::int AS total,
      count(*) FILTER (WHERE e->>'citationJudgment'='grounded')::int AS grounded,
      count(*) FILTER (WHERE e->>'stance'=e->'originalAI'->>'stance')::int AS agreed
      FROM investigations CROSS JOIN LATERAL jsonb_array_elements(report->'evidence') e
      WHERE owner=$1 AND e ? 'originalAI' AND e ? 'citationJudgment'`,
      [req.user.id],
    );
    res.json({ runs: rows, benchmarks:benchmarks.filter(Boolean), judgments });
  });
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err instanceof z.ZodError ? 400 : err.status || 500;
    res
      .status(status)
      .json({
        error:
          err instanceof z.ZodError
            ? 'Invalid input: ' + err.issues[0].message
            : status === 500 && err.code
              ? 'The research service is temporarily unavailable.'
              : err.message,
      });
  });
  return {
    app,
    close: async () => {
      clearInterval(timer);
      await worker.close();
      await queue.close();
      await redis.quit();
      await db.end();
    },
  };
}
