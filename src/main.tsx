import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Aperture, BookOpen, ChevronRight, CircleHelp, Download, FileText, FlaskConical, FolderOpen, Menu, Plus, X,
} from 'lucide-react';
import { example } from './example';
import { makeMarkdown } from './model';
import type { Evidence, Plan, Session } from './model';
import { Report } from './Report';
import { api, submitResearch } from './research';
import { Account } from './Account';
import { Evaluation } from './Evaluation';
import { Library, Methodology, NewInvestigation, RunStatus } from './Workspace';
import { Dialog } from './ui';
import './styles.css';

const storageKey = 'verity-investigations-v1';
type Route = { page: 'report' | 'edit'; id: string } | { page: 'new' | 'library' | 'methodology' | 'evaluation' };

function getRoute(): Route {
  const [page, id] = window.location.hash.slice(1).split('/');
  if ((page === 'report' || page === 'edit') && id) return { page, id };
  if (page === 'new' || page === 'library' || page === 'methodology' || page === 'evaluation') return { page };
  return { page: 'new' };
}

function loadSessions(): Session[] {
  try {
    const result = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
    if (!Array.isArray(result)) return [];
    return result.filter((session): session is Session =>
      session && typeof session.id === 'string' && typeof session.claim === 'string' &&
      typeof session.updatedAt === 'string' && typeof session.createdAt === 'string' &&
      Array.isArray(session.questions) && Array.isArray(session.sources) && Array.isArray(session.evidence) &&
      Array.isArray(session.warnings) && Array.isArray(session.attachments)
    ).map((session) => !['complete', 'failed'].includes(session.status)
      ? { ...session, status: 'failed', error: 'The browser closed or reloaded while this investigation ran. Retry to resume.' }
      : session);
  } catch {
    return [];
  }
}

function App() {
  const [route, setRoute] = useState<Route>(getRoute);
  const [legacy,setLegacy]=useState(loadSessions);
  const [remote,setRemote]=useState<Session[]>([]);
  const [account,setAccount]=useState<{email:string|null}>();
  const [accountOpen,setAccountOpen]=useState(false);
  const [notice,setNotice]=useState('');
  const [reconnecting,setReconnecting]=useState(false);
  const sessions=[...remote,...(account?.email ? [] : legacy)];
  const [loaded,setLoaded]=useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [storageError, setStorageError] = useState(false);
  useEffect(()=>{
    let active=true;
    let timer:ReturnType<typeof setTimeout>;
    async function refresh(){
      try {
        const user=await api<{email:string|null}>('account');
        const records=await api<Session[]>('research');
        if(!active)return;
        setAccount(user);setRemote(records);setLoaded(true);setReconnecting(false);
        timer=setTimeout(refresh,records.some(s=>!['complete','failed'].includes(s.status))?1500:6000);
      } catch { if(active){setReconnecting(true);timer=setTimeout(refresh,5000);} }
    }
    void refresh();
    return ()=>{active=false;clearTimeout(timer);};
  },[]);
  useEffect(() => {
    const onHashChange = () => {
      setRoute(getRoute());
      setMobileNav(false);
      setExportOpen(false);
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(legacy));
      setStorageError(false);
    } catch {
      setStorageError(true);
    }
  }, [legacy]);

  const ordered = [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const allSessions = [...ordered, example];
  const session = 'id' in route ? allSessions.find((item) => item.id === route.id) : undefined;
  const reportSession = route.page === 'report' && session?.status === 'complete' ? session : undefined;
  const lastReport = ordered.find((item) => item.status === 'complete') ?? example;
  const reportLink = '#report/' + (route.page === 'report' && session ? session.id : lastReport.id);
  const pageLabel = { report: 'Research report', new: 'New investigation', edit: 'Research plan', library: 'Research library', methodology: 'Methodology', evaluation: 'Evaluation' }[route.page];

  useEffect(() => {
    document.title = (session ? session.claim : pageLabel) + ' — Verity';
  }, [pageLabel, session]);

  const navigate = (hash: string) => {
    window.location.hash = hash;
    setMobileNav(false);
  };

  function upsert(record:Session){
    setRemote(previous=>[record,...previous.filter(item=>item.id!==record.id)]);
  }

  async function run(plan: Plan, files: File[]) {
    const record=await submitResearch(plan,files);
    upsert(record);
    navigate('#report/'+record.id);
  }
  async function action(item:Session,name:string) {
    try {upsert(await api<Session>('research/'+item.id+'/'+name,'POST',{}));}
    catch(e){setNotice((e as Error).message);}
  }
  function retry(item:Session){
    if(item.serverManaged) void action(item,'retry'); else navigate('#edit/'+item.id);
  }

  async function review(item:Evidence){
    if(!session||session.example)return;
    if(session.serverManaged){
      try{upsert(await api<Session>('research/'+session.id+'/evidence/'+item.id,'PATCH',item));}
      catch(e){setNotice((e as Error).message);}
    }else setLegacy(previous=>previous.map(s=>s.id===session.id?{...s,evidence:s.evidence.map(e=>e.id===item.id?item:e)}:s));
  }

  function download(format: 'md' | 'json') {
    if (!reportSession) return;
    const data = format === 'md' ? makeMarkdown(reportSession) : JSON.stringify(reportSession, null, 2) + '\n';
    const file = new Blob([data], { type: format === 'md' ? 'text/markdown' : 'application/json' });
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    const slug = reportSession.claim.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 65) || 'report';
    link.href = url;
    link.download = 'verity-' + slug + '.' + format;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setExportOpen(false);
  }

  return <div className="app-shell">
    <a className="skip-link" href="#main-content" onClick={(event) => {
      event.preventDefault();
      document.getElementById('main-content')?.focus();
    }}>Skip to report</a>
    {mobileNav && <button className="mobile-overlay" aria-label="Close workspace menu" onClick={() => setMobileNav(false)} />}
    <aside id="workspace-sidebar" className={'sidebar' + (mobileNav ? ' shown' : '')}>
      <a className="brand" href={reportLink} onClick={() => setMobileNav(false)} aria-label="Verity workspace">
        <span className="brand-mark"><Aperture size={23} strokeWidth={1.85} /></span><span><strong>Verity</strong><small>RESEARCH WORKSPACE</small></span>
      </a>
      <div className="sidebar-content">
        <button className="button primary new-button" onClick={() => navigate('#new')}><Plus size={19} /> New investigation</button>
        <nav className="sidebar-nav" aria-label="Workspace">
          <h2>Workspace</h2>
          <a href={reportLink} onClick={() => setMobileNav(false)} aria-current={route.page === 'report' ? 'page' : undefined}><FlaskConical size={19} />Report viewer</a>
          <a href="#library" onClick={() => setMobileNav(false)} aria-current={route.page === 'library' ? 'page' : undefined}><FolderOpen size={19} />Research library</a>
          <a href="#evaluation" aria-current={route.page==='evaluation'?'page':undefined}><BookOpen size={19}/>Evaluation</a>
          <a href="#methodology" onClick={() => setMobileNav(false)} aria-current={route.page === 'methodology' ? 'page' : undefined}><CircleHelp size={19} />Methodology</a>
        </nav>
        <nav className="sidebar-nav recent-nav" aria-label="Recent investigations">
          <h2>Recent investigations</h2>
          {[...ordered.slice(0, 4), example].map((item) => <a key={item.id} href={'#report/' + item.id}
            onClick={() => setMobileNav(false)} aria-current={route.page === 'report' && session?.id === item.id ? 'page' : undefined}>
            <FileText size={17} /><span><strong>{item.example ? 'TypeScript and defects' : item.claim}</strong>{item.example && <small>Example investigation</small>}</span>
          </a>)}
        </nav>
      </div>
      <button className="sidebar-footer" style={{background:'transparent',borderInline:0,borderBottom:0,textAlign:'left'}} onClick={()=>setAccountOpen(true)}><span className="workspace-avatar"><FlaskConical size={18} /></span><div><strong>Personal workspace</strong><small>{account?.email || 'Guest · sign in or register'}</small></div></button>
    </aside>
    <div className="workspace">
      <header className="topbar">
        <div className="breadcrumb">
          <button className="icon-button mobile-menu" aria-label={mobileNav ? 'Close workspace menu' : 'Open workspace menu'} aria-expanded={mobileNav} aria-controls="workspace-sidebar" onClick={() => setMobileNav((value) => !value)}>{mobileNav ? <X size={23} /> : <Menu size={23} />}</button>
          <a href={reportLink} className="breadcrumb-root">Workspace</a><ChevronRight size={14} className="breadcrumb-separator" /><span>{pageLabel}</span>
        </div>
        {reportSession && <button className="button secondary export-button" onClick={() => setExportOpen(true)}><Download size={17} /> <span>Export report</span></button>}
      </header>
      <main id="main-content" tabIndex={-1}>
        {reconnecting && <p className="storage-warning" role="status">Reconnecting to the research server…</p>}
        {notice && <div className="storage-warning" role="alert">{notice} <button className="text-button" onClick={()=>setNotice('')}>Dismiss</button></div>}
        {route.page==='evaluation' && <Evaluation/>}
        {storageError && <p className="storage-warning" role="alert">Browser storage is unavailable or full. Export this investigation to keep a copy.</p>}
        {route.page === 'report' && session && (session.status === 'complete' ? <Report key={session.id} session={session} onReview={review} />
          : <RunStatus session={session} retry={() => retry(session)} edit={() => navigate('#edit/' + session.id)} stop={() => void action(session,'stop')} />)}
        {(route.page === 'new' || (route.page === 'edit' && session)) && <NewInvestigation key={route.page + (session?.id ?? '')} initial={route.page === 'edit' ? session : undefined} launch={run} />}
        {route.page === 'library' && <Library sessions={allSessions} open={(item) => navigate('#report/' + item.id)} create={() => navigate('#new')} />}
        {route.page === 'methodology' && <Methodology openExample={() => navigate('#report/' + example.id)} />}
        {'id' in route && !session && !loaded && <p className="form-card">Loading workspace…</p>}
        {'id' in route && !session && loaded && <div className="standard-page"><header className="page-intro"><h1>Investigation unavailable</h1><p>This report could not be found in this browser.</p></header><button className="button primary" onClick={() => navigate('#library')}>Open research library</button></div>}
      </main>
    </div>
    {accountOpen && <Account email={account?.email??null} close={()=>setAccountOpen(false)}/>}
    {exportOpen && reportSession && <Dialog title="Export report" variant="modal" close={() => setExportOpen(false)}>
      <div className="export-options">
        <button className="source-row" onClick={() => download('md')}><FileText size={20} /><span className="source-row-text"><strong>Markdown</strong><span>Readable report with citations and source links</span></span><Download size={18} /></button>
        <button className="source-row" onClick={() => download('json')}><BookOpen size={20} /><span className="source-row-text"><strong>JSON</strong><span>Research plan, publication records, and evidence</span></span><Download size={18} /></button>
      </div>
    </Dialog>}
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);
