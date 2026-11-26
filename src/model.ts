export const stanceLabels = {
  supports: 'Supporting',
  contradicts: 'Contradictory',
  inconclusive: 'Inconclusive',
} as const;

export type Stance = keyof typeof stanceLabels;
export type Access = 'abstract' | 'metadata' | 'full';
export type Status = 'queued' | 'searching' | 'reading' | 'complete' | 'failed';

export interface Source {
  id: string;
  title: string;
  shortTitle?: string;
  authors: string[];
  year?: number;
  venue?: string;
  type?: string;
  doi?: string;
  url?: string;
  abstract?: string;
  access: Access;
  provider: string;
  discoveredBy?: string[];
}

export interface Passage {
  text: string;
  location: string;
}

export interface Evidence {
  id: string;
  sourceId: string;
  stance: Stance;
  title: string;
  finding: string;
  passage: Passage;
  question: string;
  explanation: string;
  limitations: string[];
  reviewed: boolean;
  chunkId?: number;
  aiVerified?: boolean;
  originalAI?: {stance:Stance;finding:string};
  citationJudgment?: 'grounded' | 'unsupported';
}

export interface Plan {
  planId?: string;
  scope?: Record<string,string>;
  planner?: string;
  claim: string;
  query: string;
  questions: string[];
  searchOnline: boolean;
  attachments: string[];
}

export interface Session extends Plan {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: Status;
  sources: Source[];
  evidence: Evidence[];
  warnings: string[];
  example?: boolean;
  serverManaged?: boolean;
  summary?: Statement[];
  detail?: string;
  analysis?: {
    model: string;
    provider: string;
    embeddingModel: string;
    indexed: number;
    candidates?: number;
    ranking?: 'hybrid' | 'model' | 'hybrid-fallback';
    retrieved: number[];
    verified: number;
    proposed: number;
    elapsedMs: number;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    thinkingTokens?: number;
    embeddingCalls?: number;
    embeddingTokens?: number;
    cost?: { estimatedUsd: number | null; unpricedCalls: number };
  };
  error?: string;
}

export interface Statement {
  text: string;
  evidenceId?: string;
}

export const accessLabels: Record<Access, string> = {
  abstract: 'Abstract only',
  metadata: 'Metadata only',
  full: 'Full text',
};

const stopWords = new Set(
  'a an and are as at be been by can compared could did do does effect for from had has have how in into is it of on or should than that the their they this to using was were what when where whether which who will with would'.split(' '),
);

function terms(text: string) {
  return [...new Set(text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}.+#-]*/gu) ?? [])]
    .map((word) => word.replace(/[.-]+$/, ''))
    .filter((word) => word.length >= 2 && !stopWords.has(word));
}

function score(text: string, queryTerms: string[]) {
  const words = new Set(terms(text));
  return queryTerms.filter((word) => words.has(word)).length;
}

export function createPlan(claim: string): Plan {
  const topic = claim.trim().replace(/[?.!]+$/, '');
  const comparison = topic.match(/^(?:does|do|did|can|will|would) (.+?) (increase|improve|reduce|decrease|affect|change|prevent) (.+?)(?: (?:compared (?:with|to)|versus|vs\.?) (.+))?$/i);
  const questions = comparison
    ? [
      'What empirical findings link ' + comparison[1] + ' to ' + comparison[3] + '?',
      'How do studies define and measure ' + comparison[3] + '?',
      comparison[4]
        ? 'How do study populations and methods compare for ' + comparison[1] + ' and ' + comparison[4] + '?'
        : 'Which study populations and conditions limit how broadly the findings apply?',
    ]
    : [
      'What empirical findings directly address this claim?',
      'How do the studies measure the outcomes in question?',
      'What conflicting findings or limitations affect the available evidence?',
    ];

  return { claim: claim.trim(), query: terms(topic).slice(0, 14).join(' ').slice(0, 240) || topic, questions, searchOnline: true, attachments: [] };
}

function candidateExcerpts(passage: Passage): Passage[] {
  const segments = [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(passage.text)];
  return segments.flatMap(({ segment, index }) => {
    const sentence = segment.trim();
    if (sentence.length < 35) return [];
    if (sentence.length <= 420) return [{ location: passage.location, text: sentence }];
    const cutoff = sentence.lastIndexOf(' ', 370);
    return [{ location: passage.location, text: cutoff > 0 ? sentence.slice(0, cutoff) : passage.text.slice(index, index + 370) }];
  });
}

export function extractEvidence(source: Source, passages: Passage[], plan: Plan): Evidence[] {
  const queryTerms = terms(plan.query || plan.claim);
  const candidates = passages.flatMap(candidateExcerpts)
    .map((passage) => ({ passage, score: score(passage.text, queryTerms) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score);
  const selected = candidates.filter((candidate, index) =>
    candidates.findIndex((other) => other.passage.text === candidate.passage.text) === index);

  return selected.slice(0, source.access === 'full' ? 3 : 1).map(({ passage }, index) => {
    const question = [...plan.questions].sort((a, b) => score(passage.text, terms(b)) - score(passage.text, terms(a)))[0] ?? plan.claim;
    return {
      id: source.id + '-' + (index + 1),
      sourceId: source.id,
      stance: 'inconclusive',
      title: source.shortTitle ?? source.title,
      finding: passage.text,
      passage,
      question,
      explanation: 'This passage shares terms with the research plan. Review the study design and context before assigning a stance.',
      limitations: source.access === 'abstract' ? ['Only the indexed abstract was available for review.'] : ['Text extracted from the uploaded PDF may have layout or transcription artifacts.'],
      reviewed: false,
    };
  });
}

export function getOpenQuestions(session: Session) {
  return session.questions.filter((question) => !session.evidence.some((evidence) =>
    evidence.question === question && (evidence.reviewed || evidence.aiVerified) && evidence.stance !== 'inconclusive'));
}

export function getAssessment(session: Session) {
  if (session.example) return 'Mixed evidence';
  const reviewed = session.evidence.filter((item) => item.reviewed || item.aiVerified);
  if (reviewed.some((item) => item.stance === 'supports') && reviewed.some((item) => item.stance === 'contradicts')) return 'Mixed evidence';
  if (reviewed.some((item) => item.stance === 'supports')) return 'Some support';
  if (reviewed.some((item) => item.stance === 'contradicts')) return 'Some contradiction';
  return 'Insufficient evidence';
}

export function getSummary(session: Session): Statement[] {
  if(session.summary?.length) return session.summary;
  if (session.example) {
    return [
      { text: 'TypeScript can catch a subset of JavaScript bugs before release.', evidenceId: 'demo-detection' },
      { text: 'A GitHub study found no significant improvement in bug proneness or resolution time for TypeScript projects.', evidenceId: 'demo-repositories' },
      { text: 'Taken together, the studies leave the effect on real-world defect rates uncertain.' },
    ];
  }
  const reviewed = session.evidence.filter((item) => item.reviewed || item.aiVerified);
  if (reviewed.length) {
    return [
      { text: 'The report reflects the passages reviewed in this investigation. The scope of each finding depends on its study design and source access.' },
      ...reviewed.map((item) => ({ text: item.finding, evidenceId: item.id })),
    ];
  }
  if (session.evidence.length) {
    return [{ text: 'The search surfaced candidate passages for review. There is insufficient reviewed evidence to assess the claim.' }];
  }
  if (session.analysis?.indexed) {
    const incomplete = session.warnings.some((warning) => warning.includes('was unavailable'));
    return [{ text: `${session.analysis.indexed} source passages were indexed and ${session.analysis.retrieved?.length ?? 0} were reviewed, but no finding passed citation review.${incomplete ? ' A scholarly search provider was unavailable, so coverage is incomplete.' : ' The available passages do not establish the claim.'}` }];
  }
  return [{ text: 'No usable source passages were retrieved. There is insufficient evidence to assess the claim.' }];
}

export function makeMarkdown(session: Session) {
  const sourceIndex = (id: string) => session.sources.findIndex((source) => source.id === id) + 1;
  const summary = getSummary(session).map(({ text, evidenceId }) => {
    const evidence = session.evidence.find((item) => item.id === evidenceId);
    return evidence ? text + ' [' + sourceIndex(evidence.sourceId) + ']' : text;
  });
  const evidence = session.evidence.map((item) => [
    '### ' + item.title,
    stanceLabels[item.stance] + (item.reviewed ? ' · Reviewed' : item.aiVerified ? ' · AI citation checked' : ' · Awaiting review'),
    item.finding,
    '> ' + item.passage.text.replace(/\n/g, '\n> '),
    'Source [' + sourceIndex(item.sourceId) + '], ' + item.passage.location,
    'Research question — ' + item.question,
    item.explanation,
    ...item.limitations.map((limitation) => '- ' + limitation),
  ].join('\n\n'));
  const sources = session.sources.map((source, index) => {
    const title = source.url ? '[' + source.title + '](' + source.url + ')' : source.title;
    return (index + 1) + '. ' + title + ' · ' + [source.authors.join(', '), source.year, source.venue, accessLabels[source.access]].filter(Boolean).join(' · ');
  });

  return [
    '# ' + session.claim,
    ...(session.example ? ['Example investigation'] : []),
    '## Research summary',
    '**' + getAssessment(session) + '**',
    summary.join(' '),
    '## Evidence explorer',
    ...evidence,
    '## Open questions',
    getOpenQuestions(session).map((question) => '- ' + question).join('\n') || 'All research questions have a reviewed directional passage.',
    '## Sources',
    sources.join('\n'),
    ...(session.analysis ? ['## AI run',session.analysis.provider + ' · ' + session.analysis.model + ' · Embeddings: ' + session.analysis.embeddingModel] : []),
    '## Research plan',
    'Search query — ' + session.query,
    ...session.questions.map((question) => '- ' + question),
    ...(session.warnings.length ? ['## Coverage notes', ...session.warnings.map((warning) => '- ' + warning)] : []),
  ].join('\n\n') + '\n';
}
