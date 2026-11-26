import { randomUUID } from 'node:crypto';
import { writeFile, rename, readFile } from 'node:fs/promises';
import pg from 'pg';
import { aiClient } from '../server/ai.mjs';
import { rankChunks, rerankChunks, verifiedFindings } from '../server/pipeline.mjs';
import { fixtures } from './fixtures.mjs';

const custom = process.argv.find((arg) => arg.startsWith('--dataset='))?.slice(10);
const cases = custom ? JSON.parse(await readFile(custom, 'utf8')) : fixtures;
const full = process.argv.includes('--full');
const scifact = process.argv.includes('--scifact');
const compareReranking = process.argv.includes('--compare-reranking');
if(scifact && (!custom || !cases.every(c=>c.id.startsWith('scifact-')))) throw Error('Provide the prepared SciFact dataset.');
const filename = compareReranking ? 'reranking-results' : scifact ? 'scifact-results' : custom ? 'custom-results' : 'results';
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
const ai = aiClient(process.env);
const destination = new URL('./'+filename+'.json', import.meta.url);
const observations = [];
await db.connect();
try {
  await db.query('CREATE TEMP TABLE chunks(job uuid,id int,content text,embedding vector)');
  const archive = cases.map((f, i) => ({
    id: i + 1,
    source_id: f.id,
    content: f.passage,
    location: 'Benchmark passage',
    title: f.topic,
  }));
  const vectors = await ai.embed(archive.map((r) => r.content));
  const queries = await ai.embed(cases.map((f) => f.claim));
  const job = randomUUID();
  for (const row of archive)
    await db.query('INSERT INTO chunks VALUES($1,$2,$3,$4::vector)', [
      job,
      row.id,
      row.content,
      JSON.stringify(vectors[row.id - 1]),
    ]);
  const retrievalCases = compareReranking && !full ? cases.slice(0, 10) : cases;
  for (const [i, f] of retrievalCases.entries()) {
    const candidates = await rankChunks(db, job, archive, [queries[i]], [f.claim], 14);
    const ranked = candidates.slice(0, 3);
    const reranked = compareReranking
      ? await rerankChunks(ai, { claim: f.claim, questions: [f.claim] }, candidates, [])
      : null;
    observations.push({
      id: f.id,
      relevant: f.stance === 'absent' ? 0 : 1,
      hit: f.stance !== 'absent' && ranked.some((r) => r.source_id === f.id) ? 1 : 0,
      retrieved: ranked.map((r) => r.source_id),
      ...(reranked && {
        reranking: reranked.method,
        reranked: reranked.passages.slice(0, 3).map((r) => r.source_id),
      }),
    });
    if (reranked) console.log('Compared ranking for case', i + 1, 'of', retrievalCases.length);
  }
  // One case of each relationship in the quick run. --full scores all cases.
  const sampled = compareReranking ? [] : full ? cases : cases.slice(0, scifact ? 10 : 5);
  for (const f of sampled) {
    const row = archive.find((r) => r.source_id === f.id);
    const result = await verifiedFindings(ai, { claim: f.claim, questions: [f.claim] }, [row]);
    const findings = result.evidence;
    Object.assign(
      observations.find((o) => o.id === f.id),
      {
        expected: f.stance,
        returned: findings.map((e) => e.stance),
        grounded: findings.filter((e) => row.content.includes(e.passage.text)).length,
      },
    );
    console.log(
      'Scored',
      f.id,
      'expected',
      f.stance,
      'received',
      findings.map((e) => e.stance).join(',') || 'abstained',
    );
  }
  const hits = observations.reduce((a, o) => a + o.hit, 0),
    relevant = observations.reduce((a, o) => a + o.relevant, 0);
  const classified = observations.filter((o) => o.returned),
    output = classified.reduce((a, o) => a + o.returned.length, 0);
  const absent = classified.filter((o) => o.expected === 'absent');
  const ratio = (n, d) => (d ? n / d : null);
  const result = {
    cases: retrievalCases.length,
    classificationCases: classified.length,
    dataset: scifact ? 'SciFact development subset' : custom ? 'Imported reference set' : 'Controlled synthetic studies',
    model: ai.model,
    embeddingModel: ai.embeddingModel,
    date: new Date().toISOString(),
    metrics: {
      'Retrieval recall@3': ratio(hits, relevant),
      'Retrieval precision@3': ratio(
        hits,
        observations.reduce((n, o) => n + o.retrieved.length, 0),
      ),
      'Stance agreement on supplied passages': ratio(
        classified.filter((o) =>
          o.expected === 'absent'
            ? !o.returned.length
            : o.returned.length && o.returned.every((s) => s === o.expected),
        ).length,
        classified.length,
      ),
      'Exact quote rate': ratio(
        classified.reduce((a, o) => a + o.grounded, 0),
        output,
      ),
      'Abstention on irrelevant material': ratio(
        absent.filter((o) => !o.returned.length).length,
        absent.length,
      ),
    },
    observations,
  };
  if (compareReranking) {
    const rerankedHits = observations.filter((item) => item.relevant && item.reranked.includes(item.id)).length;
    result.dataset += ' reranking comparison';
    result.candidatePool = archive.length;
    result.metrics = {
      'Hybrid recall@3': ratio(hits, relevant),
      'Reranked recall@3': ratio(rerankedHits, relevant),
      'Model reranking completion': ratio(observations.filter((item) => item.reranking === 'model').length, retrievalCases.length),
    };
  }
  await writeFile(new URL('./'+filename+'.tmp', import.meta.url), JSON.stringify(result, null, 2) + '\n');
  await rename(new URL('./'+filename+'.tmp', import.meta.url), destination);
  console.log(result.metrics);
} finally {
  await db.end();
}
