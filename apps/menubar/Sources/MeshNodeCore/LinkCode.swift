import Foundation

/// Link codes: 8 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no 0/O/1/I), 15 minutes,
/// single use. Case and separators are ignored on input, exactly as `normalizeLinkCode` in
/// apps/node-agent/src/setup.ts and the gateway do.
public enum LinkCode {
    public static let length = 8
    public static let alphabet: Set<Character> = Set("ABCDEFGHJKLMNPQRSTUVWXYZ23456789")

    /// `k7qm-2xda` -> `K7QM2XDA`. Anything that is not A-Z or 0-9 is dropped.
    public static func normalize(_ raw: String) -> String {
        String(raw.uppercased().filter { ("A"..."Z").contains($0) || ("0"..."9").contains($0) })
    }

    /// Normalised and clipped to 8 characters, for live text-field binding.
    public static func clip(_ raw: String) -> String {
        String(normalize(raw).prefix(length))
    }

    public enum Check: Equatable {
        case empty
        case tooShort(Int)
        case tooLong(Int)
        /// Right length but contains 0, O, 1 or I, which the gateway never issues.
        case suspiciousCharacters([Character])
        case ok
    }

    public static func check(_ raw: String) -> Check {
        let code = normalize(raw)
        if code.isEmpty { return .empty }
        if code.count < length { return .tooShort(code.count) }
        if code.count > length { return .tooLong(code.count) }
        let bad = code.filter { !alphabet.contains($0) }
        if !bad.isEmpty { return .suspiciousCharacters(Array(bad)) }
        return .ok
    }

    /// Usable as `--link` (right length; odd characters are still sent, the gateway decides).
    public static func isSendable(_ raw: String) -> Bool {
        switch check(raw) {
        case .ok, .suspiciousCharacters: return true
        default: return false
        }
    }

    /// `K7QM-2XDA` for display.
    public static func pretty(_ raw: String) -> String {
        let code = normalize(raw)
        guard code.count == length else { return code }
        return String(code.prefix(4)) + "-" + String(code.suffix(4))
    }
}

/// The install one-liner from apps/node-agent/README.md, for Macs that do not have the agent yet.
public enum InstallCommand {
    /// `curl -fsSL <web>/install-node.sh | sh -s -- --link <code> --gateway <gateway>`
    public static func oneLiner(web: String, gateway: String, code: String?) -> String {
        let webBase = NodeConfig.stripTrailingSlash(web)
        let gw = NodeConfig.stripTrailingSlash(gateway)
        var parts = ["curl -fsSL \(webBase)/install-node.sh | sh -s --"]
        if let code, !code.isEmpty { parts.append("--link \(LinkCode.normalize(code))") }
        parts.append("--gateway \(gw)")
        return parts.joined(separator: " ")
    }

    /// Arguments for `~/.mesh/bin/mesh-node setup`.
    public static func setupArguments(code: String, gateway: String?) -> [String] {
        var args = ["setup", "--link", LinkCode.normalize(code)]
        if let gateway, !gateway.trimmingCharacters(in: .whitespaces).isEmpty {
            args += ["--gateway", NodeConfig.stripTrailingSlash(gateway.trimmingCharacters(in: .whitespaces))]
        }
        return args
    }

    public static let serviceInstallArguments = ["service", "install"]
}
