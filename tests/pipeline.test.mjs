import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifiedFindings, chunksFor } from '../server/pipeline.mjs';
const quote = 'The two cohorts produced the same mean defect count.';
const row = { id: 2, source_id: 'study', title: 'Trial', location: 'Results', content: quote };
const proposal = {
  chunk: 0,
  question: 0,
  quote,
  finding: quote,
  stance: 'inconclusive',
  reason: 'Reported equality',
  limitation: 'One cohort',
};
const plan = { claim: 'Does typing prevent defects?', questions: ['How many defects?'] };
test('untraceable quotes and invalid references cannot enter the report', async () => {
  const ai = {
    analyze: async () => ({
      findings: [
        { ...proposal, quote: 'An unrelated invented passage.' },
        { ...proposal, chunk: 1 },
        { ...proposal, question: 9 },
      ],
    }),
    verify: () => assert.fail(),
  };
  assert.equal((await verifiedFindings(ai, plan, [row])).evidence.length, 0);
});
test('verification drops rejected and unknown ids and deduplicates accepted quotes', async () => {
  const ai = {
    analyze: async () => ({ findings: [proposal] }),
    verify: async () => ({ accepted: [2] }),
  };
  assert.equal((await verifiedFindings(ai, plan, [row])).evidence.length, 0);
  ai.verify = async () => ({ accepted: [0, 0, 99] });
  const result = await verifiedFindings(ai, plan, [row]);
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].chunkId, 2);
  assert.equal(result.evidence[0].aiVerified, true);
  assert.equal(result.evidence[0].reviewed, false);
});
test('chunking retains source locations across pages', () => {
  const chunks = chunksFor([1, 2].map((n) => ({ location: 'Page ' + n, text: quote })));
  assert.deepEqual(
    chunks.map((c) => c.location),
    ['Page 1', 'Page 2'],
  );
});

test('a finding cannot add an unreported numeric outcome', async () => {
  const ai = {
    analyze: async () => ({
      findings: [{ ...proposal, finding: 'The study found 75% fewer defects.' }],
    }),
    verify: () => assert.fail(),
  };
  assert.equal((await verifiedFindings(ai, plan, [row])).evidence.length, 0);
});
