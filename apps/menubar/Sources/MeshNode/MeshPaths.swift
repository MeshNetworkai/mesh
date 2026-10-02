#if os(macOS)
import Foundation

/// Same layout as apps/node-agent/src/paths.ts: everything under `~/.mesh` (or `$MESH_HOME`).
enum MeshPaths {
    static var home: URL {
        if let env = ProcessInfo.processInfo.environment["MESH_HOME"], !env.isEmpty {
            return URL(fileURLWithPath: (env as NSString).expandingTildeInPath, isDirectory: true)
        }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".mesh", isDirectory: true)
    }

    static var config: URL { home.appendingPathComponent("config.json") }
    static var pauseFlag: URL { home.appendingPathComponent("paused") }
    static var logsDir: URL { home.appendingPathComponent("logs", isDirectory: true) }
    static var nodeLog: URL { logsDir.appendingPathComponent("node.log") }
    static var binDir: URL { home.appendingPathComponent("bin", isDirectory: true) }
    /// The sh wrapper written by scripts/install-node.sh.
    static var agentBinary: URL { binDir.appendingPathComponent("mesh-node") }

    static var agentInstalled: Bool {
        FileManager.default.isExecutableFile(atPath: agentBinary.path)
    }

    static var launchAgentPlist: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/xyz.mesh.node.plist")
    }

    /// `~/.mesh` for display.
    static var homeForDisplay: String {
        let h = FileManager.default.homeDirectoryForCurrentUser.path
        let p = home.path
        return p.hasPrefix(h) ? "~" + String(p.dropFirst(h.count)) : p
    }
}

/// Build-time defaults. Override at runtime in Settings (UserDefaults keys `webURL`, `gatewayURL`).
enum Brand {
    static let appName = "Mesh Node"
    /// Web app origin: serves `/install-node.sh` and the node dashboard at `/app/node`.
    /// Change this before shipping, or set it once in the app's Settings.
    static let defaultWebURL = "https://app.example.com"
    static let dashboardPath = "/app/node"
    static let pollInterval: TimeInterval = 15
}

enum DefaultsKey {
    static let webURL = "webURL"
    static let gatewayURL = "gatewayURL"
    static let suppressedFirstRun = "suppressedFirstRun"
}
#endif
