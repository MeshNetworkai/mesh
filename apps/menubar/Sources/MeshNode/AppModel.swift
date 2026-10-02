#if os(macOS)
import AppKit
import Foundation
import MeshNodeCore

/// Everything the popover shows. Polls `~/.mesh/config.json` + `GET /nodes/:id` every 15 s.
@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var config: NodeConfig?
    @Published private(set) var stats: NodeStats?
    @Published private(set) var failure: PollFailure?
    @Published private(set) var paused = false
    @Published private(set) var snapshot = StatusSnapshot(status: .offline, headline: "Checking", detail: "")
    @Published private(set) var lastUpdated: Date?
    @Published private(set) var isRefreshing = false
    @Published private(set) var agentInstalled = false
    @Published private(set) var launchAtLogin = LaunchAtLogin.isEnabled
    @Published var actionError: String?

    let runner = AgentRunner()

    private let gateway = GatewayClient()
    private var pollTask: Task<Void, Never>?
    private var wakeObserver: NSObjectProtocol?

    init() {}

    // MARK: - lifecycle

    func start() {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                try? await Task.sleep(for: .seconds(Brand.pollInterval))
            }
        }
        let center = NSWorkspace.shared.notificationCenter
        wakeObserver = center.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in await self?.refresh() }
        }
    }

    func stop() {
        pollTask?.cancel()
        pollTask = nil
        if let wakeObserver { NSWorkspace.shared.notificationCenter.removeObserver(wakeObserver) }
        wakeObserver = nil
    }

    // MARK: - polling

    func refresh() async {
        if isRefreshing { return }
        isRefreshing = true
        defer { isRefreshing = false }

        agentInstalled = MeshPaths.agentInstalled
        paused = FileManager.default.fileExists(atPath: MeshPaths.pauseFlag.path)
        launchAtLogin = LaunchAtLogin.isEnabled

        let loaded = Self.loadConfig()
        switch loaded {
        case .none:
            config = nil
            stats = nil
            failure = nil
        case .unreadable(let message):
            config = nil
            stats = nil
            failure = .configUnreadable(message)
        case .some(let cfg):
            let changedIdentity = cfg.nodeId != config?.nodeId || cfg.gateway != config?.gateway
            config = cfg
            if changedIdentity { stats = nil }
            switch await gateway.fetchStats(for: cfg) {
            case .stats(let s):
                stats = s
                failure = nil
            case .failure(let f):
                failure = f
            }
        }
        lastUpdated = Date()
        recompute()
    }

    private func recompute() {
        // A config that cannot be read is shown as an error even though `config` is nil.
        if case .configUnreadable(let message)? = failure {
            snapshot = StatusSnapshot(status: .error, headline: "Config problem", detail: message)
            return
        }
        snapshot = StatusModel.derive(config: config, stats: stats, paused: paused, failure: failure)
    }

    private enum LoadedConfig {
        case none
        case unreadable(String)
        case some(NodeConfig)
    }

    private static func loadConfig() -> LoadedConfig {
        let url = MeshPaths.config
        guard FileManager.default.fileExists(atPath: url.path) else { return .none }
        do {
            let data = try Data(contentsOf: url)
            return .some(try NodeConfig.parse(data))
        } catch let e as NodeConfigError {
            return .unreadable(e.errorDescription ?? "config.json is unreadable")
        } catch {
            return .unreadable("cannot read \(MeshPaths.homeForDisplay)/config.json: \(error.localizedDescription)")
        }
    }

    // MARK: - actions

    /// Same flag file the CLI uses (`mesh-node pause` writes an ISO timestamp to ~/.mesh/paused).
    func pause() {
        do {
            try FileManager.default.createDirectory(at: MeshPaths.home, withIntermediateDirectories: true,
                                                    attributes: [.posixPermissions: 0o700])
            let stamp = ISO8601DateFormatter().string(from: Date()) + "\n"
            try stamp.write(to: MeshPaths.pauseFlag, atomically: true, encoding: .utf8)
            paused = true
            recompute()
        } catch {
            actionError = "Could not pause: \(error.localizedDescription)"
        }
    }

    func resume() {
        do {
            if FileManager.default.fileExists(atPath: MeshPaths.pauseFlag.path) {
                try FileManager.default.removeItem(at: MeshPaths.pauseFlag)
            }
            paused = false
            recompute()
        } catch {
            actionError = "Could not resume: \(error.localizedDescription)"
        }
    }

    func togglePause() {
        if paused {
            resume()
        } else {
            pause()
        }
    }

    var webURL: String {
        let stored = UserDefaults.standard.string(forKey: DefaultsKey.webURL)?.trimmingCharacters(in: .whitespaces) ?? ""
        return stored.isEmpty ? Brand.defaultWebURL : stored
    }

    /// Gateway for a fresh link: Settings override, else the current config's, else the agent default.
    var gatewayForLinking: String {
        let stored = UserDefaults.standard.string(forKey: DefaultsKey.gatewayURL)?.trimmingCharacters(in: .whitespaces) ?? ""
        if !stored.isEmpty { return stored }
        if let g = config?.gateway { return g }
        return NodeConfig.defaultGateway
    }

    func openDashboard() {
        let base = webURL.hasSuffix("/") ? String(webURL.dropLast()) : webURL
        guard let url = URL(string: base + Brand.dashboardPath) else {
            actionError = "The web URL in Settings is not valid."
            return
        }
        NSWorkspace.shared.open(url)
    }

    func openLogs() {
        let log = MeshPaths.nodeLog
        if FileManager.default.fileExists(atPath: log.path) {
            // .log files open in Console.app by default.
            NSWorkspace.shared.open(log)
        } else if FileManager.default.fileExists(atPath: MeshPaths.logsDir.path) {
            NSWorkspace.shared.activateFileViewerSelecting([MeshPaths.logsDir])
        } else {
            actionError = "No log yet at \(MeshPaths.homeForDisplay)/logs/node.log. Link this Mac first."
        }
    }

    func setLaunchAtLogin(_ on: Bool) {
        do {
            try LaunchAtLogin.set(enabled: on)
            launchAtLogin = LaunchAtLogin.isEnabled
            if on, LaunchAtLogin.requiresApproval {
                actionError = "Allow Mesh Node under System Settings > General > Login Items."
            }
        } catch {
            launchAtLogin = LaunchAtLogin.isEnabled
            actionError = "Launch at login: \(error.localizedDescription)"
        }
    }

    /// `mesh-node setup --link <code> [--gateway <url>]` then `mesh-node service install`.
    /// Returns true when both succeeded; the config is re-read either way.
    func link(code: String, gateway: String) async -> Bool {
        runner.clear()
        let setupCode = await runner.run(InstallCommand.setupArguments(code: code, gateway: gateway))
        guard setupCode == 0 else {
            await refresh()
            return false
        }
        let serviceCode = await runner.run(InstallCommand.serviceInstallArguments)
        await refresh()
        return serviceCode == 0
    }

    func quit() {
        stop()
        NSApp.terminate(nil)
    }
}
#endif
