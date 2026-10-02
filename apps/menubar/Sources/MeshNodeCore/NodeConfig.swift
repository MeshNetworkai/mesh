import Foundation

/// `~/.mesh/config.json` as written by `mesh-node setup` (apps/node-agent/src/config.ts).
public struct NodeConfig: Equatable {
    public var gateway: String
    public var nodeId: String
    public var nodeToken: String
    public var wallet: String
    public var models: [String]
    /// Ollama base URL (default http://127.0.0.1:11434).
    public var ollama: String
    public var chip: String
    public var ramGb: Double
    /// Unix seconds; 0 when unknown.
    public var registeredAt: Double

    public static let defaultGateway = "http://localhost:8787"
    public static let defaultOllama = "http://127.0.0.1:11434"

    public init(
        gateway: String,
        nodeId: String,
        nodeToken: String,
        wallet: String,
        models: [String] = [],
        ollama: String = NodeConfig.defaultOllama,
        chip: String = "unknown",
        ramGb: Double = 0,
        registeredAt: Double = 0
    ) {
        self.gateway = NodeConfig.stripTrailingSlash(gateway)
        self.nodeId = nodeId
        self.nodeToken = nodeToken
        self.wallet = wallet
        self.models = models
        self.ollama = NodeConfig.stripTrailingSlash(ollama)
        self.chip = chip
        self.ramGb = ramGb
        self.registeredAt = registeredAt
    }

    static func stripTrailingSlash(_ s: String) -> String {
        var out = s
        while out.hasSuffix("/") { out.removeLast() }
        return out
    }
}

public enum NodeConfigError: Error, Equatable, LocalizedError {
    case notJSON
    case incomplete(missing: [String])

    public var errorDescription: String? {
        switch self {
        case .notJSON:
            return "config.json is not valid JSON"
        case .incomplete(let missing):
            return "config.json is incomplete (missing \(missing.joined(separator: ", "))); run mesh-node setup again"
        }
    }
}

extension NodeConfig {
    /// Lenient parse mirroring `loadConfig()` in the agent: the four identity fields are required,
    /// everything else has a default. Numbers may arrive as JSON numbers or numeric strings.
    public static func parse(_ data: Data) throws -> NodeConfig {
        guard let any = try? JSONSerialization.jsonObject(with: data),
              let dict = any as? [String: Any] else {
            throw NodeConfigError.notJSON
        }
        let required = ["gateway", "nodeId", "nodeToken", "wallet"]
        var values: [String: String] = [:]
        var missing: [String] = []
        for key in required {
            if let s = dict[key] as? String, !s.isEmpty {
                values[key] = s
            } else {
                missing.append(key)
            }
        }
        if !missing.isEmpty { throw NodeConfigError.incomplete(missing: missing) }

        let models = (dict["models"] as? [Any])?.compactMap { $0 as? String } ?? []
        let ollama = (dict["ollama"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? defaultOllama
        let chip = (dict["chip"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "unknown"

        return NodeConfig(
            gateway: values["gateway"]!,
            nodeId: values["nodeId"]!,
            nodeToken: values["nodeToken"]!,
            wallet: values["wallet"]!,
            models: models,
            ollama: ollama,
            chip: chip,
            ramGb: Lenient.double(dict["ramGb"]) ?? 0,
            registeredAt: Lenient.double(dict["registeredAt"]) ?? 0
        )
    }

    public static func parse(jsonString: String) throws -> NodeConfig {
        try parse(Data(jsonString.utf8))
    }

    /// `node_3f9a…` style short id for tight UI (first 4 + last 4 of the part after the prefix).
    public var shortNodeId: String {
        Lenient.shorten(nodeId, prefixSeparator: "_")
    }

    public var shortWallet: String {
        Lenient.shorten(wallet, prefixSeparator: nil)
    }
}

/// Tolerant coercions shared by the config and stats parsers.
enum Lenient {
    static func double(_ v: Any?) -> Double? {
        switch v {
        case let d as Double: return d.isFinite ? d : nil
        case let i as Int: return Double(i)
        case let n as NSNumber: return n.doubleValue.isFinite ? n.doubleValue : nil
        case let s as String: return Double(s.trimmingCharacters(in: .whitespaces))
        default: return nil
        }
    }

    static func int(_ v: Any?) -> Int? {
        guard let d = double(v) else { return nil }
        return Int(d.rounded())
    }

    static func bool(_ v: Any?) -> Bool? {
        switch v {
        case let b as Bool: return b
        case let n as NSNumber: return n.boolValue
        case let s as String:
            switch s.lowercased() {
            case "true", "1", "yes": return true
            case "false", "0", "no": return false
            default: return nil
            }
        default: return nil
        }
    }

    static func string(_ v: Any?) -> String? {
        guard let s = v as? String, !s.isEmpty else { return nil }
        return s
    }

    static func strings(_ v: Any?) -> [String]? {
        guard let arr = v as? [Any] else { return nil }
        return arr.compactMap { $0 as? String }
    }

    /// `node_3f9a1b2c3d4e` -> `node_3f9a…3d4e`; `9xQeKf2…Hn4kTzAq` for wallets.
    static func shorten(_ s: String, prefixSeparator: Character?, keep: Int = 4) -> String {
        var prefix = ""
        var body = Substring(s)
        if let sep = prefixSeparator, let idx = s.firstIndex(of: sep) {
            prefix = String(s[...idx])
            body = s[s.index(after: idx)...]
        }
        guard body.count > keep * 2 + 1 else { return s }
        return prefix + String(body.prefix(keep)) + "\u{2026}" + String(body.suffix(keep))
    }
}
