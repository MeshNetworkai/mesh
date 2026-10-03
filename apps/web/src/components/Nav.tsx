import { NavLink, Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useBeta, useMe, usePointsEnabled } from '../lib/hooks';
import { fmtUsd } from '../lib/format';

function BalancePill() {
  const { data, loading } = useMe(60_000);
  return (
    <Link to="/app" className="pill balance" aria-label="Your credits">
      Credits <b>{loading && !data ? '…' : fmtUsd(data?.balance.usd ?? 0, 3)}</b>
    </Link>
  );
}

/** "Beta" marker shown while config.beta.enabled (from GET /stats). Renders nothing until the gateway confirms it. */
export function BetaPill({ className = '' }: { className?: string }) {
  const beta = useBeta();
  if (!beta?.enabled) return null;
  return (
    <span className={`pill beta ${className}`.trim()} title={beta.inviteRequired ? 'Public beta: invite required to sign in' : 'Public beta'}>
      {beta.label}
    </span>
  );
}

export function TopNav() {
  const { session, openModal } = useAuth();
  const pointsEnabled = usePointsEnabled();
  const cls = ({ isActive }: { isActive: boolean }) => `navlink${isActive ? ' on' : ''}`;
  return (
    <nav className="topnav" aria-label="Primary">
      <Link to="/" className="logo">
        <span className="nodes" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
          <i />
        </span>
        Mesh
        <BetaPill />
      </Link>
      <NavLink to="/" end className={cls}>
        Home
      </NavLink>
      <NavLink to="/app" end className={cls}>
        App
      </NavLink>
      <NavLink to="/app/stats" className={cls}>
        Stats
      </NavLink>
      <NavLink to="/report" className={cls}>
        Report
      </NavLink>
      {pointsEnabled ? (
        <NavLink to="/leaderboard" className={cls}>
          Ranks
        </NavLink>
      ) : null}
      <NavLink to="/docs" className={cls}>
        Docs
      </NavLink>
      <NavLink to="/download" className={cls}>
        Download
      </NavLink>
      {session ? (
        <BalancePill />
      ) : (
        <button className="btn primary sm" style={{ marginLeft: 8 }} onClick={openModal}>
          Connect wallet
        </button>
      )}
    </nav>
  );
}
