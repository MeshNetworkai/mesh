import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Notice, Skeleton, Terminal } from '../components/ui';
import { PUBLIC_API_URL, TOKENOMICS } from '../config';
import { fmtCost } from '../lib/format';
import { useAsync, useCopy } from '../lib/hooks';
import { installOneLiner } from './Node';

/**
 * /download: the three ways to run a node on a Mac without an App Store or a Developer ID.
 *   1. Terminal one-liner (install-node.sh; what the Node tab shows)
 *   2. Homebrew tap (brew install meshnetworkai/tap/mesh-node)
 *   3. Menu-bar app DMG, unsigned beta: walkthrough for System Settings > Privacy & Security > Open Anyway
 * Version, URLs and SHA-256 come from /downloads/latest.json: a sample file in apps/web/public in dev,
 * the real document written by the release workflow in production (docs/DISTRIBUTION.md).
 */

export interface LatestRelease {
  version: string;
  publishedAt?: string;
  channel?: string;
  bundleUrl: string;
  bundleSha256: string;
  tarballUrl?: string;
  tarballSha256?: string;
  dmgUrl?: string;
  dmgSha256?: string;
  minMacOS?: string;
  arch?: string;
  notes?: string;
  /** Set only in the placeholder file shipped in apps/web/public. */
  sample?: boolean;
}

export const LATEST_PATH = '/downloads/latest.json';
export const TAP = 'meshnetworkai/tap';
export const BREW_INSTALL = `brew install ${TAP}/mesh-node`;

export async function fetchLatest(path = LATEST_PATH): Promise<LatestRelease> {
  const res = await fetch(path, { headers: { accept: 'application/json' }, cache: 'no-cache' });
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  const j = (await res.json()) as Partial<LatestRelease> & { sha256?: string };
  if (!j.version || !j.bundleUrl) throw new Error('latest.json is missing version or bundleUrl');
  return { ...j, version: j.version.replace(/^v/, ''), bundleUrl: j.bundleUrl, bundleSha256: (j.bundleSha256 ?? j.sha256 ?? '').toLowerCase() };
}

export const brewSteps = (code = '<code>'): string =>
  [`# Homebrew (https://brew.sh) on an Apple Silicon Mac`, BREW_INSTALL, `mesh-node setup --link ${code} --gateway ${PUBLIC_API_URL}`, `mesh-node service install`].join('\n');

export const dmgVerify = (file: string, sha: string): string => `# in Terminal, from ~/Downloads\nshasum -a 256 ${file}\n# expect: ${sha || '<sha256 from this page>'}`;

/** The macOS Gatekeeper walkthrough for an unsigned app. Exported so the e2e test asserts on the same text. */
export const OPEN_ANYWAY_STEPS: Array<[string, string]> = [
  ['Download', 'Get the DMG below and check its SHA-256 against the one shown here (optional, one Terminal line).'],
  ['Install', 'Open the DMG and drag Mesh Node into Applications. Eject the disk image.'],
  ['First open', 'Double-click Mesh Node in Applications. macOS says it “cannot verify that this app is free of malware” (or “Apple could not verify…”) and offers Done or Move to Trash. Click Done.'],
  ['Allow it', 'Open System Settings → Privacy & Security, scroll to the Security section. A line says “Mesh Node was blocked to protect your Mac.” Click Open Anyway, then confirm with Touch ID or your password.'],
  ['Open', 'The app now opens and appears next to the clock. macOS asks once more; choose Open. This happens only the first time.'],
];

function Checksum({ label, sha, loading }: { label: string; sha?: string; loading: boolean }) {
  const [copied, copy] = useCopy();
  return (
    <div className="dl-sha" aria-label={`${label} SHA-256`}>
      <span className="eyebrow">{label} · sha-256</span>
      {loading ? (
        <Skeleton w="100%" h="1.2em" />
      ) : sha ? (
        <span className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
          <code className="mono dl-hash">{sha}</code>
          <button type="button" className="btn ghost sm" onClick={() => copy(sha)} aria-label={`Copy ${label} checksum`}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </span>
      ) : (
        <span className="small muted">not published yet</span>
      )}
    </div>
  );
}

const fileName = (url?: string) => (url ? url.split('/').pop() ?? url : '');

export function DownloadPage() {
  const latest = useAsync(fetchLatest, [], 0);
  const rel = latest.data;
  const loading = latest.loading && !rel;
  const [linkCode, setLinkCode] = useState('');
  const code = linkCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || '<code>';
  const dmgName = fileName(rel?.dmgUrl) || 'MeshNode-<version>-arm64.dmg';
  const version = rel ? `v${rel.version}` : null;

  return (
    <div className="wrap docs download">
      <section className="hero" style={{ paddingBlock: '32px 0' }}>
        <p className="eyebrow">
          Download · macOS
          <span className="pill beta" style={{ marginLeft: 10 }} title="Beta: unsigned builds, Apple Silicon only">
            Beta
          </span>
        </p>
        <h1 className="display d-xl" style={{ fontSize: 'clamp(40px,7vw,88px)' }}>
          Run a node
          <br />
          on your Mac.
        </h1>
        <p className="lede" style={{ textAlign: 'center' }}>
          Three ways to install the same agent. <span className="dim">Pick the one you trust most; they all end with the Mac linked to your wallet and earning {fmtCost(TOKENOMICS.nodeRewardUsdPerMTokens)} per million tokens it serves.</span>
        </p>
        <div className="dl-meta" role="status" aria-live="polite" aria-label="Current release">
          <span className="pill sm">
            <span className={`dot${rel ? ' dot-live' : ''}`} aria-hidden="true" />
            {loading ? <Skeleton w="7ch" /> : rel ? `Latest ${version}` : 'Release info unavailable'}
          </span>
          <span className="pill sm off">Apple Silicon only</span>
          <span className="pill sm off">macOS {rel?.minMacOS ?? '13'}+</span>
          {rel?.publishedAt ? <span className="small muted">published {rel.publishedAt.slice(0, 10)}</span> : null}
          {rel?.sample ? <span className="small muted">· sample data until the first release</span> : null}
        </div>
        {latest.error && !rel ? <Notice kind="warn">Could not read {LATEST_PATH} ({latest.error}). The commands below still work; checksums are shown once a release is published.</Notice> : null}
        <div className="chips">
          <a className="chip" href="#terminal">
            Terminal
          </a>
          <a className="chip" href="#homebrew">
            Homebrew
          </a>
          <a className="chip" href="#app">
            Menu-bar app
          </a>
          <a className="chip" href="#warning">
            Why the warning
          </a>
        </div>
      </section>

      <section aria-label="Before you start">
        <div className="sec-head">
          <p className="eyebrow">Before you start</p>
          <div className="stack sm">
            <h2>
              Get a link code. <span className="muted">Every option needs one.</span>
            </h2>
            <p>
              Open <Link to="/app/node">Run a node</Link> with your wallet connected and click <b>Link a Mac</b>. Your wallet signs once, in the browser, and
              you get an 8-character code valid for 15 minutes. The Mac only ever sees the code; no key touches it. Paste it here and the commands below fill
              in.
            </p>
            <label className="field" style={{ maxWidth: 360 }}>
              <span className="lbl">Link code (optional)</span>
              <input
                className="input mono"
                value={linkCode}
                onChange={(e) => setLinkCode(e.target.value)}
                placeholder="K7QM-2XDA"
                spellCheck={false}
                autoCapitalize="characters"
                aria-label="Link code"
              />
            </label>
          </div>
        </div>
      </section>

      <section id="terminal">
        <div className="sec-head">
          <p className="eyebrow">Option 1</p>
          <div className="stack">
            <h2>
              Terminal, one line. <span className="muted">The default; what the Node tab shows.</span>
            </h2>
            <ol className="nodesteps" aria-label="Terminal install steps">
              <li>
                <span className="n">01</span>
                <span>
                  <b>Open Terminal</b> <span className="muted">(Applications → Utilities). Nothing to download first.</span>
                </span>
              </li>
              <li>
                <span className="n">02</span>
                <span>
                  <b>Paste the command</b>{' '}
                  <span className="muted">
                    and press Return. It checks for Apple Silicon, installs a private Node runtime if needed, downloads <code>mesh-node.js</code>, installs
                    Ollama via Homebrew when missing, pulls the first model and registers the Mac to your wallet.
                  </span>
                </span>
              </li>
              <li>
                <span className="n">03</span>
                <span>
                  <b>Done</b> <span className="muted">when it prints the dashboard line. The node runs in the background and starts at login.</span>
                </span>
              </li>
            </ol>
            <Terminal label="Install the node agent" code={installOneLiner(null, code === '<code>' ? null : code)} wrap />
            <p>
              The script is <code>install-node.sh</code> on this origin (<a href="/install-node.sh">read it first</a>); it installs into <code>~/.mesh</code>{' '}
              only, no sudo. Afterwards: <code>mesh-node status</code>, <code>mesh-node update</code> (checks <code>latest.json</code>, verifies the SHA-256,
              swaps the file, restarts the service), <code>mesh-node service uninstall</code> to remove it.
            </p>
          </div>
        </div>
      </section>

      <section id="homebrew">
        <div className="sec-head">
          <p className="eyebrow">Option 2</p>
          <div className="stack">
            <h2>
              Homebrew. <span className="muted">If brew already manages your Mac.</span>
            </h2>
            <ol className="nodesteps" aria-label="Homebrew install steps">
              <li>
                <span className="n">01</span>
                <span>
                  <b>Install from the tap</b> <span className="muted">— the formula depends on Homebrew’s <code>node</code> and installs the same bundle.</span>
                </span>
              </li>
              <li>
                <span className="n">02</span>
                <span>
                  <b>Link and start</b> <span className="muted">with the two mesh-node commands. Ollama is added by setup if it is missing.</span>
                </span>
              </li>
              <li>
                <span className="n">03</span>
                <span>
                  <b>Upgrade</b> <span className="muted">with <code>brew upgrade mesh-node</code>; the service picks up the new file on its next restart.</span>
                </span>
              </li>
            </ol>
            <Terminal label="Homebrew install" code={brewSteps(code)} />
            <div className="dl-files">
              <div>
                <span className="eyebrow">Tarball</span>
                {rel?.tarballUrl ? (
                  <a className="mono small" href={rel.tarballUrl}>
                    {fileName(rel.tarballUrl)}
                  </a>
                ) : (
                  <span className="small muted">{loading ? <Skeleton w="22ch" /> : 'not published yet'}</span>
                )}
              </div>
              <Checksum label="Tarball" sha={rel?.tarballSha256} loading={loading} />
            </div>
            <p>
              The tap is <code>github.com/{TAP.replace('/tap', '/homebrew-tap')}</code>; the formula pins the release tarball by SHA-256, so brew verifies what it
              downloads. The same tarball can be installed by hand: unpack and run <code>./install.sh</code>.
            </p>
          </div>
        </div>
      </section>

      <section id="app">
        <div className="sec-head">
          <p className="eyebrow">Option 3</p>
          <div className="stack">
            <h2>
              Menu-bar app. <span className="muted">Status next to the clock, no Terminal after the first time.</span>
            </h2>
            <div className="dl-card">
              <div className="dl-card-main">
                <span className="display d-s">Mesh Node for macOS</span>
                <span className="small muted">
                  {loading ? <Skeleton w="30ch" /> : rel ? `${version} · ${rel.arch ?? 'arm64'} · unsigned beta build` : 'No release published yet'}
                </span>
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  {rel?.dmgUrl ? (
                    <a className="btn primary" href={rel.dmgUrl} download>
                      Download {dmgName}
                    </a>
                  ) : (
                    <button className="btn primary" disabled>
                      Download DMG
                    </button>
                  )}
                  <a className="btn ghost" href={LATEST_PATH}>
                    latest.json
                  </a>
                </div>
              </div>
              <Checksum label="DMG" sha={rel?.dmgSha256} loading={loading} />
            </div>
            <Notice kind="warn">
              <b>macOS will warn you.</b> This build is not signed with an Apple Developer ID, so Gatekeeper blocks it on first open. Right-click → Open{' '}
              <em>no longer</em> bypasses this on macOS 15 Sequoia and later; the only way through is System Settings → Privacy &amp; Security → <b>Open Anyway</b>.
              The steps:
            </Notice>
            <ol className="nodesteps" aria-label="Open Anyway walkthrough">
              {OPEN_ANYWAY_STEPS.map(([k, v], i) => (
                <li key={k}>
                  <span className="n">0{i + 1}</span>
                  <span>
                    <b>{k}</b> <span className="muted">{v}</span>
                  </span>
                </li>
              ))}
            </ol>
            <Terminal label="Verify the download" code={dmgVerify(dmgName, rel?.dmgSha256 ?? '')} />
            <p>
              The app shows what <code>mesh-node status</code> shows (counts and earnings, never prompts), can pause and resume, links a Mac with the code,
              and has <b>Check for updates</b>, which reads the same <code>latest.json</code> and brings you back here. It does not update itself and does not
              replace the agent: linking from the app runs the same <code>mesh-node setup</code> and installs the same background service.
            </p>
          </div>
        </div>
      </section>

      <section id="warning">
        <div className="sec-head">
          <p className="eyebrow">Why there’s a warning</p>
          <div className="stack">
            <h2>
              Unsigned beta, on purpose for now. <span className="muted">What that means and what we collect.</span>
            </h2>
            <p>
              Apple only removes the warning for apps signed with a paid Developer ID and notarised by Apple. We are not doing that yet, so the DMG is an
              unsigned beta: macOS cannot tell who built it and says so. Every release is built in public by GitHub Actions from a tagged commit, and the
              SHA-256 on this page (from <code>{LATEST_PATH}</code>) lets you check that the file you have is the file CI produced. If the hashes differ, do
              not open it. The Terminal and Homebrew options have no such warning because they install a script, not an app; they verify the same way
              (Homebrew checks the tarball hash; <code>mesh-node update</code> checks the bundle hash).
            </p>
            <p>
              What a node sends: heartbeats (models, busy, load average), job results (token counts, timings) and its chip and RAM, tied to the node id and
              your reward wallet. What it never sends or stores: prompts or replies beyond the moment they are being served, your IP as part of a job, or
              anything about the person asking. Nothing on this page phones home; the only network call is to <code>{LATEST_PATH}</code> on this origin. Full
              detail: <Link to="/privacy">Privacy</Link> and <code>docs/PRIVACY.md</code>.
            </p>
            <p className="small muted">
              Signed and notarised builds will replace the unsigned ones when the developer account exists; the download link, the checksum and these steps
              stay the same, minus the Open Anyway part. Intel Macs are not supported.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
