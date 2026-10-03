# Distributing the Mac node (no Apple developer account, no App Store)

How `mesh-node` and the menu-bar app reach a Mac, how a release is cut, how updates flow, and what
the macOS warning means. Everything here works without a paid Apple Developer ID; signing and
notarisation are optional add-ons documented at the end and in `MENUBAR.md`.

```
                 git tag vX.Y.Z
                        │  .github/workflows/release.yml
        ┌───────────────┼────────────────────────┐
        ▼               ▼                        ▼
  A ubuntu          B macos-latest           C ubuntu (after A+B)
  pnpm build        swift build -c release   GitHub Release:
  make-tarball.sh   make dmg (unsigned)        mesh-node.js (+.sha256)
   ├ mesh-node.js    └ MeshNode-X.Y.Z-arm64.dmg mesh-node-X.Y.Z-darwin-arm64.tar.gz (+.sha256)
   └ mesh-node-X.Y.Z-  (+ .sha256)             MeshNode-X.Y.Z-arm64.dmg (+.sha256)
     darwin-arm64.tar.gz                        SHA256SUMS.txt, latest.json
                                               + commit homebrew-tap/Formula/mesh-node.rb
                                               + push it to mesh-network/homebrew-tap (token)
                        │
                        ▼
      latest.json  ──►  web host  /downloads/latest.json  ◄── /download page (version, hashes)
                   ──►  gateway   /install/latest.json    ◄── mesh-node update · daily check in `start`
                                                          ◄── menu-bar "Check for updates"
```

## 1. Channels (what a user does)

All three install the same one-file agent (`mesh-node.js`, esbuild bundle, Node 18+) and end with
`mesh-node setup --link <code>` + `mesh-node service install`. The link code comes from the web app
(Run a node → Link a Mac; the wallet signs in the browser, the Mac never holds a key). The web page
that explains all three to users is `/download` (`apps/web/src/pages/Download.tsx`).

| Channel | User runs | Gets the bundle from | Verifies | Updates with |
| --- | --- | --- | --- | --- |
| **Terminal one-liner** (default, what the Node tab shows) | `curl -fsSL <web>/install-node.sh \| sh -s -- --link <code> --gateway <gw> --web <web>` | `GET <gw>/install/mesh-node.js` (302 → release asset when the gateway has no local file), fallback `<web>/mesh-node.js` | content sniff only at install; `mesh-node update` verifies SHA-256 | `mesh-node update` (manual) · daily check in `mesh-node start` logs; `MESH_AUTO_UPDATE=1` installs |
| **Homebrew** | `brew install mesh-network/tap/mesh-node` then the two mesh-node commands | release tarball pinned in the formula | brew checks the tarball sha256 | `brew upgrade mesh-node` (`mesh-node update` refuses and says so) |
| **Menu-bar app** | download `MeshNode-X.Y.Z-arm64.dmg`, drag to Applications, Open Anyway | GitHub Release asset linked from `/download` | user compares the SHA-256 shown on `/download` (from `latest.json`) | "Check for updates" in the popover reads `latest.json` and opens `/download`; no self-update |
| Tarball by hand | unpack `mesh-node-X.Y.Z-darwin-arm64.tar.gz`, `./install.sh` | release asset | `.sha256` next to it | re-run `install.sh` or `mesh-node update` |

The menu-bar app does **not** contain the agent. Linking from the app runs `~/.mesh/bin/mesh-node`
(installs it via the one-liner when missing), so a Mac with the app still has the agent from channel 1.

### Terminal

```sh
curl -fsSL https://<web-host>/install-node.sh | sh -s -- --link K7QM2XDA --gateway https://<gateway-host> --web https://<web-host>
mesh-node status
mesh-node update            # later: checks latest.json, verifies sha256, swaps ~/.mesh/bin/mesh-node.js, restarts launchd
mesh-node update --check    # exit 2 when a newer version exists, 0 when current
```

### Homebrew

```sh
brew install mesh-network/tap/mesh-node     # formula: depends_on "node", arm64 + macOS only
mesh-node setup --link K7QM2XDA --gateway https://<gateway-host>
mesh-node service install
brew upgrade mesh-node                      # new versions; the launchd service picks the new file up on restart
```

The wrapper brew installs sets `MESH_INSTALL_CHANNEL=brew`, which makes `mesh-node update` print the
`brew upgrade` line instead of writing into the Cellar.

### Menu-bar app (unsigned beta)

1. Download the DMG from `/download`; optionally `shasum -a 256 ~/Downloads/MeshNode-X.Y.Z-arm64.dmg`
   and compare with the hash on the page.
2. Open the DMG, drag Mesh Node to Applications.
3. Double-click it. macOS: "Apple could not verify Mesh Node is free of malware" → **Done**.
4. System Settings → Privacy & Security → scroll to Security → "Mesh Node was blocked" → **Open Anyway**
   → Touch ID / password.
5. Open it again → **Open**. Only the first launch does this.

On macOS 15 (Sequoia) and later, right-click → Open no longer offers "Open" for unsigned apps; the
System Settings route is the only one. `/download` says this in the warning box.

## 2. Release steps (operator)

```sh
# 0. green tree
pnpm -r typecheck && pnpm test:all && pnpm --filter web build && pnpm --filter web e2e

# 1. bump + tag (the tag is the version everywhere: bundle --version, tarball name, DMG name, formula)
#    apps/node-agent/package.json "version" should match; the build stamps the tag regardless (MESH_BUILD_VERSION).
git tag v0.2.0 && git push origin v0.2.0

# 2. watch .github/workflows/release.yml (jobs A, B, C). ~10 min. docker.yml builds the gateway image on the same tag.

# 3. publish latest.json to the web host, one of:
#    a) copy release/latest.json to <web root>/downloads/latest.json   (apps/web/dist/downloads/ after `pnpm --filter web build`
#       holds the SAMPLE file from apps/web/public; overwrite it in the deploy step)
#    b) or set the gateway UPDATE_LATEST_URL=https://github.com/<owner>/mesh/releases/latest/download/latest.json
#       (the gateway proxies it with a 60 s cache; the web page still needs (a) for /download)
#    c) or POST it to the gateway by hand:
curl -X POST https://<gateway-host>/admin/release -H "x-admin-token: $ADMIN_TOKEN" -H 'content-type: application/json' \
  --data @release/latest.json

# 4. smoke test on a Mac: curl one-liner, `mesh-node update --check` (should say up to date), open the DMG via Open Anyway
```

Dry run without a tag: Actions → Release → Run workflow with `version` = `0.2.0-rc1`. Builds the
artifacts (download them from the run) but creates no GitHub Release and commits nothing.

Local equivalents:

```sh
VERSION=0.2.0 sh scripts/release/make-tarball.sh         # dist/release/*.tar.gz + mesh-node.js + .sha256 files; prints MESH_* vars
cd apps/menubar && VERSION=0.2.0 make dmg                  # build/MeshNode-0.2.0-arm64.dmg + .sha256 (Mac only)
sh scripts/release/update-formula.sh 0.2.0 <tarball-url> <sha256>
```

### Homebrew tap

Homebrew needs the formula in a repo named `homebrew-<tap>`; `brew install mesh-network/tap/mesh-node`
resolves to `github.com/mesh-network/homebrew-tap/Formula/mesh-node.rb`. The source of truth is
`homebrew-tap/Formula/mesh-node.rb` in this repo:

- Job C runs `scripts/release/update-formula.sh` (rewrites `url` and `sha256`; the version is in the URL),
  commits the file to the default branch, and, when the `HOMEBREW_TAP_TOKEN` secret (a fine-grained PAT
  with contents:write on the tap repo) exists, clones the tap repo and pushes `Formula/mesh-node.rb`.
  `vars.HOMEBREW_TAP_REPO` overrides the repo name.
- First time / by hand: create the empty repo `mesh-network/homebrew-tap`, then
  `cp homebrew-tap/Formula/mesh-node.rb <tap>/Formula/ && cp homebrew-tap/README.md <tap>/ && git push`.
- Check: `brew install --build-from-source ./homebrew-tap/Formula/mesh-node.rb && brew test mesh-node && brew audit --strict mesh-node`.

The formula's placeholder `sha256` (all zeros) is replaced by the first release; until then
`brew install` fails on the checksum by design.

## 3. How updates flow

`latest.json` (one document, three readers):

```json
{
  "version": "0.2.0",
  "channel": "beta",
  "publishedAt": "2026-10-03T12:00:00Z",
  "bundleUrl": "https://github.com/<owner>/mesh/releases/download/v0.2.0/mesh-node.js",
  "bundleSha256": "…64 hex…",
  "tarballUrl": "…/mesh-node-0.2.0-darwin-arm64.tar.gz", "tarballSha256": "…",
  "dmgUrl": "…/MeshNode-0.2.0-arm64.dmg", "dmgSha256": "…",
  "minMacOS": "13.0", "arch": "arm64", "notes": "release page url"
}
```

- **Web** serves it at `/downloads/latest.json`. In dev and in the built `dist/`, that is the sample
  file in `apps/web/public/downloads/latest.json` (`"sample": true`, the page says "sample data"); the
  deploy step overwrites it with the released one. `/download` reads it for version, links and hashes.
- **Gateway** `GET /install/latest.json` (`apps/gateway/src/routes/install.ts`): proxies
  `UPDATE_LATEST_URL` with a 60 s cache, or serves the static file at `UPDATE_LATEST_PATH` (default
  `data/latest.json`, next to the SQLite file) written by `POST /admin/release` (admin token, audited,
  409 while an upstream URL is configured). `GET /admin/release` shows what it currently serves.
  `GET /install/mesh-node.js` serves `NODE_BUNDLE_PATH` (default `apps/node-agent/dist/mesh-node.js`),
  or 302s to `bundleUrl` when the file is absent, so a production gateway needs no local bundle.
- **mesh-node** (`apps/node-agent/src/update.ts`): `MESH_UPDATE_URL` or `<gateway>/install/latest.json`.
  `mesh-node update` downloads to `~/.mesh/bin/mesh-node.js.update.tmp`, checks the SHA-256 and that
  the body is JavaScript (not an HTML error page), `rename(2)`s it over `mesh-node.js`, and
  `launchctl kickstart -k`s the service. Any failure leaves the installed file untouched. `start` runs
  the check 60 s after boot and then daily; it logs `update available: …` once per version and installs
  only with `MESH_AUTO_UPDATE=1`. `MESH_UPDATE_CHECK=0` disables the check. Dev builds (`0.1.0-dev`)
  never report an update. Tests: `apps/node-agent/test/update.test.ts` (good hash, bad hash, HTML body,
  same version, 5xx, loop logging, auto-install).
- **Menu-bar app** (`UpdateChecker.swift`, `ReleaseInfo.swift`): "Check for updates" fetches
  `<web>/downloads/latest.json`, compares with `CFBundleShortVersionString`, and offers "Open download
  page". It never replaces itself; Sparkle (needs an EdDSA key + appcast) is the later step.

Rollback: publish a `latest.json` with the previous version and hashes (the files are still on the
old release). `mesh-node update` does not downgrade on its own; users run `mesh-node update` after
you tell them, or set `MESH_UPDATE_URL` to the old release's `latest.json`.

## 4. What the warning means

Gatekeeper trusts apps signed with a Developer ID certificate ($99/year Apple Developer Program) and
notarised by Apple. Our DMG is signed ad-hoc only, so macOS shows "cannot verify that this app is free
of malware" and blocks it until the user allows it in System Settings. This is a statement about who
signed it, not about what it does. What a user can check instead:

- the release is built by GitHub Actions from a public tag (the run is linked from the release page);
- the SHA-256 on `/download` comes from `latest.json` written by that same run, and `shasum -a 256`
  on the downloaded file must match;
- the Terminal and Homebrew routes have no Gatekeeper warning because they install a script, not an
  app bundle; Homebrew verifies the tarball hash and `mesh-node update` verifies the bundle hash.

What a node sends and keeps (`PRIVACY.md`): heartbeats (models, busy, load average), job results
(token counts, timings), chip + RAM, tied to the node id and the reward wallet. Never prompts or
replies beyond the moment they are served, never the requester's identity. `/download` itself makes
one network call, to `/downloads/latest.json` on its own origin.

## 5. Signing later (optional)

Nothing above changes when the developer account exists. Set the repo secrets and job B signs and
notarises automatically; the DMG name, `latest.json` shape and the `/download` page stay the same
(drop the Open Anyway box then).

| Secret | Used for |
| --- | --- |
| `MACOS_CERT_P12` (base64), `MACOS_CERT_PASSWORD` | import the Developer ID Application certificate into a temporary keychain |
| `MACOS_CODESIGN_IDENTITY` | `"Developer ID Application: Name (TEAMID)"` → `make-app.sh --options runtime`, `make-dmg.sh` signs the DMG |
| `NOTARY_APPLE_ID`, `NOTARY_TEAM_ID`, `NOTARY_PASSWORD` (app-specific) | `xcrun notarytool store-credentials mesh-notary`; `make-dmg.sh` submits, waits, staples |
| `HOMEBREW_TAP_TOKEN` | push the formula to the tap repo (unrelated to Apple; needed from the first release) |

Details and the manual path: `MENUBAR.md` §3–4.

## 6. Files

```
scripts/install-node.sh                 Terminal installer (served by the web app at /install-node.sh)
scripts/release/make-tarball.sh         bundle + wrapper + install.sh -> tar.gz, prints sha256 / MESH_* vars
scripts/release/update-formula.sh       rewrites url + sha256 in the formula
homebrew-tap/Formula/mesh-node.rb       the formula (mirrored to mesh-network/homebrew-tap)
apps/node-agent/src/update.ts           mesh-node update + daily check
apps/gateway/src/routes/install.ts      /install/latest.json, /install/mesh-node.js, /admin/release
apps/web/src/pages/Download.tsx         /download
apps/web/public/downloads/latest.json   sample document (replaced at deploy)
apps/menubar/scripts/make-dmg.sh        MeshNode-<v>-arm64.dmg + .sha256, signing optional
apps/menubar/Sources/MeshNode/UpdateChecker.swift, Sources/MeshNodeCore/ReleaseInfo.swift
.github/workflows/release.yml           jobs A/B/C
```
