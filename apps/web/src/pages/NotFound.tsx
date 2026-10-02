import { Link, useLocation } from 'react-router-dom';

/** Catch-all route. Same hero pattern as the landing, one line of context, the ways back. */
export function NotFound() {
  const { pathname } = useLocation();
  return (
    <div className="wrap tight notfound">
      <section className="hero" style={{ paddingBlock: '64px 0' }}>
        <p className="eyebrow">404</p>
        <h1 className="display d-xl">
          Nothing
          <br />
          served here.
        </h1>
        <p className="lede" style={{ textAlign: 'center' }}>
          There is no page at <code className="mono">{pathname}</code>. <span className="dim">No request was made, nothing was charged.</span>
        </p>
        <div className="chips">
          <Link className="chip" to="/">
            Home
          </Link>
          <Link className="chip" to="/docs">
            Docs
          </Link>
          <Link className="chip" to="/api">
            API
          </Link>
          <Link className="chip" to="/app">
            App
          </Link>
          <Link className="chip" to="/report">
            Report
          </Link>
        </div>
        <Link className="btn primary" to="/">
          Back to the start
        </Link>
      </section>
    </div>
  );
}
