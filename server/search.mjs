import { createHash } from 'node:crypto';
import he from 'he';

const openAlexFields = [
  'id', 'ids', 'doi', 'title', 'publication_year', 'authorships', 'primary_location',
  'abstract_inverted_index', 'type',
].join(',');
const scholarProvider = 'Google Scholar';

function abstractFromIndex(index) {
  const words = [];
  for (const [word, positions] of Object.entries(index ?? {})) {
    for (const position of positions) {
      if (Number.isInteger(position) && position >= 0 && position < 3000) words[position] = word;
    }
  }
  return words.filter(Boolean).join(' ').slice(0, 6500);
}

function plainText(value) {
  return typeof value === 'string'
    ? he.decode(value.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
    : '';
}

function validLink(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function normalizeDoi(doi) {
  return doi?.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').toLowerCase();
}

async function searchFetch(url, options = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(12_000) });
      if (response.ok || ![429, 500, 502, 503, 504].includes(response.status) || attempt === 2)
        return response;
    } catch (error) {
      if (attempt === 2) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** attempt));
  }
}

async function openAlexWorks(params, env) {
  const url = new URL('https://api.openalex.org/works');
  url.search = new URLSearchParams({ ...params, 'per-page': '12', select: openAlexFields });
  const headers = env.OPENALEX_API_KEY ? { Authorization: 'Bearer ' + env.OPENALEX_API_KEY } : {};
  const response = await searchFetch(url, { headers });
  if (!response.ok) throw new Error('OpenAlex returned ' + response.status);
  const data = await response.json();
  return data.results.map((work) => ({
    key: work.id,
    pmcid: work.ids?.pmcid?.match(/PMC[0-9]+/)?.[0],
    title: work.title,
    authors: (work.authorships ?? []).slice(0, 12).map(({ author }) => author.display_name).filter(Boolean),
    year: work.publication_year,
    venue: work.primary_location?.source?.display_name,
    type: work.type,
    doi: normalizeDoi(work.doi),
    url: validLink(work.primary_location?.landing_page_url) ?? validLink(work.doi) ?? validLink(work.id),
    abstract: abstractFromIndex(work.abstract_inverted_index),
    provider: 'OpenAlex',
  }));
}

export function openAlex(query, env) {
  return openAlexWorks({ search: query }, env);
}

function lookupOpenAlexDois(dois, env) {
  return openAlexWorks({ filter: 'doi:' + dois.join('|') }, env);
}

export async function crossref(query, env) {
  const url = new URL('https://api.crossref.org/works');
  url.search = new URLSearchParams({
    'query.bibliographic': query,
    rows: '12',
    filter: 'type:journal-article,type:proceedings-article,type:posted-content',
    select: 'DOI,title,abstract,author,published,container-title,type',
  });
  if (env.CROSSREF_MAILTO) url.searchParams.set('mailto', env.CROSSREF_MAILTO);
  const response = await searchFetch(url);
  if (!response.ok) throw new Error('Crossref returned ' + response.status);
  const data = await response.json();
  return data.message.items.map((work) => ({
    key: work.DOI,
    title: plainText(work.title?.[0]),
    authors: (work.author ?? []).slice(0, 12).map((author) => [author.given, author.family].filter(Boolean).join(' ')).filter(Boolean),
    year: work.published?.['date-parts']?.[0]?.[0],
    venue: plainText(work['container-title']?.[0]),
    type: work.type,
    doi: normalizeDoi(work.DOI),
    url: validLink('https://doi.org/' + work.DOI),
    abstract: plainText(work.abstract).slice(0, 6500),
    provider: 'Crossref',
  }));
}

function fingerprint(title) {
  return title.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '');
}

export function arxivIdFromLink(link) {
  return link?.match(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf|html)\/(\d{4}\.\d{4,5})(?:v\d+)?(?:\.pdf)?(?:[/?#]|$)/i)?.[1];
}

function scholarWork(result) {
  const title = plainText(result?.title);
  if (!title) return [];
  const links = [result.link, ...(result.resources ?? []).map((resource) => resource?.link)]
    .map(validLink).filter(Boolean);
  const doi = links.map((link) => {
    const { hostname, pathname } = new URL(link);
    const pattern = /^(?:dx\.)?doi\.org$/.test(hostname)
      ? /^\/(10\.\d{4,9}\/[\w.:;()/+-]+)$/i
      : /^\/doi\/(?:abs\/|full\/|pdf\/)?(10\.\d{4,9}\/[\w.:;()/+-]+)$/i;
    return pathname.match(pattern)?.[1]?.toLowerCase();
  }).find(Boolean);
  const arxivId = links.map(arxivIdFromLink).find(Boolean);
  const pmcid = links.map((link) =>
    link.match(/^https?:\/\/(?:pmc\.ncbi\.nlm\.nih\.gov\/articles|www\.ncbi\.nlm\.nih\.gov\/pmc\/articles|europepmc\.org\/article\/PMC)\/(PMC\d+)(?:[/?#]|$)/i)?.[1]?.toUpperCase(),
  ).find(Boolean);
  const [byline, publication] = plainText(result.publication_info?.summary).split(' - ');
  const year = publication?.match(/\b(?:18|19|20)\d{2}$/)?.[0];
  const authors = byline ? byline.split(',').map((part) => part.trim()).filter(Boolean)
    : (result.publication_info?.authors ?? []).map((author) => plainText(author.name)).filter(Boolean);
  return [{
    key: 'scholar:' + (result.result_id || links[0] || title),
    title,
    authors: authors.slice(0, 12),
    year: year ? Number(year) : undefined,
    doi,
    arxivId,
    pmcid,
    url: links[0],
    provider: scholarProvider,
  }];
}

export async function googleScholar(query, env) {
  const url = new URL('https://serpapi.com/search.json');
  url.search = new URLSearchParams({
    engine: 'google_scholar',
    q: query,
    api_key: env.SERPAPI_API_KEY.trim(),
  });
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: 'error' });
  if (!response.ok) throw new Error('Google Scholar via SerpApi returned HTTP ' + response.status);
  const data = await response.json();
  if (data.search_metadata?.status !== 'Success') throw new Error('Google Scholar search failed.');
  // Scholar reports some successful but empty searches with an "error" field.
  return (data.organic_results ?? []).slice(0, 10).flatMap(scholarWork);
}

export function mergeSources(groups) {
  const sources = [];
  for (const group of groups) {
    for (const work of group) {
      if (!work.title || !work.key) continue;
      const title = fingerprint(work.title);
      const duplicate = sources.find((source) => work.doi && source.doi === work.doi)
        ?? sources.find((source) => (!source.doi || !work.doi) && fingerprint(source.title) === title);
      if (duplicate) {
        duplicate.doi ||= work.doi;
        duplicate.url ||= work.url;
        duplicate.venue ||= work.venue;
        duplicate.pmcid ||= work.pmcid;
        duplicate.arxivId ||= work.arxivId;
        if (!duplicate.authors?.length) duplicate.authors = work.authors;
        duplicate.year ??= work.year;
        if (!duplicate.discoveredBy.includes(work.provider)) duplicate.discoveredBy.push(work.provider);
        if (!duplicate.abstract && work.abstract) {
          duplicate.abstract = work.abstract;
          duplicate.access = 'abstract';
          duplicate.provider = work.provider;
        }
        continue;
      }
      sources.push({
        ...work,
        discoveredBy: [work.provider],
        id: createHash('sha256').update(work.doi ?? work.key).digest('hex').slice(0, 18),
        access: work.abstract ? 'abstract' : 'metadata',
      });
    }
  }
  const additionalScholarWorks = sources.slice(16)
    .filter((source) => source.discoveredBy.includes(scholarProvider)).slice(0, 6);
  return [...sources.slice(0, 16), ...additionalScholarWorks].map(({ key, ...source }) => source);
}

const searchProviders = { openAlex, crossref, googleScholar, lookupOpenAlexDois };

export async function discover(query, env, providers = searchProviders) {
  const searches = [['OpenAlex', providers.openAlex], ['Crossref', providers.crossref]];
  if (env.SERPAPI_API_KEY?.trim()) searches.push([scholarProvider, providers.googleScholar]);
  const results = await Promise.allSettled(searches.map(([, search]) => search(query, env)));
  if (results.every((result) => result.status === 'rejected')) {
    throw Object.assign(new Error('Scholarly search is temporarily unavailable. Try again in a moment.'), { status: 502 });
  }
  const warnings = results.flatMap((result, index) => result.status === 'rejected'
    ? [searches[index][0] + ' was unavailable.'] : []);
  const groups = results.map((result) => result.status === 'fulfilled' ? result.value : []);
  const sources = mergeSources(groups);
  const dois = [...new Set(sources.filter((source) =>
    source.access === 'metadata' && source.doi && source.discoveredBy.includes(scholarProvider),
  ).map((source) => source.doi))];
  if (!dois.length) return { sources, warnings };

  try {
    const works = await providers.lookupOpenAlexDois(dois, env);
    // Add only exact DOI matches and retain the position of each Scholar result.
    const allowedDois = new Set(dois);
    return { sources: mergeSources([...groups, works.filter((work) => allowedDois.has(work.doi))]), warnings };
  } catch {
    warnings.push('OpenAlex could not look up abstracts for some Google Scholar records.');
    return { sources, warnings };
  }
}

export function createResearchHandler(env = process.env, providers = searchProviders) {
  return async (req, res) => {
    const send = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(payload));
    };
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return send(405, { error: 'Use POST to search for sources.' });
    }
    if (!req.headers['content-type']?.startsWith('application/json')) {
      return send(415, { error: 'Send the research query as JSON.' });
    }
    let query;
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk.toString();
        if (body.length > 4096) return send(413, { error: 'The research query is too long.' });
      }
      query = JSON.parse(body)?.query?.trim();
    } catch {
      return send(400, { error: 'Enter a valid research query.' });
    }
    if (typeof query !== 'string' || query.length < 3 || query.length > 240) {
      return send(400, { error: 'Search terms must be between 3 and 240 characters.' });
    }

    try {
      return send(200, await discover(query, env, providers));
    } catch (error) {
      if (error.status !== 502) throw error;
      return send(502, { error: error.message });
    }
  };
}
