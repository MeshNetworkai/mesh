#if os(macOS)
import Foundation
import MeshNodeCore

/// Reads `latest.json` (the same document `mesh-node update` uses) and compares it with the running
/// app version. No self-update: a newer version sends the user to the web download page, where the
/// DMG, its SHA-256 and the "Open Anyway" steps live (docs/DISTRIBUTION.md).
struct UpdateChecker {
    private let session: URLSession

    init() {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 10
        cfg.timeoutIntervalForResource = 15
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        session = URLSession(configuration: cfg)
    }

    enum Outcome: Equatable {
        case upToDate(ReleaseInfo)
        case available(ReleaseInfo)
        case failed(String)
    }

    /// `<web>/downloads/latest.json`; a gateway's `/install/latest.json` works too (same shape).
    static func latestURL(web: String) -> URL? {
        let base = web.hasSuffix("/") ? String(web.dropLast()) : web
        return URL(string: base + "/downloads/latest.json")
    }

    func check(web: String, current: String = AppInfo.version) async -> Outcome {
        guard let url = Self.latestURL(web: web) else { return .failed("The web URL in Settings is not valid.") }
        var request = URLRequest(url: url)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("mesh-menubar/\(current)", forHTTPHeaderField: "User-Agent")
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { return .failed("no HTTP response") }
            guard (200..<300).contains(http.statusCode) else { return .failed("\(url.host ?? "server") answered \(http.statusCode)") }
            let release = try ReleaseInfo.parse(data)
            return release.isNewer(than: current) ? .available(release) : .upToDate(release)
        } catch {
            return .failed((error as NSError).localizedDescription)
        }
    }
}
#endif
