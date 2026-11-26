import { useRef, useState } from 'react';
import {
  ArrowUpRight, BookOpen, Boxes, ChevronRight, CircleHelp, FileText, FlaskConical,
  Layers3, List, Quote, Search, ShieldCheck, SlidersHorizontal,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { accessLabels, getAssessment, getOpenQuestions, getSummary, stanceLabels } from './model';
import type { Evidence, Session, Source, Stance } from './model';
import { api } from './research';
import { Dialog, formatDate, SourceGlyph, sourceMeta, StancePill, stanceIcons, StatusPill } from './ui';

type Tab = 'overview' | 'evidence' | 'sources';
type Filter = 'all' | Stance;
type Selection = { type: 'evidence' | 'source'; id: string };

const sections = [
  ['summary', 'Research summary'],
  ['evidence', 'Evidence explorer'],
  ['questions', 'Open questions'],
  ['details', 'Research details'],
] as const;

export function Report({ session, onReview }: {
  session: Session;
  onReview: (item: Evidence) => void;
}) {
  const [tab, setTab] = useState<Tab>('overview');
  const [filter, setFilter] = useState<Filter>('all');
  const [selection, setSelection] = useState<Selection>();
  const [currentSection, setCurrentSection] = useState('summary');
  const [sourceSearch, setSourceSearch] = useState('');
  const [coverage, setCoverage] = useState<'all' | Source['access']>('all');
  const tabIds = useRef<Record<Tab, HTMLButtonElement | null>>({ overview: null, evidence: null, sources: null });
  const openQuestions = getOpenQuestions(session);
  const counts = {
    all: session.evidence.length,
    supports: session.evidence.filter((item) => item.stance === 'supports').length,
    contradicts: session.evidence.filter((item) => item.stance === 'contradicts').length,
    inconclusive: session.evidence.filter((item) => item.stance === 'inconclusive').length,
  };

  function jump(section: string) {
    setCurrentSection(section);
    setTab('overview');
    requestAnimationFrame(() => document.getElementById(section)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }

  const openEvidence = (id: string) => setSelection({ type: 'evidence', id });
  const openSource = (id: string) => setSelection({ type: 'source', id });
  const activeEvidence = selection?.type === 'evidence' ? session.evidence.find((item) => item.id === selection.id) : undefined;
  const activeSource = selection?.type === 'source' ? session.sources.find((item) => item.id === selection.id) : undefined;

  const explorer = (
    <section id="evidence" className="report-section explorer" aria-labelledby="explorer-heading">
      <div className="section-heading">
        <div><h2 id="explorer-heading">Evidence explorer</h2><p>Inspect the passages behind the findings.</p></div>
        <span className="section-icon"><Layers3 size={19} /></span>
      </div>
      <div className="filters" role="group" aria-label="Filter evidence">
        {(['all', 'supports', 'contradicts', 'inconclusive'] as const).map((value) => (
          <button key={value} className={filter === value ? 'active' : ''} aria-pressed={filter === value}
            onClick={() => setFilter(value)}>
            {value !== 'all' && <span className={'filter-dot ' + value} />}
            {value === 'all' ? 'All evidence' : stanceLabels[value]} <span className="filter-count">{counts[value]}</span>
          </button>
        ))}
      </div>
      <div className="evidence-grid">
        {session.evidence.filter((item) => filter === 'all' || filter === item.stance).map((item) => {
          const source = session.sources.find((candidate) => candidate.id === item.sourceId);
          return <button className="evidence-card" key={item.id} onClick={() => openEvidence(item.id)}>
            <div className="evidence-top"><StancePill stance={item.stance} /><ArrowUpRight size={17} className="evidence-arrow" /></div>
            <h3>{item.title}</h3>
            {item.finding !== item.title && <p>{item.finding}</p>}
            <span className="evidence-meta"><FileText size={15} />{source ? sourceMeta(source) : item.passage.location}{!item.reviewed && <span className="review-mark">{item.aiVerified ? 'AI citation checked' : 'Awaiting review'}</span>}</span>
          </button>;
        })}
      </div>
      {counts[filter] === 0 && <div className="empty-state"><Layers3 size={24} /><h3>No {filter === 'all' ? 'verified findings' : stanceLabels[filter].toLowerCase() + ' findings'}</h3><p>{counts.all ? 'Choose another filter to explore related findings.' : session.analysis?.indexed ? `${session.analysis.indexed} passages were retrieved, but none passed citation review.` : 'This investigation did not retrieve usable source passages.'}</p></div>}
    </section>
  );

  return <div className="report-layout">
    <div className="report-primary">
      <section className="report-hero" aria-labelledby="report-title">
        <div className="orbit-art" aria-hidden="true">
          <span className="orbit-line orbit-one" /><span className="orbit-line orbit-two" /><span className="orbit-line orbit-three" />
          <span className="orbit-dot orbit-dot-one" /><span className="orbit-dot orbit-dot-two" /><span className="orbit-dot orbit-dot-three" />
          <div className="orbit-core"><FlaskConical size={32} strokeWidth={1.45} /></div>
        </div>
        <div className="hero-copy">
          <div className="eyebrow"><FlaskConical size={15} strokeWidth={1.9} /> {session.analysis ? 'AI research investigation' : 'Research investigation'}</div>
          <h1 id="report-title">{session.claim}</h1>
          <div className="hero-meta"><StatusPill status={session.status} /><span className="meta-divider" /><span>{session.example ? 'Example report' : formatDate(session.updatedAt)}</span></div>
        </div>
      </section>

      <div className="report-stats" aria-label="Investigation statistics">
        <Stat icon={BookOpen} value={session.sources.length} label="Sources found" tone="violet" />
        <Stat icon={Layers3} value={session.evidence.length} label="Evidence items" tone="blue" />
        <Stat icon={CircleHelp} value={openQuestions.length} label="Open questions" tone="amber" />
      </div>

      <div className="report-tabs" role="tablist" aria-label="Research report sections"
        onKeyDown={(event) => {
          const tabs: Tab[] = ['overview', 'evidence', 'sources'];
          let next: Tab;
          if (event.key === 'ArrowRight') next = tabs[(tabs.indexOf(tab) + 1) % tabs.length];
          else if (event.key === 'ArrowLeft') next = tabs[(tabs.indexOf(tab) + tabs.length - 1) % tabs.length];
          else if (event.key === 'Home') next = tabs[0];
          else if (event.key === 'End') next = tabs[tabs.length - 1];
          else return;
          event.preventDefault();
          setTab(next);
          tabIds.current[next]?.focus();
        }}>
        {(['overview', 'evidence', 'sources'] as const).map((value, index) => {
          const Icon = [FileText, Layers3, BookOpen][index];
          return <button key={value} ref={(element) => { tabIds.current[value] = element; }} role="tab" type="button"
            aria-selected={tab === value} aria-controls="report-tabpanel" tabIndex={tab === value ? 0 : -1}
            className={tab === value ? 'active' : ''} id={'tab-' + value} onClick={() => setTab(value)}>
            <Icon size={17} />{value[0].toUpperCase() + value.slice(1)}
          </button>;
        })}
      </div>

      <div id="report-tabpanel" className="report-tabpanel" role="tabpanel" aria-labelledby={'tab-' + tab}>
        {tab === 'overview' && <>
          <section id="summary" className="summary-card surface" aria-labelledby="summary-heading">
            <div className="summary-title"><span className="summary-icon"><Quote size={19} /></span><h2 id="summary-heading">Research summary</h2><span className="assessment"><span />{getAssessment(session)}</span></div>
            <div className="summary-text">
              {getSummary(session).map(({ text, evidenceId }, index) => {
                const item = session.evidence.find((candidate) => candidate.id === evidenceId);
                const sourceIndex = item ? session.sources.findIndex((source) => source.id === item.sourceId) + 1 : 0;
                return <span key={index}>{text}{item && <button className="citation" aria-label={'Inspect citation ' + sourceIndex + ': ' + item.title} onClick={() => openEvidence(item.id)}>{sourceIndex}</button>}{' '}</span>;
              })}
            </div>
          </section>
          {explorer}
          <section id="questions" className="report-section" aria-labelledby="questions-heading">
            <div className="section-heading"><div><h2 id="questions-heading">Open questions</h2><p>Where the available evidence leaves gaps.</p></div></div>
            <div className="surface questions-list">
              {openQuestions.length ? openQuestions.map((question) => <div key={question}><CircleHelp size={18} /><span>{question}</span></div>)
                : <div><ShieldCheck size={18} /><span>Every question has a reviewed directional passage.</span></div>}
            </div>
          </section>
          <section id="details" className="report-section" aria-labelledby="details-heading">
            <div className="section-heading"><div><h2 id="details-heading">Research details</h2><p>Search terms, scope, and source coverage.</p></div></div>
            <div className="surface details-card">
              {session.analysis && <div><h3>AI analysis</h3><p>{session.analysis.provider} · {session.analysis.model} · {session.analysis.embeddingModel} embeddings</p><p>{session.analysis.indexed} chunks indexed · {session.analysis.retrieved.length} retrieved · {session.analysis.verified} findings passed citation review · {Math.round(session.analysis.elapsedMs/1000)} seconds</p>
                {session.analysis.ranking === 'model' && <p>The model reranked {session.analysis.candidates} hybrid search candidates before evidence review.</p>}</div>}
              <div><h3>Search terms</h3><p>{session.searchOnline ? session.query : 'Uploaded PDFs only'}</p></div>
              <div><h3>Research questions</h3><ul>{session.questions.map((question) => <li key={question}>{question}</li>)}</ul></div>
              <div><h3>Coverage notes</h3><ul>
                {session.example && <li>This example was assembled from three published studies to demonstrate citation inspection.</li>}
                <li>{session.example ? 'Evidence labels describe how each passage relates to the claim.' : session.analysis ? 'AI findings were matched to exact quotes and checked for entailment. Model errors remain possible.' : 'This legacy report used keyword-based retrieval.'}</li>
                <li>Study design and source access limit how broadly a finding can be applied.</li>
                {session.warnings.map((warning) => <li key={warning}>{warning}</li>)}
              </ul></div>
            </div>
          </section>
        </>}
        {tab === 'evidence' && explorer}
        {tab === 'sources' && <section className="report-section" aria-labelledby="sources-heading">
          <div className="section-heading"><div><h2 id="sources-heading">Source library</h2><p>Review publication details and available text.</p></div></div>
          <div className="source-tools">
            <label className="search-input"><Search size={18} /><input aria-label="Search sources" value={sourceSearch} onChange={(event) => setSourceSearch(event.target.value)} placeholder="Search titles or authors" /></label>
            <label className="select-field"><SlidersHorizontal size={16} /><select aria-label="Filter sources by access" value={coverage} onChange={(event) => setCoverage(event.target.value as typeof coverage)}><option value="all">All access levels</option>{Object.entries(accessLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          </div>
          <div className="surface sources-full">
            {session.sources.filter((source) => (coverage === 'all' || source.access === coverage) &&
              (source.title + ' ' + source.authors.join(' ')).toLowerCase().includes(sourceSearch.toLowerCase().trim()))
              .map((source) => <button key={source.id} onClick={() => openSource(source.id)} className="source-row">
                <SourceGlyph source={source} /><span className="source-row-text"><strong>{source.title}</strong><span>{sourceMeta(source)}{source.venue && source.authors.length > 0 ? ' · ' + source.venue : ''}</span></span>
                <span className={'coverage-tag ' + source.access}>{accessLabels[source.access]}</span><ChevronRight size={16} className="row-chevron" />
              </button>)}
            {!session.sources.some((source) => (coverage === 'all' || source.access === coverage) &&
              (source.title + ' ' + source.authors.join(' ')).toLowerCase().includes(sourceSearch.toLowerCase().trim())) &&
              <div className="empty-state"><BookOpen size={24} /><h3>No matching sources</h3><p>{session.sources.length ? 'Try a different title, author, or access level.' : 'This investigation returned no scholarly sources.'}</p></div>}
          </div>
        </section>}
      </div>
    </div>
    <aside className="report-rail" aria-label="Report reference">
      <div className="rail-card surface contents-card">
        <h2><List size={18} /> In this report</h2>
        <nav aria-label="Jump to section">
          {sections.map(([id, label]) => <button key={id} aria-current={tab === 'overview' && currentSection === id ? 'location' : undefined}
            onClick={() => jump(id)}>{label}</button>)}
        </nav>
      </div>
      <div className="rail-card surface balance-card">
        <h2><Boxes size={18} /> Evidence breakdown</h2>
        {counts.all > 0 && <div className="balance-bar" aria-hidden="true">
          {(['supports', 'contradicts', 'inconclusive'] as const).filter((key) => counts[key] > 0)
            .map((key) => <span key={key} className={key} style={{ flex: counts[key] }} />)}
        </div>}
        <div className="balance-list">
          {(['supports', 'contradicts', 'inconclusive'] as const).map((key) => {
            const Icon = stanceIcons[key];
            return <button key={key} onClick={() => { setFilter(key); jump('evidence'); }}>
              <span className={'balance-icon ' + key}><Icon size={14} strokeWidth={2.4} /></span><span>{stanceLabels[key]}</span><strong>{counts[key]}</strong>
            </button>;
          })}
        </div>
      </div>
      <div className="rail-card surface rail-sources">
        <h2><BookOpen size={18} /> Sources <span className="small-count">{session.sources.length}</span></h2>
        <div className="rail-source-list">
          {session.sources.slice(0, 3).map((source) => <button className="rail-source" key={source.id} onClick={() => openSource(source.id)}>
            <SourceGlyph source={source}/><span><strong>{source.shortTitle ?? source.title}</strong><small>{sourceMeta(source)}</small></span><ChevronRight size={15} className="row-chevron" />
          </button>)}
          {session.sources.length === 0 && <p>No sources were returned.</p>}
        </div>
        <button className="all-sources" onClick={() => { setTab('sources'); requestAnimationFrame(() => tabIds.current.sources?.scrollIntoView({ behavior: 'smooth', block: 'center' })); }}>
          View all sources <ChevronRight size={16} />
        </button>
      </div>
      {session.warnings.length > 0 && <div className="coverage-note"><ShieldCheck size={18} /><div><strong>Source coverage</strong><p>{session.warnings[0]}</p><button className="text-button" onClick={() => jump('details')}>Read coverage notes</button></div></div>}
    </aside>
    {activeEvidence && <EvidenceDrawer key={activeEvidence.id} item={activeEvidence}
      source={session.sources.find((source) => source.id === activeEvidence.sourceId)}
      session={session} close={() => setSelection(undefined)} showSource={openSource} onReview={onReview} />}
    {activeSource && <SourceDrawer source={activeSource} evidence={session.evidence.filter((item) => item.sourceId === activeSource.id)}
      close={() => setSelection(undefined)} showEvidence={openEvidence} />}
  </div>;
}

function Stat({ icon: Icon, value, label, tone }: { icon: LucideIcon; value: number; label: string; tone: string }) {
  return <div className="stat"><span className={'stat-glyph ' + tone}><Icon size={21} strokeWidth={1.75} /></span>
    <div><strong>{value}</strong><span>{label}</span></div>
  </div>;
}

function EvidenceDrawer({ item, source, session, close, showSource, onReview }: {
  item: Evidence; source?: Source; session: Session; close: () => void;
  showSource: (id: string) => void; onReview: (item: Evidence) => void;
}) {
  const [citationJudgment,setCitationJudgment]=useState(item.citationJudgment||'');
  const [context,setContext]=useState('');
  const [contextError,setContextError]=useState('');
  const [editing, setEditing] = useState(false);
  const [stance, setStance] = useState(item.stance);
  const [finding, setFinding] = useState(item.reviewed || item.aiVerified ? item.finding : '');
  const [explanation, setExplanation] = useState(item.reviewed || item.aiVerified ? item.explanation : '');
  const [question, setQuestion] = useState(item.question);

  return <Dialog title={item.title} label="Evidence details" close={close}>
    <div className="drawer-body">
      <div className="drawer-status"><StancePill stance={item.stance} />{!item.reviewed && <span className="review-mark">{item.aiVerified ? 'AI citation checked' : 'Awaiting review'}</span>}</div>
      <section><h3>Finding</h3><p>{item.finding}</p></section>
      <section><h3>Original passage</h3><blockquote>{item.passage.text}</blockquote><p className="passage-location"><FileText size={15} />{item.passage.location}</p></section>
      {session.serverManaged && item.chunkId && <section>
        {context ? <><h3>Retrieved context</h3><p>{context}</p></> : <button className="text-button" onClick={async()=>{
          try{const chunk=await api<{content:string}>('research/'+session.id+'/chunks/'+item.chunkId);setContext(chunk.content);setContextError('');}
          catch(e){setContextError((e as Error).message);}
        }}>Read surrounding text</button>}{contextError&&<p role="alert">{contextError}</p>}
      </section>}
      {source && <section><h3>Publication</h3><button className="source-row inline-source" onClick={() => showSource(source.id)}>
        <SourceGlyph source={source} /><span className="source-row-text"><strong>{source.shortTitle ?? source.title}</strong><span>{sourceMeta(source)} · {accessLabels[source.access]}</span></span><ChevronRight size={16} />
      </button></section>}
      <section><h3>Research question</h3><p>{item.question}</p></section>
      <section><h3>Why this label?</h3><p>{item.explanation}</p></section>
      <section><h3>Limitations</h3><ul>{item.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul></section>
      {!session.example && (editing ? <form className="review-form" onSubmit={(event) => {
        event.preventDefault();
        if (finding.trim().length < 8 || explanation.trim().length < 8) return;
        onReview({ ...item, citationJudgment:citationJudgment ? citationJudgment as Evidence['citationJudgment'] : undefined, finding: finding.trim(), explanation: explanation.trim(), reviewed: true, stance, question });
        setEditing(false);
      }}>
        <h3>Review this passage</h3>
        {session.serverManaged && <><p>Original AI finding: {item.originalAI?.finding || item.finding}</p>
          <label>Does the cited passage support the original finding?<select required value={citationJudgment} onChange={e=>setCitationJudgment(e.target.value as Evidence['citationJudgment'] || '')}>
            <option value="">Choose a judgment</option><option value="grounded">Yes, the passage supports it</option><option value="unsupported">No, the finding overreaches</option></select></label></>}
        <label>Stance<select value={stance} onChange={(event) => setStance(event.target.value as Stance)}>
          {Object.entries(stanceLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
        </select></label>
        <label>Research question<select value={question} onChange={(event) => setQuestion(event.target.value)}>
          {session.questions.map((value) => <option key={value}>{value}</option>)}</select></label>
        <label>Finding<textarea required minLength={8} maxLength={800} value={finding} onChange={(event) => setFinding(event.target.value)} placeholder="Summarize what the passage shows" /></label>
        <label>Reason for this stance<textarea required minLength={8} maxLength={800} value={explanation} onChange={(event) => setExplanation(event.target.value)} placeholder="Explain how the passage relates to the claim" /></label>
        <div className="form-actions"><button className="button secondary" type="button" onClick={() => setEditing(false)}>Cancel</button><button className="button primary" disabled={finding.trim().length < 8 || explanation.trim().length < 8}>Save review</button></div>
      </form> : <button className="button primary" onClick={() => setEditing(true)}>{item.reviewed ? 'Edit review' : 'Review passage'}</button>)}
    </div>
  </Dialog>;
}

function SourceDrawer({ source, evidence, close, showEvidence }: {
  source: Source; evidence: Evidence[]; close: () => void; showEvidence: (id: string) => void;
}) {
  return <Dialog title={source.title} label="Source details" close={close}>
    <div className="drawer-body">
      <div className="drawer-status"><span className={'coverage-tag ' + source.access}>{accessLabels[source.access]}</span><span>{source.discoveredBy?.join(' · ') || source.provider}</span></div>
      <dl className="source-facts">
        {source.authors.length > 0 && <><dt>Authors</dt><dd>{source.authors.join(', ')}</dd></>}
        {source.year && <><dt>Published</dt><dd>{source.year}</dd></>}
        {source.venue && <><dt>Venue</dt><dd>{source.venue}</dd></>}
        {source.doi && <><dt>DOI</dt><dd>{source.doi}</dd></>}
      </dl>
      {source.url && <a className="button secondary" href={source.url} target="_blank" rel="noreferrer">Open publication <ArrowUpRight size={17} /></a>}
      {source.abstract && <section><h3>Retrieved abstract</h3><p>{source.abstract}</p></section>}
      {source.access === 'metadata' && <section><h3>Text availability</h3><p>Only bibliographic metadata was available for this source.</p></section>}
      <section><h3>Linked passages · {evidence.length}</h3>
        {evidence.length === 0 && <p>No matching passages were extracted from this source.</p>}
        {evidence.map((item) => <button key={item.id} className="source-row inline-source" onClick={() => showEvidence(item.id)}>
          <span className="source-row-text"><strong>{item.title}</strong><span>{item.passage.location} · {stanceLabels[item.stance]}</span></span><ChevronRight size={16} />
        </button>)}
      </section>
    </div>
  </Dialog>;
}
