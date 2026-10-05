import type { ReactNode } from 'react';
import { useAuth } from '../lib/auth';

/**
 * Full-width "connect first" card for app pages that mean nothing without a wallet. Renders alone:
 * the page behind it must not mount anything else until `useAuth().session` exists. `teaser` is an
 * optional public line under the button (a live number from a public endpoint, for instance).
 */
export function WalletGate({ eyebrow, title, children, teaser, cta = 'Connect wallet' }: { eyebrow: string; title: string; children?: ReactNode; teaser?: ReactNode; cta?: string }) {
  const { openModal } = useAuth();
  return (
    <div className="gate" role="region" aria-label={title}>
      <div className="gate-card">
        <span className="eyebrow">{eyebrow}</span>
        <h1 className="display d-m">{title}</h1>
        {children ? <p className="gate-copy">{children}</p> : null}
        <button type="button" className="btn primary" onClick={openModal}>
          {cta}
        </button>
        {teaser ? <p className="small muted gate-teaser">{teaser}</p> : null}
      </div>
    </div>
  );
}
