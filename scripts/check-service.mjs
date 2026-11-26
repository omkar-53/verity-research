// Integration acceptance check against a running local installation.
// Creates a private test workspace and one synthetic PDF-text investigation.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
const base = process.env.VERITY_TEST_URL || 'http://127.0.0.1:4173';
if (!['127.0.0.1', 'localhost'].includes(new URL(base).hostname))
  throw Error('Choose a local test server.');
function client() {
  let cookie = '';
  return async (path, method = 'GET', data, expected = 200) => {
    const res = await fetch(base + '/api/' + path, {
      method,
      headers: { cookie, 'Content-Type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const token = res.headers.getSetCookie().at(-1);
    if (token) cookie = token.split(';')[0];
    const value = await res.json();
    assert.equal(res.status, expected, method + ' ' + path + ': ' + (value.error || res.status));
    return value;
  };
}
const a = client(),
  b = client();
const user = await a('account');
const credentials = {
  email: 'acceptance-' + randomUUID() + '@example.invalid',
  password: randomBytes(28).toString('hex'),
};
const signed = await a('account/register', 'POST', credentials);
assert.equal(signed.id, user.id);
await b('account');
await a('research', 'POST', {}, 400);
const refinement = await a('plan', 'POST', { claim: 'What can you tell me about everything in technology?' }, 422);
assert.ok(refinement.error.length > 10);
const claim = 'Does incremental compilation reduce build time in this controlled trial?';
const text =
  'In this controlled trial, incremental compilation reduced median build time from 60 seconds to 30 seconds on the same codebase.';
const generated = await a('plan', 'POST', { claim });
assert.ok(generated.planId);
assert.ok(generated.questions.length);
const plan = {
  ...generated,
  claim,
  questions: [claim],
  query: 'incremental compilation build time',
  attachments: ['Controlled fixture.pdf'],
  searchOnline: false,
  uploads: [
    {
      source: {
        id: 'pdf-0123456789abcdef01234567',
        title: 'Controlled acceptance fixture',
        provider: 'Local upload',
        authors: [],
        type: 'PDF',
        access: 'full',
        venue: 'User-provided document',
      },
      passages: [
        { location: 'PDF page 1', text },
        { location: 'PDF page 2', text: 'The engineering team also tracked how frequently participants updated their text editor.' },
      ],
    },
  ],
};
const { id } = await a('research', 'POST', plan, 202);
await b('research/' + id, 'GET', undefined, 404);
await a('research/' + id + '/stop', 'POST', {});
await a('research/' + id + '/retry', 'POST', {}, 202);
await a('account/logout', 'POST', {});
await a('research/' + id, 'GET', undefined, 404);
assert.equal((await a('account/login', 'POST', credentials)).id, user.id);
const deadline = Date.now() + 9 * 60000;
let record;
do {
  record = await a('research/' + id);
  if (record.status === 'failed') throw Error(record.error);
  if (record.status === 'complete') break;
  await new Promise((r) => setTimeout(r, 2500));
} while (Date.now() < deadline);
assert.equal(record.status, 'complete');
assert.ok(record.evidence.length, 'Expected a verified finding from controlled evidence');
assert.ok(record.summary?.length, 'Expected a synthesized and verified summary');
assert.equal(record.analysis.ranking, 'model');
assert.equal(record.analysis.cost.estimatedUsd, 0);
assert.equal(record.analysis.embeddingCalls, 1);
assert.ok(record.analysis.calls >= 6, 'Expected recorded planning, ranking, analysis and verification calls');
for (const item of record.evidence) assert.ok(text.includes(item.passage.text));
for (const sentence of record.summary)
  assert.ok(record.evidence.some((e) => e.id === sentence.evidenceId));
const item = record.evidence[0];
const updated = await a('research/' + id + '/evidence/' + item.id, 'PATCH', {
  ...item,
  finding: 'In this fixture the reported median build time fell by half.',
  explanation: 'The supplied passage directly reports both measured times.',
  stance: 'supports',
  citationJudgment: 'grounded',
});
assert.ok(updated.evidence[0].reviewed);
assert.equal(updated.summary.length, 0);
assert.ok((await a('research')).some((r) => r.id === id));
console.log(
  'Passed account registration, sign-in, isolation, stop/retry, durable history, inference, synthesis, exact citations, and report revision.',
);
