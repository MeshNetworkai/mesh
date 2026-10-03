# Mesh Node menu-bar app: build, sign, notarise, distribute

The app lives in [`apps/menubar`](../apps/menubar) as a Swift package (SwiftUI `MenuBarExtra`,
macOS 13+). There is no `.xcodeproj`; Xcode opens `Package.swift` directly and the Makefile wraps
`swift build` for the bundle. Everything below runs on a Mac with Xcode 15 or newer (Swift 5.9).

The code has not been compiled yet (written without a Swift toolchain); the first `swift build`
on a Mac is step zero.

## 0. Prerequisites

```sh
xcode-select --install            # or full Xcode from the App Store, then: sudo xcodebuild -license
swift --version                   # 5.9+
cd apps/menubar
swift build                       # fix anything the compiler points at
make test                         # MeshNodeCore unit tests
```

## 1. Run

```sh
make run                          # swift run MeshNode; the icon appears next to the clock
```

For a Mac without a linked node the "Link this Mac" window opens by itself. For development you
can point the app at a local stack:

- gateway `pnpm dev:gateway` (http://localhost:8787), web `pnpm dev:web` (http://localhost:5173)
- in the app: Settings > Web app = `http://localhost:5173`, Gateway for new links = `http://localhost:8787`
- make a link code in the web app (Run a node > Link a Mac) and paste it

`MESH_HOME=/tmp/mesh-dev swift run MeshNode` uses a separate state directory, same as the agent.

## 2. Build the .app

```sh
make app                          # build/MeshNode.app  (ad-hoc signed, arm64)
ARCHS="arm64 x86_64" make app     # universal binary
VERSION=0.2.0 BUILD=12 make app   # otherwise: last git tag / commit count
make open
```

`scripts/make-app.sh` does: `swift build -c release`, creates `Contents/{MacOS,Resources}`, fills
`Resources/Info.plist` (`CFBundleIdentifier` = `xyz.mesh.menubar`, `LSUIElement` = true so there is
no Dock icon, `NSAllowsLocalNetworking` for the localhost gateway), writes `PkgInfo`, copies
`Resources/AppIcon.icns` if present, and signs.

### App icon

Not in the repo yet. Make a 1024x1024 PNG of the five-dot mark, then:

```sh
mkdir AppIcon.iconset
for s in 16 32 128 256 512; do
  sips -z $s $s icon-1024.png --out AppIcon.iconset/icon_${s}x${s}.png
  sips -z $((s*2)) $((s*2)) icon-1024.png --out AppIcon.iconset/icon_${s}x${s}@2x.png
done
iconutil -c icns AppIcon.iconset -o apps/menubar/Resources/AppIcon.icns
```

## 3. Sign with Developer ID

You need the Apple Developer Program membership (the account the team already has) and a
**Developer ID Application** certificate in your login keychain (Xcode > Settings > Accounts >
Manage Certificates > + > Developer ID Application, or create it at developer.apple.com and
double-click the `.cer`).

```sh
security find-identity -v -p codesigning
#  1) ABCDEF… "Developer ID Application: Your Company Ltd (TEAMID1234)"

CODESIGN_IDENTITY="Developer ID Application: Your Company Ltd (TEAMID1234)" make app
```

With an identity set, the script signs with `--options runtime --timestamp` (hardened runtime,
required for notarisation) and `Resources/MeshNode.entitlements` (no App Sandbox: the app reads
`~/.mesh`, writes the pause flag and spawns `~/.mesh/bin/mesh-node`). Check:

```sh
codesign -dvv --entitlements - build/MeshNode.app
spctl --assess --type execute -v build/MeshNode.app     # "rejected" until notarised; fine
```

Why no sandbox / not the Mac App Store: the app's job is to read and write files in the user's
home and launch a Node script. Both are impossible from the sandbox without a privileged helper.
Developer ID + notarisation is the right channel.

## 4. Notarise

One-time: store notarisation credentials in the keychain. Use an **app-specific password** for the
Apple ID (appleid.apple.com > Sign-In and Security > App-Specific Passwords), not the account password.

```sh
xcrun notarytool store-credentials mesh-notary \
  --apple-id you@example.com --team-id TEAMID1234 --password xxxx-xxxx-xxxx-xxxx
```

Then build the DMG and let the script submit, wait and staple:

```sh
CODESIGN_IDENTITY="Developer ID Application: Your Company Ltd (TEAMID1234)" \
NOTARY_PROFILE=mesh-notary make dmg
# build/MeshNode-<version>.dmg
```

`scripts/make-dmg.sh` runs `hdiutil create` (UDZO, with an `/Applications` symlink), signs the DMG,
`xcrun notarytool submit --wait`, `xcrun stapler staple`, `stapler validate`, then a Gatekeeper dry
run with `spctl`. If Apple rejects it:

```sh
xcrun notarytool log <submission-id> --keychain-profile mesh-notary
```

Typical causes: binary not signed with hardened runtime (`--options runtime` missing), no secure
timestamp (offline build machine), or an unsigned nested binary (we have none; the agent is not
bundled).

## 5. Distribute

- Attach `MeshNode-<version>.dmg` to a GitHub release (or serve it from the web app next to
  `install-node.sh`). Users drag the app to Applications, open it, and link the Mac. On first open
  macOS shows the standard "downloaded from the internet" prompt; with a stapled notarisation that
  is a single OK.
- Set `Brand.defaultWebURL` in `apps/menubar/Sources/MeshNode/MeshPaths.swift` to the real web host
  before building a release, so Open dashboard and the install one-liner point at production without
  a visit to Settings.
- Launch at login uses `SMAppService.mainApp`; the first time a user enables it macOS may ask them to
  allow it in System Settings > General > Login Items (the app shows a one-line hint and a button).
- The app does not update itself. A later step is Sparkle (needs an EdDSA key and an appcast feed
  served over https) or a "new version" line in the popover fed by `GET /stats`.

## 6. Checklist per release

```
[ ] swift test green
[ ] VERSION bumped (git tag vX.Y.Z)
[ ] Brand.defaultWebURL is the production web host
[ ] CODESIGN_IDENTITY=… NOTARY_PROFILE=… make dmg  -> "ok build/MeshNode-X.Y.Z.dmg"
[ ] xcrun stapler validate build/MeshNode-X.Y.Z.dmg
[ ] open the DMG on a second Mac: drag, open, link, pause, resume, dashboard, logs, quit
```

## Related

- Agent: [`apps/node-agent/README.md`](../apps/node-agent/README.md) (`mesh-node setup/service/pause/resume/logs`)
- Protocol: [`NODE_PROTOCOL.md`](NODE_PROTOCOL.md) section 8 is the `GET /nodes/:id` shape the app parses
- Design tokens: [`design-system.html`](design-system.html)

## Privacy

The menu bar app shows what `mesh-node status` shows: online/paused state, uptime, jobs and tokens in
the last 24 h, earnings, the models advertised and the service state. It reads them from
`GET /nodes/:id` and the agent's log, neither of which contains job content: the agent never writes a
prompt or reply to disk and logs only ids, counts and timings (`docs/PRIVACY.md` §3). There is no
"recent prompts" view and none is planned; an operator who wants to see what their Mac is serving would
have to modify the agent, which is exactly what the operator pledge rules out for trusted nodes.
