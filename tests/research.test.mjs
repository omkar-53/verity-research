import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { createResearchHandler, discover, googleScholar, mergeSources } from '../server/search.mjs';
import { createPlan, extractEvidence, getAssessment, getSummary, makeMarkdown } from '../src/model.ts';
import { example } from '../src/example.ts';

test('example citations lead to source passages and export with publication links', () => {
  for (const { evidenceId } of getSummary(example).filter((item) => item.evidenceId)) {
    const evidence = example.evidence.find((item) => item.id === evidenceId);
    assert.ok(evidence?.passage.text);
    assert.ok(example.sources.find((source) => source.id === evidence.sourceId)?.url);
  }
  assert.match(makeMarkdown(example), /before release\. \[1\]/);
});

test('keyword retrieval preserves the actual passage and abstains until review', () => {
  const plan = createPlan('Does pair programming improve code quality?');
  const sentence = 'Pair programming was compared with individual programming in a controlled trial.';
  const source = { id: 'trial', title: 'Trial', access: 'full' };
  const evidence = extractEvidence(source, [{ text: sentence, location: 'PDF page 2' }], plan);
  assert.equal(evidence[0].passage.text, sentence);
  assert.equal(evidence[0].passage.location, 'PDF page 2');
  assert.equal(evidence[0].reviewed, false);
  const session = { ...plan, evidence, sources: [source] };
  assert.equal(getAssessment(session), 'Insufficient evidence');
  assert.deepEqual(extractEvidence(source, [{ text: 'Snow crystals grow in hexagonal patterns.', location: 'Abstract' }], plan), []);
  evidence[0] = { ...evidence[0], stance: 'supports', reviewed: true };
  assert.equal(getSummary(session).at(-1).evidenceId, evidence[0].id);
});

test('duplicates with and without DOIs retain the available abstract', () => {
  const work = { title: 'A research paper', key: 'a', provider: 'OpenAlex' };
  const sources = mergeSources([[work], [{ ...work, key: 'b', doi: '10.1234/z', abstract: 'Evidence', provider: 'Crossref' }]]);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].access, 'abstract');
  assert.equal(sources[0].abstract, 'Evidence');
  assert.equal(sources[0].doi, '10.1234/z');
});

async function searchResponse(providers, query) {
  const req = Readable.from([Buffer.from(JSON.stringify({ query }))]);
  Object.assign(req, { method: 'POST', headers: { 'content-type': 'application/json' } });
  const res = {
    writeHead(status) { this.status = status; },
    end(body) { this.body = JSON.parse(body); },
  };
  await createResearchHandler({}, providers)(req, res);
  return res;
}

const unavailable = async () => { throw Error('unavailable'); };
test('partial provider failure preserves available results with coverage notes', async () => {
  const res = await searchResponse({ openAlex: unavailable, crossref: async () => [] }, 'test');
  assert.equal(res.status, 200);
  assert.match(res.body.warnings[0], /OpenAlex/);
});

test('a provider outage is distinguishable from an empty search and bad input', async () => {
  const providers = { openAlex: unavailable, crossref: unavailable };
  assert.equal((await searchResponse(providers, 'test')).status, 502);
  assert.equal((await searchResponse(providers, 'x')).status, 400);
});

test('Google Scholar results expand discovery without promoting snippets to evidence', async (t) => {
  const snippet = 'Search result excerpt that must never be sent to the evidence model.';
  const scholar = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url.origin, 'https://serpapi.com');
    assert.equal(url.searchParams.get('engine'), 'google_scholar');
    assert.equal(url.searchParams.get('q'), 'pair programming');
    assert.equal(url.searchParams.get('api_key'), 'test-key');
    assert.equal(options.redirect, 'error');
    return Response.json({
      search_metadata: { status: 'Success' },
      organic_results: [
        {
          title: 'An independently discovered trial',
          link: 'https://doi.org/10.12345/trial',
          snippet,
          publication_info: { summary: 'A Lee, K Rao - Proceedings, 2022 - example.org' },
        },
        {
          title: 'A repository paper',
          link: 'https://example.org/paper',
          resources: [{ link: 'https://arxiv.org/pdf/2202.00001v2.pdf' }],
          snippet,
        },
      ],
    });
  });
  const existing = Array.from({ length: 16 }, (_, i) => ({
    key: 'existing-' + i,
    title: 'Indexed paper ' + i,
    provider: 'OpenAlex',
    abstract: 'An original indexed abstract.',
  }));
  const providers = {
    openAlex: async () => existing,
    crossref: async () => [],
    googleScholar,
    lookupOpenAlexDois: async (dois) => {
      assert.deepEqual(dois, ['10.12345/trial']);
      return [{
        key: 'lookup',
        doi: dois[0],
        title: 'A different indexed title for the same trial',
        abstract: 'An authentic indexed abstract for the trial.',
        provider: 'OpenAlex',
      }];
    },
  };
  const disabled = await discover('pair programming', {}, providers);
  assert.equal(disabled.sources.length, 16);
  assert.equal(scholar.mock.callCount(), 0);

  const enabled = await discover('pair programming', { SERPAPI_API_KEY: 'test-key' }, providers);
  const [trial, repository] = enabled.sources.slice(16);
  assert.equal(enabled.sources.length, 18);
  assert.equal(scholar.mock.callCount(), 1);
  assert.deepEqual(enabled.warnings, []);
  assert.equal(trial.access, 'abstract');
  assert.deepEqual(trial.discoveredBy, ['Google Scholar', 'OpenAlex']);
  assert.deepEqual(trial.authors, ['A Lee', 'K Rao']);
  assert.equal(trial.year, 2022);
  assert.equal(repository.arxivId, '2202.00001');
  assert.equal(repository.access, 'metadata');
  assert.ok(!JSON.stringify(enabled).includes(snippet));
});

test('an unavailable Google Scholar search leaves other providers usable', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'Quota exceeded' }, { status: 429 }));
  const { sources, warnings } = await discover('pair programming', { SERPAPI_API_KEY: 'test-key' }, {
    openAlex: async () => [{ key: 'trial', title: 'Programming trial', provider: 'OpenAlex' }],
    crossref: async () => [],
    googleScholar,
  });
  assert.equal(sources.length, 1);
  assert.deepEqual(warnings, ['Google Scholar was unavailable.']);
});
