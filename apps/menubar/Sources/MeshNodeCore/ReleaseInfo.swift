import Foundation

/// `latest.json` as published by the release workflow (docs/DISTRIBUTION.md) and served by the web
/// host at `/downloads/latest.json` and the gateway at `/install/latest.json`. Read by the menu bar's
/// "Check for updates"; the app does not update itself, it opens the download page.
public struct ReleaseInfo: Equatable {
    public var version: String
    public var publishedAt: Date?
    public var dmgUrl: URL?
    public var dmgSha256: String?
    public var bundleUrl: URL?
    public var bundleSha256: String?
    public var tarballUrl: URL?
    public var notes: String?

    public init(version: String, publishedAt: Date? = nil, dmgUrl: URL? = nil, dmgSha256: String? = nil,
                bundleUrl: URL? = nil, bundleSha256: String? = nil, tarballUrl: URL? = nil, notes: String? = nil) {
        self.version = version
        self.publishedAt = publishedAt
        self.dmgUrl = dmgUrl
        self.dmgSha256 = dmgSha256
        self.bundleUrl = bundleUrl
        self.bundleSha256 = bundleSha256
        self.tarballUrl = tarballUrl
        self.notes = notes
    }

    public enum ParseError: Error, LocalizedError, Equatable {
        case notAnObject
        case missingVersion

        public var errorDescription: String? {
            switch self {
            case .notAnObject: return "latest.json is not a JSON object"
            case .missingVersion: return "latest.json has no version"
            }
        }
    }

    public static func parse(_ data: Data) throws -> ReleaseInfo {
        guard let any = try? JSONSerialization.jsonObject(with: data), let dict = any as? [String: Any] else {
            throw ParseError.notAnObject
        }
        guard var version = dict["version"] as? String, !version.isEmpty else { throw ParseError.missingVersion }
        if version.hasPrefix("v") { version.removeFirst() }
        let url: (String) -> URL? = { key in (dict[key] as? String).flatMap { URL(string: $0) } }
        let sha: (String) -> String? = { key in (dict[key] as? String)?.lowercased() }
        var published: Date?
        if let s = dict["publishedAt"] as? String {
            let iso = ISO8601DateFormatter()
            iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            published = iso.date(from: s) ?? ISO8601DateFormatter().date(from: s)
        }
        return ReleaseInfo(
            version: version,
            publishedAt: published,
            dmgUrl: url("dmgUrl"),
            dmgSha256: sha("dmgSha256"),
            bundleUrl: url("bundleUrl"),
            bundleSha256: sha("bundleSha256") ?? sha("sha256"),
            tarballUrl: url("tarballUrl"),
            notes: dict["notes"] as? String
        )
    }

    public static func parse(jsonString: String) throws -> ReleaseInfo {
        try parse(Data(jsonString.utf8))
    }

    /// Dotted-number compare with a `-pre` suffix sorting below the plain version: "0.2.0" > "0.1.9", "1.0.0-beta" < "1.0.0".
    public static func compare(_ a: String, _ b: String) -> Int {
        func split(_ v: String) -> ([Int], String?) {
            var s = Substring(v)
            if s.hasPrefix("v") { s = s.dropFirst() }
            let parts = s.split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
            let nums = parts[0].split(separator: ".").map { Int($0) ?? 0 }
            return (nums, parts.count > 1 ? String(parts[1]) : nil)
        }
        let (x, xp) = split(a)
        let (y, yp) = split(b)
        for i in 0..<max(x.count, y.count) {
            let l = i < x.count ? x[i] : 0
            let r = i < y.count ? y[i] : 0
            if l != r { return l < r ? -1 : 1 }
        }
        switch (xp, yp) {
        case (nil, nil): return 0
        case (nil, _): return 1
        case (_, nil): return -1
        case let (p?, q?): return p == q ? 0 : (p < q ? -1 : 1)
        }
    }

    /// True when this release is newer than `current`. A "dev" build (no bundle) never reports an update.
    public func isNewer(than current: String) -> Bool {
        if current == "dev" || current.hasSuffix("-dev") { return false }
        return Self.compare(version, current) > 0
    }
}
