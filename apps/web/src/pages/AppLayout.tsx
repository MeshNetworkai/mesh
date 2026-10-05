import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { Empty } from '../components/ui';
import { useAuth } from '../lib/auth';
import { pad2, shortAddr } from '../lib/format';
import { useEpochCountdown, useStats } from '../lib/hooks';

export function NextEpochPill({ epochSeconds }: { epochSeconds?: number }) {
  const { remaining } = useEpochCountdown(epochSeconds);
  const m = Math.floor(remaining / 60);
  const s = Math.floor(remaining % 60);
  const h = Math.floor(m / 60);
  const text = h > 0 ? `${h}:${pad2(m % 60)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
  return (
    <span className="pill">
      <span className="dot dot-live" aria-hidden="true" />
      Next epoch in <span className="num">{text}</span>
    </span>
  );
}

export function AppLayout() {
  const { session, openModal, signOut } = useAuth();
  const { data: stats } = useStats(60_000);
  const loc = useLocation();
  // Network stats and the node explainer are readable without a wallet; their wallet-specific parts handle it.
  const publicRoute = loc.pathname.startsWith('/app/stats') || loc.pathname.startsWith('/app/node');
  const cls = ({ isActive }: { isActive: boolean }) => (isActive ? 'on' : '');

  return (
    <div className="wrap tight">
      <div className="app">
        <div className="row between">
          <nav className="subnav" aria-label="App sections">
            <NavLink to="/app" end className={cls}>
              Overview
            </NavLink>
            <NavLink to="/app/keys" className={cls}>
              Keys
            </NavLink>
            <NavLink to="/app/chat" className={cls}>
              Chat
            </NavLink>
            <NavLink to="/app/stats" className={cls}>
              Network
            </NavLink>
            <NavLink to="/app/node" className={cls}>
              Node
            </NavLink>
            <NavLink to="/app/stake" className={cls}>
              Stake
            </NavLink>
          </nav>
          <div className="row">
            <NextEpochPill epochSeconds={stats?.epochSeconds} />
            {session ? (
              <>
                <span className="pill mono" title={session.wallet}>
                  {shortAddr(session.wallet, 5, 4)}
                </span>
                <button className="btn ghost sm" onClick={signOut}>
                  Sign out
                </button>
              </>
            ) : null}
          </div>
        </div>
        {session || publicRoute ? (
          <Outlet />
        ) : (
          <Empty
            title="Connect a wallet to see your credits"
            action={
              <button className="btn primary" onClick={openModal}>
                Connect wallet
              </button>
            }
          >
            Signing a message proves you hold the wallet. No transaction, no fee.
          </Empty>
        )}
      </div>
    </div>
  );
}
