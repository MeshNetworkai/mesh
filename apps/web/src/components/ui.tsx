import type { ReactNode } from 'react';
import { useCopy } from '../lib/hooks';

export function Skeleton({ w = '6ch', h, className = '' }: { w?: string; h?: string; className?: string }) {
  return <span className={`skel ${className}`} style={{ width: w, height: h }} aria-hidden="true" />;
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty" role="status">
      <span className="t">{title}</span>
      {children ? <span>{children}</span> : null}
      {action}
    </div>
  );
}

export function Notice({ kind = 'warn', children }: { kind?: 'warn' | 'ok' | 'bad'; children: ReactNode }) {
  return (
    <div className={`notice ${kind === 'warn' ? '' : kind}`} role={kind === 'bad' ? 'alert' : 'note'}>
      {children}
    </div>
  );
}

export function Spinner() {
  return <span className="spin" aria-hidden="true" />;
}

/** Terminal snippet with a copy button. `lines` are rendered verbatim (mono, dark). */
export function Terminal({ code, label, wrap }: { code: string; label?: string; wrap?: boolean }) {
  const [copied, copy] = useCopy();
  return (
    <div className="term-wrap">
      <pre className={`term${wrap ? ' wrap' : ''}`} aria-label={label ?? 'Terminal snippet'}>
        {code.split('\n').map((line, i) => (
          <span key={i}>
            {line.startsWith('#') ? <span className="c">{line}</span> : line}
            {'\n'}
          </span>
        ))}
      </pre>
      <button className="copy" onClick={() => copy(code)} aria-label="Copy snippet">
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

export function Tile({
  label,
  value,
  delta,
  deltaKind,
  loading,
}: {
  label: ReactNode;
  value: ReactNode;
  delta?: ReactNode;
  deltaKind?: 'up' | 'dn' | '';
  loading?: boolean;
}) {
  return (
    <div className="tile">
      <span className="l">{label}</span>
      <span className="n">{loading ? <Skeleton w="5ch" h="0.9em" /> : value}</span>
      <span className={`d ${deltaKind ?? ''}`}>{loading ? <Skeleton w="10ch" h="0.8em" /> : (delta ?? ' ')}</span>
    </div>
  );
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div
      className="scrim"
      onClick={onClose}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
      role="presentation"
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="row between">
          <span className="display d-s">{title}</span>
          <button className="btn ghost sm" onClick={onClose} aria-label="Close">
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
