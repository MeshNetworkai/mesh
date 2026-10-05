import { Link } from 'react-router-dom';
import { PUBLIC_API_URL, TOKENOMICS } from '../config';
import { usePointsEnabled, useTheme } from '../lib/hooks';

/** Social links: placeholders until the accounts exist (docs/BRAND.md lists them). */
const SOCIAL: Array<{ label: string; href: string }> = [
  { label: 'X', href: 'https://x.com/mesh_placeholder' },
  { label: 'Telegram', href: 'https://t.me/mesh_placeholder' },
];

const COLUMNS: Array<{ title: string; links: Array<{ label: string; to?: string; href?: string; points?: boolean }> }> = [
  {
    title: 'Product',
    links: [
      { label: 'App', to: '/app' },
      { label: 'Chat', to: '/app/chat' },
      { label: 'API keys', to: '/app/keys' },
      { label: 'Run a node', to: '/app/node' },
      { label: 'Download for Mac', to: '/download' },
    ],
  },
  {
    title: 'Numbers',
    links: [
      { label: 'Stats', to: '/app/stats' },
      { label: 'Report', to: '/report' },
      { label: 'Leaderboard', to: '/leaderboard', points: true }, // hidden while the points programme is disabled
      { label: 'Epochs', href: `${PUBLIC_API_URL}/epochs` },
      { label: 'Health', href: `${PUBLIC_API_URL}/health` },
    ],
  },
  {
    title: 'Build',
    links: [
      { label: 'Docs', to: '/docs' },
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
          <p>Trading fees become AI credits, every hour. Served by Macs in the Mesh network.</p>
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
          {TOKENOMICS.name} · ${TOKENOMICS.ticker} on {TOKENOMICS.chain} · credits are a share of fees, not a promise
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
