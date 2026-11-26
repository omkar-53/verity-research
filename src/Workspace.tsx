import { useRef, useState } from 'react';
import {
  BookOpen, CheckCircle2, ChevronRight, CircleHelp, ClipboardList, FileText, FlaskConical, FolderOpen,
  Layers3, LoaderCircle, Search, ShieldCheck, TriangleAlert, UploadCloud, X,
} from 'lucide-react';
import { api } from './research';
import type { Plan, Session } from './model';
import { formatDate, StatusPill } from './ui';

const prompts = [
  'Does continuous integration reduce build failures?',
  'Does pair programming improve code quality?',
  'Does remote work improve developer productivity?',
];

const fileLimit = 5;
const byteLimit = 15 * 1024 * 1024;

export function NewInvestigation({ initial, launch }: {
  initial?: Session;
  launch: (plan: Plan, files: File[], existing?: string) => Promise<void>;
}) {
  const [claim, setClaim] = useState(initial?.claim ?? '');
  const [plan, setPlan] = useState<Plan | undefined>(initial && { ...initial, attachments: [] });
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState('');
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  function addFiles(selected: File[]) {
    const accepted = [...files];
    let warning = '';
    for (const file of selected) {
      if (accepted.some((existing) => existing.name === file.name && existing.size === file.size && existing.lastModified === file.lastModified)) continue;
      if (!/\.pdf$/i.test(file.name) || file.size > byteLimit || file.size === 0) {
        warning = 'Choose non-empty PDF files up to 15 MB each.';
        continue;
      }
      if (accepted.length === fileLimit) {
        warning = 'You can attach up to five PDFs per investigation.';
        break;
      }
      accepted.push(file);
    }
    setFiles(accepted);
    setError(warning);
  }

  const [busy,setBusy]=useState(false);
  async function prepare(event: React.FormEvent) {
    event.preventDefault();
    if (claim.trim().length < 12 || !/[\p{L}\p{N}]/u.test(claim)) {
      setError('Enter a research claim of at least 12 characters.');
      return;
    }
    setBusy(true);setError('');
    try {setPlan(await api<Plan>('plan','POST',{claim:claim.trim()}));}
    catch(e){setError((e as Error).message);}
    finally{setBusy(false);}
  }

  async function submitPlan(event: React.FormEvent) {
    event.preventDefault();
    if (!plan) return;
    const questions = plan.questions.map((question) => question.trim());
    if (!questions.length || questions.some((question) => question.length < 5)) {
      setError('Enter at least one research question. Use five or more characters per question.');
      return;
    }
    if (new Set(questions.map((question) => question.toLowerCase())).size !== questions.length) {
      setError('Each research question must be distinct.');
      return;
    }
    if (plan.searchOnline && plan.query.trim().length < 3) {
      setError('Enter at least three characters of search terms.');
      return;
    }
    if (!plan.searchOnline && !files.length) {
      setError('Attach a PDF or enable scholarly search.');
      return;
    }
    setBusy(true);setError('');
    try {await launch({ ...plan,claim: plan.claim, query: plan.query.trim(), questions, searchOnline: plan.searchOnline, attachments: files.map((file) => file.name) }, files, initial?.id);}
    catch(e){setError((e as Error).message);}
    finally{setBusy(false);}
  }

  return <div className="standard-page compose-page">
    <header className="page-intro">
      <span className="page-symbol"><FlaskConical size={25} strokeWidth={1.75} /></span>
      <h1>{initial ? 'Edit research plan' : 'New investigation'}</h1>
      <p>Let AI investigate a claim and trace each finding to its source.</p>
    </header>
    <div className="stepper" aria-label="Research setup">
      <span className={plan ? 'done' : 'current'}>{plan ? <CheckCircle2 size={17} /> : <ClipboardList size={17} />} Research claim</span><ChevronRight size={15} /><span className={plan ? 'current' : ''}><Layers3 size={17} /> Research plan</span>
    </div>
    {!plan ? <form className="surface form-card" onSubmit={prepare}>
      <label htmlFor="claim">What claim would you like to investigate?</label>
      <textarea id="claim" disabled={busy} ref={textarea} autoFocus value={claim} maxLength={500}
        onChange={(event) => { setClaim(event.target.value); setError(''); }}
        placeholder="Does TypeScript reduce software defects compared with JavaScript?" rows={4} />
      <div className="claim-helper"><span>Use a specific claim or a question grounded in evidence.</span><span>{claim.length}/500</span></div>
      {error && <p className="form-error" role="alert"><TriangleAlert size={16} />{error}</p>}
      <div className="form-actions"><button className="button primary" type="submit" disabled={busy}>{busy ? 'AI is planning…' : 'Review research plan'}</button></div>
      <div className="prompt-list" aria-label="Suggested claims">
        <strong>Try a research question</strong>
        {prompts.map((prompt) => <button type="button" disabled={busy} key={prompt} onClick={() => { setClaim(prompt); setError(''); textarea.current?.focus(); }}>{prompt}</button>)}
      </div>
    </form> : <form className="surface form-card" onSubmit={submitPlan}>
      <div className="plan-heading"><div><span className="eyebrow">Research claim</span><h2>{plan.claim}</h2></div><button className="text-button" type="button" onClick={() => { setPlan(undefined); setError(''); }}>Edit claim</button></div>
      <div className="plan-fields">
        {plan.scope && <details className="form-section"><summary>How the AI interpreted your claim</summary><dl className="source-facts">{Object.entries(plan.scope).map(([key,value])=><div key={key}><dt>{key==='claimType'?'Claim type':key}</dt><dd>{value}</dd></div>)}</dl></details>}
        <div className="form-section">
          <h3>Research questions</h3><p>Refine the questions used to organize the passages.</p>
          {plan.questions.map((question, index) => <div className="question-field" key={index}>
            <input aria-label={'Research question ' + (index + 1)} value={question} maxLength={300}
              onChange={(event) => setPlan({ ...plan, questions: plan.questions.map((value, position) => position === index ? event.target.value : value) })} />
            <button className="icon-button" type="button" aria-label={'Remove research question ' + (index + 1)} disabled={plan.questions.length === 1}
              onClick={() => setPlan({ ...plan, questions: plan.questions.filter((_, position) => position !== index) })}><X size={17} /></button>
          </div>)}
          <button className="text-button" type="button" disabled={plan.questions.length === 8} onClick={() => setPlan({ ...plan, questions: [...plan.questions, ''] })}>Add a question</button>
        </div>
        <div className="form-section">
          <label className="check-label"><input type="checkbox" checked={plan.searchOnline} onChange={(event) => setPlan({ ...plan, searchOnline: event.target.checked })} />Search scholarly sources</label>
          <p>Search OpenAlex and Crossref, plus Google Scholar when SerpApi is configured.</p>
          <input aria-label="Scholarly search terms" disabled={!plan.searchOnline} maxLength={240} value={plan.query}
            onChange={(event) => setPlan({ ...plan, query: event.target.value })} />
        </div>
        <div className="form-section">
          <h3>Attach documents <span className="optional">Optional</span></h3><p>Extracted PDF text is sent to your research server for model analysis. Add up to five PDFs, 15 MB per file.</p>
          <input ref={fileInput} className="visually-hidden" type="file" accept=".pdf,application/pdf" multiple tabIndex={-1} aria-label="Attach PDF documents"
            onChange={(event) => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
          <button className="upload-button" type="button" onClick={() => fileInput.current?.click()}
            onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); addFiles(Array.from(event.dataTransfer.files)); }}><UploadCloud size={21} /> Choose PDFs or drop them here</button>
          {files.length > 0 && <ul className="attached-files">{files.map((file, index) => <li key={file.name + index}><FileText size={17} /><span>{file.name}</span><button type="button" className="icon-button" aria-label={'Remove ' + file.name} onClick={() => setFiles(files.filter((_, position) => position !== index))}><X size={16} /></button></li>)}</ul>}
        </div>
      </div>
      {error && <p className="form-error" role="alert"><TriangleAlert size={16} />{error}</p>}
      <div className="form-actions"><button disabled={busy} className="button primary">{busy ? 'Preparing documents…' : 'Run investigation'}</button></div>
    </form>}
  </div>;
}

export function Library({ sessions, open, create }: {
  sessions: Session[];
  open: (session: Session) => void;
  create: () => void;
}) {
  const [query, setQuery] = useState('');
  const matches = sessions.filter((session) => session.claim.toLowerCase().includes(query.toLowerCase().trim()));

  return <div className="standard-page">
    <header className="page-intro"><span className="page-symbol"><FolderOpen size={25} strokeWidth={1.75} /></span><h1>Research library</h1><p>Reopen investigations in your research workspace.</p></header>
    <div className="library-tools"><label className="search-input"><Search size={18} /><input aria-label="Search investigations" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search investigations" /></label><button className="button primary" onClick={create}>New investigation</button></div>
    <div className="surface library-list">
      {matches.map((session) => <button className="library-row" key={session.id} onClick={() => open(session)}>
        <span className="library-glyph"><FileText size={21} strokeWidth={1.7} /></span><span className="library-title"><strong>{session.claim}</strong><span>
          {session.example ? 'Example report' : formatDate(session.updatedAt)} · {session.sources.length} {session.sources.length === 1 ? 'source' : 'sources'}</span></span>
        <StatusPill status={session.status} /><ChevronRight size={17} className="row-chevron" />
      </button>)}
      {!matches.length && <div className="empty-state"><FolderOpen size={26} /><h3>No matching investigations</h3><p>Try a different search term.</p></div>}
    </div>
  </div>;
}

export function Methodology({ openExample }: { openExample: () => void }) {
  const methods = [
    { icon: Search, title: 'Discover publications', text: 'Verity searches OpenAlex and Crossref and can also search Google Scholar via SerpApi. It combines duplicate publication records before retrieving evidence.' },
    { icon: BookOpen, title: 'Check source access', text: 'A source can contain metadata, an indexed abstract, or full text from a local PDF. Access labels indicate what material informed the investigation.' },
    { icon: Layers3, title: 'Review candidate passages', text: 'The worker combines embedding similarity with text search, then asks the model to classify relevant passages. A second model call checks each proposed finding and stance against its exact quote.' },
    { icon: ShieldCheck, title: 'Trace the report to its sources', text: 'Citation markers open the passage, its location, and the publication details. An investigation can report insufficient evidence when the available passages leave the claim unresolved.' },
  ];
  return <div className="standard-page">
    <header className="page-intro"><span className="page-symbol"><CircleHelp size={25} strokeWidth={1.75} /></span><h1>Methodology</h1><p>How Verity finds passages and records their relationship to a claim.</p></header>
    <div className="method-grid">{methods.map(({ icon: Icon, title, text }) => <section key={title} className="surface method-card"><span className="stat-glyph violet"><Icon size={22} /></span><h2>{title}</h2><p>{text}</p></section>)}</div>
    <button className="button secondary" onClick={openExample}>Open example report</button>
  </div>;
}

export function RunStatus({ session, retry, edit, stop }: {
  session: Session;
  retry: () => void;
  edit: () => void;
  stop: () => void;
}) {
  const failed = session.status === 'failed';
  const stages = [
    { title: 'Prepare research plan', detail: session.questions.length + ' research questions', icon: ClipboardList },
    { title: 'Search scholarly sources', detail: session.searchOnline ? session.query : 'Using the attached PDFs', icon: Search },
    { title: 'Extract candidate passages', detail: 'Collect original text and source locations', icon: FileText },
  ];
  const active = session.status === 'queued' ? 0 : session.status === 'searching' ? 1 : 2;
  return <div className="standard-page">
    <header className="page-intro"><span className="page-symbol">{failed ? <TriangleAlert size={25} /> : <FlaskConical size={25} />}</span><h1>{failed ? 'Investigation interrupted' : 'Running investigation'}</h1><p>{session.claim}</p></header>
    {failed ? <div className="surface form-card">
      <p className="form-error" role="alert"><TriangleAlert size={18} />{session.error ?? 'The investigation could not finish.'}</p>
      <div className="form-actions"><button className="button secondary" onClick={edit}>Edit research plan</button><button className="button primary" onClick={retry}>Retry investigation</button></div>
    </div> : <div className="surface form-card progress-card" role="status">
      <StatusPill status={session.status} /><p aria-live="polite">{session.detail}</p>
      <ol>{stages.map(({ title, detail, icon: Icon }, index) => <li key={title} className={index === active ? 'running' : ''}>
        <span className="progress-icon">{index < active ? <CheckCircle2 size={20} /> : index === active ? <LoaderCircle size={20} className="spin" /> : <Icon size={20} />}</span>
        <div><strong>{title}</strong><span>{detail}</span></div>
      </li>)}</ol>
      <div className="form-actions"><button className="button secondary" onClick={stop}>Stop investigation</button></div>
    </div>}
  </div>;
}
