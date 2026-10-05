import { Link } from 'react-router-dom';
import { PUBLIC_API_URL, TOKENOMICS } from '../config';
import { usePointsEnabled, useTheme } from '../lib/hooks';

/** Social links come from the build environment (VITE_SOCIAL_X, VITE_SOCIAL_TELEGRAM); unset = not shown. No placeholders on a live site. */
const SOCIAL: Array<{ label: string; href: string }> = [
  { label: 'X', href: (import.meta.env.VITE_SOCIAL_X as string | undefined) ?? '' },
  { label: 'Telegram', href: (import.meta.env.VITE_SOCIAL_TELEGRAM as string | undefined) ?? '' },
].filter((s) => /^https?:\/\//.test(s.href));

const COLUMNS: Array<{ title: string; links: Array<{ label: string; to?: string; href?: string; points?: boolean }> }> = [
  {
    title: 'Product',
    links: [
      { label: 'App', to: '/app' },
      { label: 'Chat', to: '/app/chat' },
      { label: 'Credit market', to: '/app/market' },
      { label: 'API keys', to: '/app/keys' },
      { label: 'Run a node', to: '/app/node' },
      { label: 'Download for Mac', to: '/download' },
    ],
  },
  {
    title: 'Stats',
    links: [
      { label: 'Live network', to: '/stats#live' },
      { label: 'Epochs', to: '/stats#epochs' },
      { label: 'Weekly report', to: '/stats#report' },
      { label: 'Treasury and market', to: '/stats#treasury' },
      { label: 'Roadmap', to: '/docs#roadmap' },
      { label: 'Leaderboard', to: '/leaderboard', points: true }, // hidden while the points programme is disabled
      { label: 'Health', href: `${PUBLIC_API_URL}/health` },
    ],
  },
  {
    title: 'Build',
    links: [
      { label: 'Docs', to: '/docs' },
      { label: 'Switch in a minute', to: '/api#switch' },
      { label: 'API reference', to: '/api' },
      { label: 'openapi.json', href: `${PUBLIC_API_URL}/openapi.json` },
    ],
  },
  {
    title: 'Legal',
    links: [
      { label: 'Terms', to: '/terms' },
      { label: 'Privacy', to: '/privacy' },
      { label: 'Risk', to: '/risk' },
    ],
  },
];

export function Footer() {
  const [theme, setTheme] = useTheme();
  const pointsEnabled = usePointsEnabled();
  const next = theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark';
  return (
    <footer className="site">
      <div className="site-cols">
        <div className="site-brand">
          <Link to="/" className="logo" aria-label={`${TOKENOMICS.name} home`}>
            <span className="nodes" aria-hidden="true">
              <i />
              <i />
              <i />
              <i />
              <i />
            </span>
            {TOKENOMICS.name}
          </Link>
          <p>Two engines, one hourly pool: trading fees today, a share of paid usage when it is switched on. Answered by Macs, frontier models at list, credits sold on when unused, every dollar on the record.</p>
          <div className="row" style={{ gap: 12 }}>
            {SOCIAL.map((s) => (
              <a key={s.label} href={s.href} rel="noreferrer noopener" target="_blank">
                {s.label}
              </a>
            ))}
          </div>
        </div>
        {COLUMNS.map((c) => (
          <div className="site-col" key={c.title}>
            <span className="eyebrow">{c.title}</span>
            {c.links.filter((l) => !l.points || pointsEnabled).map((l) =>
              l.to ? (
                <Link key={l.label} to={l.to}>
                  {l.label}
                </Link>
              ) : (
                <a key={l.label} href={l.href}>
                  {l.label}
                </a>
              ),
            )}
          </div>
        ))}
      </div>
      <div className="site-base">
        <span>
          {TOKENOMICS.name} · ${TOKENOMICS.ticker} · open beta · credits are a share of fees, not a promise
        </span>
        <span>
          {TOKENOMICS.geoBlock.length ? <>Not available to residents of {TOKENOMICS.geoBlock.join(', ')} ·{' '}</> : null}
          <button className="linkbtn" onClick={() => setTheme(next)} aria-label={`Theme: ${theme}. Switch to ${next}`}>
            Theme: {theme}
          </button>
        </span>
      </div>
    </footer>
  );
}
