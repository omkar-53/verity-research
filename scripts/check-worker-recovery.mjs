import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

// Use a private queue and a deterministic model so this check can deliberately
// terminate its own worker without interrupting investigations in the app.
const queue = 'verity-recovery-' + randomUUID();
const claim = 'Does incremental compilation shorten build times in the supplied trial?';
const quote = 'The median build time decreased from 60 seconds to 30 seconds with incremental compilation.';
const irrelevant = 'The survey also asked engineers about their preferred source code editor.';
let stalled = false;
let holdEmbedding = true;
const model = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body);
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/api/embed') {
    if (holdEmbedding) { stalled = true; return; }
    res.end(JSON.stringify({ embeddings: request.input.map(() => [1, 0, 1]), prompt_eval_count: 12 }));
    return;
  }
  const [user] = request.messages.filter(({ role }) => role === 'user');
  const input = JSON.parse(user.content);
  const fields = request.format.properties;
  let output;
  if ('ordered' in fields) output = { ordered: input.candidates.map(({ id }) => id).reverse() };
  else if ('findings' in fields) output = {
    findings: [{
      chunk: input.passages.find(({ text }) => text.includes(quote)).index,
      question: 0, quote, finding: quote, stance: 'supports', reason: 'The trial measured duration.',
      limitation: 'One trial.',
    }],
  };
  else if ('statements' in fields) output = { statements: [{ index: 0, text: quote }] };
  else output = { accepted: [0] };
  res.end(JSON.stringify({ message: { content: JSON.stringify(output) }, prompt_eval_count: 12, eval_count: 5 }));
});
model.listen(0, '127.0.0.1');
await once(model, 'listening');

async function waitFor(operation, description, timeoutMs = 100_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const result = await operation();
    if (result) return result;
    await delay(400);
  } while (Date.now() < deadline);
  throw Error('Timed out waiting for ' + description);
}

const processes = [];
async function startWorker() {
  const child = spawn(process.execPath, ['server/start.mjs'], {
    env: {
      ...process.env, AI_PROVIDER: 'ollama', HOST: '127.0.0.1', PORT: '0',
      COOKIE_SECURE: 'false', RESEARCH_QUEUE_NAME: queue,
      OLLAMA_URL: 'http://127.0.0.1:' + model.address().port,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  processes.push(child);
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const base = await waitFor(() => {
    if (child.exitCode !== null) throw Error('Isolated worker failed to start\n' + output);
    return output.match(/Verity is available at (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
  }, 'a worker to listen', 15_000);
  await waitFor(async () => (await fetch(base + '/api/health')).ok, 'worker readiness', 10_000);
  return { base, child };
}

try {
  const first = await startWorker();
  const submission = await fetch(first.base + '/api/research', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      claim,
      query: 'incremental compilation',
      questions: [claim],
      searchOnline: false,
      attachments: ['Recovery fixture.pdf'],
      uploads: [{
        source: {
          id: 'pdf-0123456789abcdef01234567', title: 'Recovery fixture', provider: 'Local upload',
          authors: [], type: 'PDF', access: 'full', venue: 'User-provided document',
        },
        passages: [{ location: 'PDF page 1', text: quote }, { location: 'PDF page 2', text: irrelevant }],
      }],
    }),
  });
  assert.equal(submission.status, 202);
  const cookie = submission.headers.getSetCookie()[0].split(';')[0];
  const { id } = await submission.json();
  const load = async ({ base }) => {
    const response = await fetch(base + '/api/research/' + id, { headers: { cookie } });
    assert.equal(response.status, 200);
    return response.json();
  };
  await waitFor(() => stalled, 'the in-flight embedding request', 15_000);
  assert.equal((await load(first)).status, 'reading');
  const stopped = once(first.child, 'exit');
  first.child.kill('SIGKILL');
  await stopped;
  holdEmbedding = false;

  const second = await startWorker();
  assert.ok(['reading', 'complete'].includes((await load(second)).status));
  const report = await waitFor(async () => {
    const current = await load(second);
    if (current.status === 'failed') throw Error(current.error);
    return current.status === 'complete' ? current : null;
  }, 'BullMQ to resume the interrupted investigation');
  assert.equal(report.id, id);
  assert.equal(report.analysis.ranking, 'model');
  assert.equal(report.analysis.candidates, 2);
  assert.equal(report.analysis.cost.estimatedUsd, 0);
  assert.equal(report.summary[0].evidenceId, report.evidence[0].id);
  assert.equal(report.evidence[0].passage.location, 'PDF page 1');
  assert.equal(report.evidence[0].passage.text, quote);
  console.log('Passed: the replacement worker resumed the interrupted job and saved a cited report.');
} finally {
  for (const child of processes) {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, 'exit');
      child.kill();
      await stopped;
    }
  }
  model.closeAllConnections();
  model.close();
}
