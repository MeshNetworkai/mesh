import Foundation

/// Display formatting shared by the popover and the tests. Mirrors `fmt` in the CLI (ui.ts):
/// a missing number is an en dash, never "0" pretending to be data.
public enum Format {
    public static let dash = "\u{2013}"

    /// `$0.0123` (4 decimals by default, like `mesh-node status`).
    public static func usd(_ v: Double?, digits: Int = 4) -> String {
        guard let v, v.isFinite else { return dash }
        return "$" + fixed(v, digits: digits)
    }

    /// `1,284`
    public static func int(_ v: Int?) -> String {
        guard let v else { return dash }
        return grouped(v)
    }

    public static func int(_ v: Double?) -> String {
        guard let v, v.isFinite else { return dash }
        return grouped(Int(v.rounded()))
    }

    /// `98.3%` from a 0...100 value.
    public static func pct(_ v: Double?) -> String {
        guard let v, v.isFinite else { return dash }
        return fixed(v, digits: 1) + "%"
    }

    /// `64 GB`
    public static func ram(_ gb: Double?) -> String {
        guard let gb, gb > 0 else { return dash }
        if gb == gb.rounded() { return "\(Int(gb)) GB" }
        return fixed(gb, digits: 1) + " GB"
    }

    /// `M3 Max · 64 GB`
    public static func machine(chip: String?, ramGb: Double?) -> String {
        let c: String? = (chip?.isEmpty == false) ? chip : nil
        let r: String? = (ramGb ?? 0) > 0 ? ram(ramGb) : nil
        switch (c, r) {
        case let (c?, r?): return "\(c) \u{00B7} \(r)"
        case let (c?, nil): return c
        case let (nil, r?): return r
        default: return dash
        }
    }

    /// Relative time from unix seconds: `just now`, `42 s ago`, `3 min ago`, `2 h ago`, `3 d ago`,
    /// or `never` for nil.
    public static func ago(_ unixSeconds: Double?, now: Date = Date()) -> String {
        guard let unixSeconds, unixSeconds > 0 else { return "never" }
        let sec = unixSeconds > 1e12 ? unixSeconds / 1000 : unixSeconds
        let delta = max(0, Int((now.timeIntervalSince1970 - sec).rounded(.down)))
        switch delta {
        case ..<5: return "just now"
        case ..<60: return "\(delta) s ago"
        case ..<3600: return "\(delta / 60) min ago"
        case ..<86400: return "\(delta / 3600) h ago"
        default: return "\(delta / 86400) d ago"
        }
    }

    /// `12 s` style for "Updated N ago" footers.
    public static func shortAgo(_ date: Date?, now: Date = Date()) -> String {
        guard let date else { return dash }
        let delta = max(0, Int(now.timeIntervalSince(date).rounded(.down)))
        switch delta {
        case ..<60: return "\(delta) s"
        case ..<3600: return "\(delta / 60) min"
        default: return "\(delta / 3600) h"
        }
    }

    /// `llama3.1:8b, qwen2.5:14b` or an en dash.
    public static func models(_ list: [String]?) -> String {
        guard let list, !list.isEmpty else { return dash }
        return list.joined(separator: ", ")
    }

    // MARK: - locale-independent helpers (the UI is English; tests must not depend on the host locale)

    static func fixed(_ v: Double, digits: Int) -> String {
        let s = String(format: "%.\(digits)f", v)
        // Guard against a negative zero like "-0.0000".
        if s.hasPrefix("-"), s.dropFirst().allSatisfy({ $0 == "0" || $0 == "." }) {
            return String(s.dropFirst())
        }
        return s
    }

    static func grouped(_ v: Int) -> String {
        let negative = v < 0
        let digits = Array(String(v.magnitude))
        var out: [Character] = []
        for (i, ch) in digits.enumerated() {
            let fromEnd = digits.count - i
            if i > 0, fromEnd % 3 == 0 { out.append(",") }
            out.append(ch)
        }
        return (negative ? "-" : "") + String(out)
    }
}
