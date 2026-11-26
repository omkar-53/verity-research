import { createHash } from 'node:crypto';
import he from 'he';
import { aiClient } from './ai.mjs';
import { arxivIdFromLink, discover } from './search.mjs';

async function fullText(source) {
  const arxiv =
    (source.doi || '').match(/^10\.48550\/arxiv\.(\d{4}\.\d{4,5})$/i)?.[1] ||
    source.arxivId ||
    arxivIdFromLink(source.url);
  const pmc = /^PMC\d+$/.test(source.pmcid) && source.pmcid;
  if (!arxiv && !pmc) return [];
  const url = pmc
    ? 'https://www.ebi.ac.uk/europepmc/webservices/rest/' + pmc + '/fullTextXML'
    : 'https://arxiv.org/html/' + arxiv;
  const response = await fetch(url, { signal: AbortSignal.timeout(8500), redirect: 'error' });
  if (!response.ok) return [];
  const bytes = [];
  let size = 0;
  for await (const part of response.body) {
    size += part.length;
    if (size > 4_000_000) return [];
    bytes.push(Buffer.from(part));
  }
  const xml = Buffer.concat(bytes)
    .toString()
    .split(/<(?:ref-list|bibliography)\b/i)[0];
  const matches = [...xml.matchAll(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/gi)];
  return matches
    .slice(0, 90)
    .map((m, i) => ({
      location: 'Paragraph ' + (i + 1) + ' · ' + url,
      text: he
        .decode(m[1].replace(/<[^>]+>/g, ' '))
        .replace(/\s+/g, ' ')
        .trim(),
    }))
    .filter((p) => p.text.length >= 70);
}

export function chunksFor(passages) {
  const chunks = [];
  for (const passage of passages) {
    const sentences = new Intl.Segmenter('en', { granularity: 'sentence' }).segment(passage.text);
    let buffer = '';
    for (const { segment } of sentences) {
      if (buffer && buffer.length + segment.length > 900) {
        chunks.push({ location: passage.location, text: buffer.trim() });
        buffer = '';
      }
      if (segment.length > 1400) {
        for (let i = 0; i < segment.length; i += 850)
          chunks.push({ location: passage.location, text: segment.slice(i, i + 900).trim() });
      } else buffer += segment;
    }
    if (buffer.trim()) chunks.push({ location: passage.location, text: buffer.trim() });
  }
  return chunks.filter((p) => p.text.length >= 35).slice(0, 90);
}

// Keep the complete local context available to the verifier when a proposed quote
// omits an outcome named in the finding. The final quoted span stays verbatim.
export function citationText(passage, finding, quote, claim) {
  if (quote.length < 15 || !passage.includes(quote)) return null;
  const numbers = finding.match(/\b\d+(?:[.,]\d+)?%?/g) || [];
  if (numbers.some((number) => !passage.includes(number))) return null;
  const words = (value) => new Set(value.toLowerCase().match(/[a-z]{4,}/g) || []);
  const asserted = words(finding),
    quoted = words(quote);
  const missing = [...words(claim)].filter((word) => asserted.has(word) && !quoted.has(word));
  if (missing.length || numbers.some((number) => !quote.includes(number))) return passage;
  return quote;
}

export async function verifiedFindings(ai, plan, ranked) {
  const evidence = [];
  let proposed = 0;
  async function reviewBatch(batch) {
    const result = await ai.analyze({
      claim: plan.claim,
      questions: plan.questions.map((text, index) => ({ index, text })),
      passages: batch.map((p, index) => ({ index, publication: p.title, text: p.content })),
    });
    proposed += result.findings.length;
    const candidates = result.findings.flatMap((f) => {
      if (!batch[f.chunk] || !plan.questions[f.question]) return [];
      const quote = citationText(batch[f.chunk].content, f.finding, f.quote.trim(), plan.claim);
      return quote ? [{ ...f, quote }] : [];
    });
    if (!candidates.length) return;
    const { accepted } = await ai.verify({
      claim: plan.claim,
      candidates: candidates.map((f, index) => ({
        index,
        quote: f.quote,
        finding: f.finding,
        stance: f.stance,
      })),
    });
    for (const k of new Set(accepted)) {
      const f = candidates[k];
      if (!f) continue;
      const p = batch[f.chunk];
      const id = createHash('sha256')
        .update(p.source_id + f.quote)
        .digest('hex')
        .slice(0, 24);
      if (evidence.some((e) => e.id === id)) continue;
      evidence.push({
        id,
        sourceId: p.source_id,
        title: f.finding,
        finding: f.finding,
        stance: f.stance,
        passage: { text: f.quote, location: p.location },
        chunkId: p.id,
        question: plan.questions[f.question],
        explanation: f.reason,
        limitations: [f.limitation],
        reviewed: false,
        aiVerified: true,
      });
    }
  }
  for (let i = 0; i < ranked.length; i += 5)
    await reviewBatch(ranked.slice(i, i + 5));
  // A dense multi-passage prompt can miss a direct result. Give the most
  // relevant passages individual attention, while keeping the same quote
  // matching and independent citation review gates.
  if (!evidence.length)
    for (const passage of ranked.slice(0, 3))
      await reviewBatch([passage]);
  return { evidence, proposed };
}

export async function rankChunks(db, jobId, archive, queryVectors, queries, limit = 10) {
  const scores = new Map();
  for (const [i, query] of queries.entries()) {
    const result = await db.query(
      `WITH ranked AS (SELECT id,row_number() OVER(ORDER BY embedding <=> $2::vector,id) AS semantic,
      row_number() OVER(ORDER BY ts_rank_cd(to_tsvector('english',content),to_tsquery('english', nullif(array_to_string(tsvector_to_array(to_tsvector('english',$3)), ' | '),''))) DESC,id) AS lexical
      FROM chunks WHERE job=$1 AND id <= $4) SELECT id,(1.0/(30+semantic)+1.0/(30+lexical)) AS score FROM ranked ORDER BY score DESC LIMIT 12`,
      [jobId, JSON.stringify(queryVectors[i]), query, archive.length],
    );
    for (const row of result.rows) scores.set(row.id, (scores.get(row.id) || 0) + Number(row.score));
  }
  const perSource = new Map();
  return [...scores]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => archive[id - 1])
    .filter((p) => {
      const n = perSource.get(p.source_id) || 0;
      perSource.set(p.source_id, n + 1);
      return n < 3;
    })
    .slice(0, limit);
}

export function rankTextChunks(archive, queries, limit = 14) {
  const terms = [...new Set(queries.join(' ').toLowerCase().match(/[a-z]{4,}/g) || [])]
    .filter((word) => !['does', 'what', 'with', 'from', 'than', 'this', 'that', 'were', 'have', 'compared'].includes(word));
  const perSource = new Map();
  return [...archive]
    .map((passage) => {
      const content = passage.content.toLowerCase();
      const title = passage.title.toLowerCase();
      return { passage, score: terms.reduce((score, word) => score + (content.includes(word) ? 1 : 0) + (title.includes(word) ? 0.35 : 0), 0) };
    })
    .sort((a, b) => b.score - a.score || a.passage.id - b.passage.id)
    .map(({ passage }) => passage)
    .filter((passage) => {
      const seen = perSource.get(passage.source_id) || 0;
      perSource.set(passage.source_id, seen + 1);
      return seen < 3;
    })
    .slice(0, limit);
}

export async function rerankChunks(ai, plan, candidates, warnings) {
  if (candidates.length <= 1) return { passages: candidates, method: 'hybrid' };
  const byId = new Map(candidates.map((passage) => [passage.id, passage]));
  try {
    const { ordered } = await ai.rerank({
      claim: plan.claim,
      questions: plan.questions,
      candidates: candidates.map(({ id, title, location, content }) => ({ id, title, location, text: content.slice(0, 850) })),
    });
    const ids = [...new Set(ordered.filter((id) => byId.has(id)))];
    if (ids.length) {
      const passages = [...ids.map((id) => byId.get(id)), ...candidates.filter(({ id }) => !ids.includes(id))];
      return { passages: passages.slice(0, 10), method: 'model' };
    }
  } catch {
    // Hybrid ranking is still available after a reranking request fails.
  }
  warnings.push('Model reranking was unavailable. Passages use hybrid search order.');
  return { passages: candidates.slice(0, 10), method: 'hybrid-fallback' };
}

async function collectDocuments(plan, uploads, env) {
  const warnings = uploads.flatMap((u) => (u.warning ? [u.warning] : []));
  let sources = [];
  if (plan.searchOnline) {
    try {
      const result = await discover(plan.query, env);
      sources = result.sources;
      warnings.push(...result.warnings);
    } catch (e) {
      if (!uploads.length) throw e;
      warnings.push(e.message);
    }
  }

  const material = new Map();
  for (const upload of uploads) {
    if (material.has(upload.source.id)) continue;
    sources.push(upload.source);
    material.set(upload.source.id, upload.passages);
  }
  await Promise.all(
    sources
      .filter((s) => !material.has(s.id))
      .map(async (s) => {
        let paragraphs = [];
        try {
          paragraphs = await fullText(s);
        } catch {
          /* The indexed abstract can still be used. */
        }
        if (paragraphs.length) s.access = 'full';
        material.set(s.id, [
          ...(s.abstract ? [{ text: s.abstract, location: 'Indexed abstract' }] : []),
          ...paragraphs,
        ]);
      }),
  );
  return { sources, warnings, passages: [...material] };
}

export async function pipeline({ db, jobId, plan, uploads, env, stage, ai = aiClient(env) }) {
  const started = Date.now();
  await stage('searching', 'Discovering scholarly sources');
  const {
    rows: [checkpoint],
  } = await db.query('SELECT documents FROM research_inputs WHERE run=$1', [jobId]);
  const documents = checkpoint?.documents || (await collectDocuments(plan, uploads, env));
  if (!checkpoint)
    await db.query('INSERT INTO research_inputs VALUES($1,$2) ON CONFLICT DO NOTHING', [
      jobId,
      documents,
    ]);
  const { sources, warnings } = documents;
  const material = new Map(documents.passages);
  await stage('reading', 'Extracting and indexing source passages');
  const rows = sources.flatMap((s) =>
    chunksFor(material.get(s.id) || []).map((p) => ({ ...p, source: s })),
  );
  // Round-robin source coverage before applying the run's embedding budget.
  const groups = sources.map((s) => rows.filter((row) => row.source.id === s.id));
  const selected = [];
  const passageLimit = ai.provider === 'Gemini' ? 80 : 160;
  for (let i = 0; selected.length < passageLimit && groups.some((g) => i < g.length); i++)
    for (const group of groups) if (group[i] && selected.length < passageLimit) selected.push(group[i]);
  if (rows.length > selected.length)
    warnings.push('Passage indexing capped at ' + passageLimit + ' chunks across the retrieved sources.');
  const metadata = sources.filter((s) => s.access === 'metadata').length;
  if (metadata) warnings.push(metadata + ' publications provided metadata only.');
  const archive = selected.map((p, i) => ({
    id: i + 1,
    source_id: p.source.id,
    title: p.source.title,
    location: p.location,
    content: p.text,
  }));
  let candidates = [];
  if (archive.length) {
    let vectors;
    try {
      vectors = await ai.embed([...archive.map((p) => p.content), plan.claim, ...plan.questions]);
    } catch (error) {
      if (!/Embedding request failed \(HTTP (?:429|503)\)/.test(error.message)) throw error;
      warnings.push('Embedding quota or capacity was unavailable. Passages were ranked by text and then model relevance.');
    }
    for (const row of archive)
      await db.query(
        'INSERT INTO chunks(job,id,source_id,title,location,content,embedding) VALUES($1,$2,$3,$4,$5,$6,$7::vector) ON CONFLICT(job,id) DO UPDATE SET source_id=excluded.source_id,title=excluded.title,location=excluded.location,content=excluded.content,embedding=excluded.embedding',
        [
          jobId,
          row.id,
          row.source_id,
          row.title,
          row.location,
          row.content,
          vectors ? JSON.stringify(vectors[row.id - 1]) : null,
        ],
      );
    candidates = vectors ? await rankChunks(db, jobId, archive, vectors.slice(archive.length), [
      plan.claim, ...plan.questions,
    ], 14) : rankTextChunks(archive, [plan.claim, ...plan.questions]);
  }
  if (candidates.length > 1) await stage('reading', 'Reranking retrieved passages');
  const { passages: ranked, method: ranking } = await rerankChunks(ai, plan, candidates, warnings);
  await stage('reading', 'Classifying findings and checking citations');
  const { evidence, proposed } = await verifiedFindings(ai, plan, ranked);
  if (!evidence.length)
    warnings.push('No finding passed passage matching and citation review. The report abstains.');
  const summary = [];
  if (!evidence.length)
    summary.push({ text: `${archive.length} passages were indexed and ${ranked.length} were reviewed, but no proposed finding passed citation review. The available material does not establish the claim.` });
  if (evidence.length) {
    await stage('reading', 'Writing and verifying the cited report');
    const draft = await ai.synthesize({
      claim: plan.claim,
      findings: evidence.map((e, index) => ({
        index,
        finding: e.finding,
        stance: e.stance,
        limitation: e.limitations,
      })),
    });
    const anchored = draft.statements.filter((s) => {
      const quote = evidence[s.index]?.passage.text;
      return quote && citationText(quote, s.text, quote, plan.claim);
    });
    if (anchored.length) {
      const checked = await ai.verify({
        claim: plan.claim,
        candidates: anchored.map((s, index) => ({
          index,
          finding: s.text,
          quote: evidence[s.index].passage.text,
          stance: evidence[s.index].stance,
        })),
      });
      for (const i of new Set(checked.accepted))
        if (anchored[i])
          summary.push({ text: anchored[i].text, evidenceId: evidence[anchored[i].index].id });
    }
    if (!summary.length)
      warnings.push('The synopsis did not pass citation review. Verified findings are shown directly.');
  }
  return {
    sources,
    evidence,
    summary,
    warnings,
    analysis: {
      model: ai.model,
      provider: ai.provider,
      embeddingModel: ai.embeddingModel,
      indexed: archive.length,
      candidates: candidates.length,
      ranking,
      retrieved: ranked.map((p) => p.id),
      proposed,
      verified: evidence.length,
      elapsedMs: Date.now() - started,
      ...ai.metrics,
      version: 'hybrid-rag-2',
      query: plan.query,
    },
  };
}
