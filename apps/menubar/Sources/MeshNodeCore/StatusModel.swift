import Foundation

/// The four menu-bar colours.
///
/// - `serving` (green): the gateway sees the node online and it is taking jobs (idle or busy).
/// - `idle` (amber): online but deliberately not taking jobs: the pause flag is set.
/// - `offline` (grey): not linked yet, the agent is not running, or the gateway marks it offline.
/// - `error` (red): we have a config but cannot get an answer from the gateway (network, 401/404,
///   bad JSON).
public enum NodeStatus: String, Equatable, CaseIterable, Sendable {
    case serving
    case idle
    case offline
    case error
}

/// Why the last poll failed. Kept separate from `Error` so it is Equatable and testable.
public enum PollFailure: Equatable, Sendable {
    case network(String)
    case http(status: Int, code: String?)
    case decode(String)
    case configUnreadable(String)

    public var isAuth: Bool {
        if case .http(let status, _) = self { return status == 401 || status == 404 }
        return false
    }
}

public struct StatusSnapshot: Equatable, Sendable {
    public var status: NodeStatus
    /// Short word for the header: "Serving", "Paused", "Offline", "Not linked", "Unreachable".
    public var headline: String
    /// One short sentence under the headline.
    public var detail: String

    public init(status: NodeStatus, headline: String, detail: String) {
        self.status = status
        self.headline = headline
        self.detail = detail
    }
}

public enum StatusModel {
    /// Pure mapping from what we know to what the menu bar shows.
    public static func derive(
        config: NodeConfig?,
        stats: NodeStats?,
        paused: Bool,
        failure: PollFailure?,
        now: Date = Date()
    ) -> StatusSnapshot {
        guard let config else {
            return StatusSnapshot(
                status: .offline,
                headline: "Not linked",
                detail: "Link this Mac to start serving."
            )
        }

        if let failure {
            switch failure {
            case .http(let status, let code) where status == 401 || status == 404:
                return StatusSnapshot(
                    status: .error,
                    headline: "Not recognised",
                    detail: "The gateway rejected this node (\(code ?? String(status))). Link this Mac again."
                )
            case .http(let status, let code):
                return StatusSnapshot(
                    status: .error,
                    headline: "Gateway error",
                    detail: "HTTP \(status)\(code.map { " \($0)" } ?? "") from \(hostOnly(config.gateway))."
                )
            case .network(let message):
                return StatusSnapshot(
                    status: .error,
                    headline: "Unreachable",
                    detail: "Cannot reach \(hostOnly(config.gateway)): \(message)"
                )
            case .decode(let message):
                return StatusSnapshot(status: .error, headline: "Bad answer", detail: message)
            case .configUnreadable(let message):
                return StatusSnapshot(status: .error, headline: "Config problem", detail: message)
            }
        }

        guard let stats else {
            return StatusSnapshot(status: .offline, headline: "Checking", detail: "Asking the gateway.")
        }

        if stats.state == .offline || !stats.online {
            let seen = Format.ago(stats.lastSeen, now: now)
            return StatusSnapshot(
                status: .offline,
                headline: "Offline",
                detail: stats.lastSeen == nil
                    ? "The agent has never checked in. Is the service installed?"
                    : "Last heartbeat \(seen). The agent is not running."
            )
        }

        if paused {
            return StatusSnapshot(
                status: .idle,
                headline: "Paused",
                detail: "Online but not taking jobs. Resume when the Mac is free."
            )
        }

        switch stats.state {
        case .busy:
            return StatusSnapshot(status: .serving, headline: "Serving", detail: "Running a job now.")
        case .idle:
            return StatusSnapshot(status: .serving, headline: "Serving", detail: "Online, waiting for jobs.")
        case .unknown:
            return StatusSnapshot(
                status: .serving,
                headline: "Serving",
                detail: "Online (gateway status \"\(stats.rawStatus)\")."
            )
        case .offline:
            // Unreachable: handled above. Kept for exhaustiveness.
            return StatusSnapshot(status: .offline, headline: "Offline", detail: "")
        }
    }

    /// `https://api.example.com:8787/x` -> `api.example.com:8787`
    static func hostOnly(_ url: String) -> String {
        guard let u = URL(string: url), let host = u.host else { return url }
        if let port = u.port { return "\(host):\(port)" }
        return host
    }
}
