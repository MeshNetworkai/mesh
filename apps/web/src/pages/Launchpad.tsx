import { Link } from 'react-router-dom';
import { TOKENOMICS } from '../config';

const X_URL = (import.meta.env.VITE_SOCIAL_X as string | undefined) ?? '';

/**
 * /launchpad — a holding page until the launchpad ships. One sentence, no promises, no dates; the roadmap
 * row ("Agent launchpad", After launch) is the public source of truth for what it is.
 */
export function LaunchpadPage() {
  return (
    <div className="wrap tight launchpad">
      <section className="hero" style={{ paddingBlock: '72px 48px' }}>
        <p className="eyebrow">Launchpad</p>
        <h1 className="display d-l">
          The next generation Launchpad
          <br />
          is coming soon.
        </h1>
        <p className="lede" style={{ textAlign: 'center' }}>
          Tokens for apps and agents built on the {TOKENOMICS.name} network, paired with ${TOKENOMICS.ticker}. Built on the same gateway, Macs and hourly pool that run today.
        </p>
        <div className="chips">
          <Link className="chip" to="/docs#roadmap-after">
            Roadmap
          </Link>
          <Link className="chip" to="/api">
            Build on the API today
          </Link>
          {X_URL ? (
            <a className="chip" href={X_URL} target="_blank" rel="noreferrer">
              Follow for the date
            </a>
          ) : null}
        </div>
      </section>
    </div>
  );
}
