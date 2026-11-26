import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { Check, CircleHelp, FileText, Minus, X } from 'lucide-react';
import { accessLabels, stanceLabels } from './model';
import type { Source, Stance, Status } from './model';

export const stanceIcons = { supports: Check, contradicts: Minus, inconclusive: CircleHelp };

export function StancePill({ stance }: { stance: Stance }) {
  const Icon = stanceIcons[stance];
  return <span className={'stance-pill ' + stance}><Icon size={13} strokeWidth={2.4} />{stanceLabels[stance]}</span>;
}

export const statusLabels: Record<Status, string> = {
  queued: 'Queued',
  searching: 'Searching sources',
  reading: 'Reading passages',
  complete: 'Research complete',
  failed: 'Research interrupted',
};

export function StatusPill({ status }: { status: Status }) {
  return <span className={'status-pill ' + status}><span />{statusLabels[status]}</span>;
}

export function formatDate(date: string) {
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(date));
}

export function sourceMeta(source: Source) {
  const author = source.authors.length >= 3 ? source.authors[0] + ' et al.' : source.authors.join(' & ');
  return [author, source.year].filter(Boolean).join(' · ') || source.venue || source.provider;
}

export function SourceGlyph({ source }: { source: Source }) {
  return <span className={'source-glyph ' + source.access} title={accessLabels[source.access]}><FileText size={17} strokeWidth={1.7}/></span>;
}

export function Dialog({ title, label, close, children, variant = 'drawer' }: {
  title: string;
  label?: string;
  close: () => void;
  children: ReactNode;
  variant?: 'drawer' | 'modal';
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return <dialog
    className={variant}
    ref={ref}
    aria-labelledby="dialog-title"
    onCancel={(event) => { event.preventDefault(); close(); }}
    onClick={(event) => { if (event.target === event.currentTarget) close(); }}
  >
    <div className="dialog-inner">
      <header className="dialog-heading">
        <div>{label && <div className="eyebrow">{label}</div>}<h2 id="dialog-title">{title}</h2></div>
        <button className="icon-button" onClick={close} aria-label="Close dialog" autoFocus><X size={20} /></button>
      </header>
      {children}
    </div>
  </dialog>;
}
