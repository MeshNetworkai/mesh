# Mesh Node — menu-bar app (macOS 13+)

A SwiftUI `MenuBarExtra` that sits next to the clock and shows what `mesh-node` is doing. It does
not replace the agent: `~/.mesh/bin/mesh-node` (installed by `scripts/install-node.sh`) still does
the serving under launchd. The app reads the same files and talks to the same gateway endpoint.

```
menu bar      ●····  green serving · amber paused · grey offline/not linked · red error
popover       Serving / Paused / Offline / Unreachable + one line why
              Earned 24h · Earned total (display numbers)
              Jobs 24h · Uptime 24h · Last seen · Machine · Models
              Pause/Resume · Open dashboard · View logs · Link / Re-link · Check for updates · Settings
              Launch at login · Updated Ns ago · Quit
first run     "Link this Mac": 8-char code -> mesh-node setup --link <code> + service install
              (or the curl one-liner with a Copy button when the agent is not installed yet)
```

Status: **this folder has not been compiled** (it was written in a Linux sandbox with no Swift
toolchain). Syntax was checked by hand; expect to fix a handful of small things on first `swift build`.

## Layout

```
Package.swift                 SwiftPM manifest: MeshNodeCore (library) + MeshNode (executable) + tests
Sources/MeshNodeCore/         Pure Foundation. Builds and tests on Linux.
  NodeConfig.swift            ~/.mesh/config.json parser (mirrors node-agent config.ts)
  NodeStats.swift             GET /nodes/:id parser (docs/NODE_PROTOCOL.md section 8)
  StatusModel.swift           (config, stats, paused, failure) -> green/amber/grey/red + headline + detail
  Format.swift                $0.0741 · 1,284 · 98.3% · 2 h ago · M3 Max · 64 GB
  LinkCode.swift              code normalisation + the install one-liner / setup arguments
  ReleaseInfo.swift           latest.json parser + version compare (what "Check for updates" reads)
Sources/MeshNode/             macOS only (wrapped in #if os(macOS))
  MeshNodeApp.swift           @main, MenuBarExtra(.window), AppDelegate (accessory policy, first-run)
  AppModel.swift              15 s poll loop, pause/resume flag, open dashboard/logs, link()
  AgentRunner.swift           spawns ~/.mesh/bin/mesh-node, streams output
  GatewayClient.swift         URLSession GET /nodes/:id with Bearer <nodeToken>
  UpdateChecker.swift         GET <web>/downloads/latest.json; newer version -> "Open download page" (no self-update)
  LaunchAtLogin.swift         SMAppService.mainApp
  StatusIcon.swift            the menu-bar glyph (five dots, the third carries the status colour)
  Theme.swift                 design-system colours (light/dark) and the type scale (SF)
  PanelWindow.swift           NSWindow host for the Link and Settings views
  Views/StatusView.swift      the popover
  Views/LinkView.swift        first-run window
  Views/SettingsView.swift    web URL, gateway override, launch at login
Tests/MeshNodeCoreTests/      XCTest: status mapping, config/stats parsing, formatting, link codes
Resources/Info.plist          LSUIElement, ATS local networking, placeholders filled by make-app.sh
Resources/MeshNode.entitlements  hardened runtime, no sandbox
scripts/make-app.sh           swift build -c release -> build/MeshNode.app (+ codesign)
scripts/make-dmg.sh           MeshNode-<version>-arm64.dmg + .sha256; signing/notarising optional via env
Makefile                      run · app · dmg · test · open · clean
```

## Run from source

```sh
cd apps/menubar
make run          # swift run MeshNode
```

Under `swift run` there is no bundle, so: the app hides from the Dock via
`NSApp.setActivationPolicy(.accessory)`, "Launch at login" is disabled (SMAppService needs a bundle
id), and plain `http://` gateways other than localhost may be blocked by App Transport Security.

Open the folder in Xcode (File > Open > `apps/menubar`) to debug with breakpoints; Xcode reads
`Package.swift` directly, no `.xcodeproj` is needed or checked in. Pick the `MeshNode` scheme.

## Build the .app

```sh
make app                      # build/MeshNode.app, ad-hoc signed, arm64
ARCHS="arm64 x86_64" make app # universal
make open
```

Signing, notarising and the DMG: see [`docs/MENUBAR.md`](../../docs/MENUBAR.md).

## Tests

```sh
make test     # swift test
```

Only `MeshNodeCore` is tested and it has no AppKit dependency, so this also runs on Linux
(`swift:5.9` Docker image, or any Linux Swift toolchain). On Linux the `MeshNode` executable target
compiles to a stub that prints one line.

## How it maps to the agent

| App | Agent / gateway |
| --- | --- |
| reads `~/.mesh/config.json` (`$MESH_HOME` honoured) | written by `mesh-node setup` with mode 0600 |
| `GET /nodes/:id`, `Authorization: Bearer <nodeToken>`, every 15 s and on wake | `mesh-node status` uses the same call |
| Pause writes `~/.mesh/paused` (ISO timestamp), Resume deletes it | `mesh-node pause` / `resume`; the loop checks the file every 2 s and heartbeats `busy: true` |
| View logs opens `~/.mesh/logs/node.log` | launchd stdout/stderr target |
| Link runs `~/.mesh/bin/mesh-node setup --link <CODE> --gateway <url>` then `service install` | same as `install-node.sh` after the download step |
| Not installed: shows `curl -fsSL <web>/install-node.sh \| sh -s -- --link <code> --gateway <url>` | README one-liner |
| Open dashboard: `<web>/app/node` | web app route |
| Check for updates: `GET <web>/downloads/latest.json`, compares `version` with `CFBundleShortVersionString`, "Open download page" → `<web>/download` | same document `mesh-node update` reads via `GET <gateway>/install/latest.json` |

The web origin is `Brand.defaultWebURL` in `Sources/MeshNode/MeshPaths.swift`
(`https://app.example.com` until there is a real host) and can be changed at runtime in Settings.

Status colours (`StatusModel.derive`): green when the gateway reports the node online (idle or
busy) and the pause flag is absent; amber when online but paused; grey when not linked, never seen,
or marked offline; red when a config exists but the poll failed (network, 401/404, bad JSON).
A failure always wins over stale stats, so the icon cannot stay green while the gateway is away.

## Design notes

System font only (SF, SF Mono for values and the code field), 10pt mono eyebrows with wide tracking,
1pt hairlines instead of boxes, one accent green used only on earnings, status carried by a dot,
no emoji, no exclamation marks. Colours are the design-system tokens with their dark-mode pairs
(`Theme.swift`), resolved per appearance with `NSColor(name:dynamicProvider:)`.
