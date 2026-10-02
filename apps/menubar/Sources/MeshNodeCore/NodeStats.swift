import Foundation

/// `GET /nodes/:id` (docs/NODE_PROTOCOL.md section 8). Every field except `status` is optional so an
/// older or newer gateway never breaks the menu bar.
public struct NodeStats: Equatable {
    public enum GatewayState: String, Equatable {
        case idle, busy, offline
        /// Anything the gateway sends that we do not know (the raw word is kept in `rawStatus`).
        case unknown
    }

    public var state: GatewayState
    public var rawStatus: String
    public var online: Bool
    /// 0...100
    public var uptimePct24h: Double?
    public var jobs24h: Int?
    public var jobsDone24h: Int?
    public var jobsFailed24h: Int?
    public var tokens24h: Int?
    public var earnedUsd24h: Double?
    public var earnedUsdTotal: Double?
    public var models: [String]?
    public var chip: String?
    public var ramGb: Double?
    public var loadAvg: Double?
    public var agentVersion: String?
    /// Unix seconds (the gateway sends seconds; milliseconds are accepted and converted).
    public var lastSeen: Double?
    public var createdAt: Double?
    public var reputation: Reputation?

    public struct Reputation: Equatable {
        public var jobs: Int?
        public var successRate: Double?
        public var avgFirstTokenMs: Double?
        public var eligible: Bool?

        public init(jobs: Int? = nil, successRate: Double? = nil, avgFirstTokenMs: Double? = nil, eligible: Bool? = nil) {
            self.jobs = jobs
            self.successRate = successRate
            self.avgFirstTokenMs = avgFirstTokenMs
            self.eligible = eligible
        }
    }

    public init(
        state: GatewayState,
        rawStatus: String? = nil,
        online: Bool? = nil,
        uptimePct24h: Double? = nil,
        jobs24h: Int? = nil,
        jobsDone24h: Int? = nil,
        jobsFailed24h: Int? = nil,
        tokens24h: Int? = nil,
        earnedUsd24h: Double? = nil,
        earnedUsdTotal: Double? = nil,
        models: [String]? = nil,
        chip: String? = nil,
        ramGb: Double? = nil,
        loadAvg: Double? = nil,
        agentVersion: String? = nil,
        lastSeen: Double? = nil,
        createdAt: Double? = nil,
        reputation: Reputation? = nil
    ) {
        self.state = state
        self.rawStatus = rawStatus ?? state.rawValue
        self.online = online ?? (state == .idle || state == .busy)
        self.uptimePct24h = uptimePct24h
        self.jobs24h = jobs24h
        self.jobsDone24h = jobsDone24h
        self.jobsFailed24h = jobsFailed24h
        self.tokens24h = tokens24h
        self.earnedUsd24h = earnedUsd24h
        self.earnedUsdTotal = earnedUsdTotal
        self.models = models
        self.chip = chip
        self.ramGb = ramGb
        self.loadAvg = loadAvg
        self.agentVersion = agentVersion
        self.lastSeen = lastSeen
        self.createdAt = createdAt
        self.reputation = reputation
    }
}

public enum NodeStatsError: Error, Equatable, LocalizedError {
    case notJSON
    case missingStatus

    public var errorDescription: String? {
        switch self {
        case .notJSON: return "the gateway answered with something that is not JSON"
        case .missingStatus: return "the gateway answer has no status field"
        }
    }
}

extension NodeStats {
    public static func parse(_ data: Data) throws -> NodeStats {
        guard let any = try? JSONSerialization.jsonObject(with: data),
              let dict = any as? [String: Any] else {
            throw NodeStatsError.notJSON
        }
        return try parse(dictionary: dict)
    }

    public static func parse(jsonString: String) throws -> NodeStats {
        try parse(Data(jsonString.utf8))
    }

    public static func parse(dictionary dict: [String: Any]) throws -> NodeStats {
        // `status` is the only required field. A missing one with an explicit `online` is tolerated.
        let raw = Lenient.string(dict["status"])?.lowercased()
        let online = Lenient.bool(dict["online"])
        let state: GatewayState
        switch raw {
        case "idle", "online": state = .idle
        case "busy": state = .busy
        case "offline": state = .offline
        case nil:
            guard let online else { throw NodeStatsError.missingStatus }
            state = online ? .idle : .offline
        default: state = .unknown
        }

        var reputation: Reputation?
        if let rep = dict["reputation"] as? [String: Any] {
            reputation = Reputation(
                jobs: Lenient.int(rep["jobs"]),
                successRate: Lenient.double(rep["successRate"]),
                avgFirstTokenMs: Lenient.double(rep["avgFirstTokenMs"]),
                eligible: Lenient.bool(rep["eligible"])
            )
        }

        return NodeStats(
            state: state,
            rawStatus: raw ?? (online == true ? "online" : "offline"),
            online: online ?? (state == .idle || state == .busy),
            uptimePct24h: Lenient.double(dict["uptimePct24h"]),
            jobs24h: Lenient.int(dict["jobs24h"]),
            jobsDone24h: Lenient.int(dict["jobsDone24h"]),
            jobsFailed24h: Lenient.int(dict["jobsFailed24h"]),
            tokens24h: Lenient.int(dict["tokens24h"]),
            earnedUsd24h: Lenient.double(dict["earnedUsd24h"]),
            earnedUsdTotal: Lenient.double(dict["earnedUsdTotal"]),
            models: Lenient.strings(dict["models"]),
            chip: Lenient.string(dict["chip"]),
            ramGb: Lenient.double(dict["ramGb"]),
            loadAvg: Lenient.double(dict["loadAvg"]),
            agentVersion: Lenient.string(dict["agentVersion"]),
            lastSeen: normalizeSeconds(Lenient.double(dict["lastSeen"])),
            createdAt: normalizeSeconds(Lenient.double(dict["createdAt"])),
            reputation: reputation
        )
    }

    /// Accepts seconds or milliseconds (anything above 1e12 is treated as ms, as the CLI does).
    static func normalizeSeconds(_ v: Double?) -> Double? {
        guard let v, v > 0 else { return nil }
        return v > 1e12 ? v / 1000 : v
    }
}
