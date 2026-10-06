import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { NavLink, Link, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useBeta, useMe, usePointsEnabled } from '../lib/hooks';
import { fmtUsd } from '../lib/format';

const ACCOUNT_LINKS: Array<{ to: string; label: string }> = [
  { to: '/app', label: 'Overview' },
  { to: '/app/keys', label: 'Keys' },
  { to: '/app/node', label: 'Node' },
  { to: '/app/stake', label: 'Stake' },
  { to: '/app/market', label: 'Market' },
];

/**
 * Signed in: the balance pill is a menu button. The menu lists the app sections and Sign out; it closes on
 * Escape, on an outside click/tap, on route change, and arrow keys move between the items (WAI-ARIA menu button).
 */
function BalanceMenu() {
  const { data, loading } = useMe(60_000);
  const { signOut } = useAuth();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  // Route change closes it (also covers the item links themselves).
  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const items = () => Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
  const focusItem = (i: number) => {
    const list = items();
    if (!list.length) return;
    list[((i % list.length) + list.length) % list.length].focus();
  };
  useEffect(() => {
    if (open) focusItem(0);
  }, [open]);

  const onButtonKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setOpen(true);
      if (e.key === 'ArrowUp') window.setTimeout(() => focusItem(-1), 0);
    }
  };
  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusItem(i + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusItem(i - 1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      focusItem(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      focusItem(-1);
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <div className="navmenu" ref={rootRef}>
      <button
        ref={btnRef}
        type="button"
        className={`pill balance${open ? ' open' : ''}`}
        aria-label="Your credits"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onButtonKey}
      >
        Credits <b>{loading && !data ? '…' : fmtUsd(data?.balance.usd ?? 0, 3)}</b>
        <span className="chat-pill-caret" aria-hidden="true" />
      </button>
      {open ? (
        <div className="navmenu-list" role="menu" id={menuId} ref={menuRef} aria-label="Account" onKeyDown={onMenuKey}>
          {ACCOUNT_LINKS.map((l) => (
            <Link key={l.to} to={l.to} role="menuitem" className="navmenu-item" tabIndex={-1} aria-current={pathname === l.to ? 'page' : undefined}>
              {l.label}
            </Link>
          ))}
          <span className="navmenu-sep" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="navmenu-item"
            tabIndex={-1}
            onClick={() => {
              setOpen(false);
              signOut();
            }}
          >
            Sign out
          </button>
        </div>
      ) : null}
    </div>
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
      <div className="navlinks">
      <NavLink to="/app/chat" className={cls}>
        Chat
      </NavLink>
      <NavLink to="/app/market" className={cls}>
        Market
      </NavLink>
      <NavLink to="/app/node" className={cls}>
        Run a node
      </NavLink>
      <NavLink to="/stats" className={cls}>
        Stats
      </NavLink>
      <NavLink to="/launchpad" className={cls}>
        Launchpad
      </NavLink>
      {pointsEnabled ? (
        <NavLink to="/leaderboard" className={cls}>
          Ranks
        </NavLink>
      ) : null}
      <NavLink to="/docs" className={cls}>
        Docs
      </NavLink>
      </div>
      <div className="navright">
        {session ? (
          <BalanceMenu />
        ) : (
          <button className="btn primary sm" onClick={openModal}>
            Connect wallet
          </button>
        )}
      </div>
    </nav>
  );
}
