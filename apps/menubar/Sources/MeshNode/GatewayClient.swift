#if os(macOS)
import Foundation
import MeshNodeCore

/// `GET /nodes/:id` with the node token as bearer. One call, 15 s timeout, no caching.
struct GatewayClient {
    private let session: URLSession

    init() {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 15
        cfg.timeoutIntervalForResource = 20
        cfg.waitsForConnectivity = false
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        session = URLSession(configuration: cfg)
    }

    enum Outcome {
        case stats(NodeStats)
        case failure(PollFailure)
    }

    func fetchStats(for config: NodeConfig) async -> Outcome {
        let encodedId = config.nodeId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? config.nodeId
        guard let url = URL(string: "\(config.gateway)/nodes/\(encodedId)") else {
            return .failure(.network("invalid gateway URL \(config.gateway)"))
        }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(config.nodeToken)", forHTTPHeaderField: "Authorization")
        request.setValue("mesh-menubar/\(AppInfo.version)", forHTTPHeaderField: "User-Agent")

        let result: (Data, URLResponse)
        do {
            result = try await session.data(for: request)
        } catch {
            return .failure(.network(Self.describe(error)))
        }
        let (data, response) = result
        guard let http = response as? HTTPURLResponse else {
            return .failure(.network("no HTTP response"))
        }
        guard (200..<300).contains(http.statusCode) else {
            return .failure(.http(status: http.statusCode, code: Self.errorCode(in: data)))
        }
        do {
            return .stats(try NodeStats.parse(data))
        } catch {
            return .failure(.decode(error.localizedDescription))
        }
    }

    /// Gateway errors are `{error, message, statusCode, requestId}`.
    private static func errorCode(in data: Data) -> String? {
        guard let any = try? JSONSerialization.jsonObject(with: data),
              let dict = any as? [String: Any] else { return nil }
        if let s = dict["error"] as? String { return s }
        if let e = dict["error"] as? [String: Any], let c = e["code"] as? String { return c }
        return nil
    }

    private static func describe(_ error: Error) -> String {
        let ns = error as NSError
        if ns.domain == NSURLErrorDomain {
            switch ns.code {
            case NSURLErrorTimedOut: return "timed out"
            case NSURLErrorCannotConnectToHost: return "connection refused"
            case NSURLErrorCannotFindHost: return "host not found"
            case NSURLErrorNotConnectedToInternet: return "no internet connection"
            case NSURLErrorSecureConnectionFailed, NSURLErrorServerCertificateUntrusted: return "TLS failed"
            case NSURLErrorAppTransportSecurityRequiresSecureConnection: return "blocked by App Transport Security (plain http gateway)"
            default: break
            }
        }
        return ns.localizedDescription
    }
}

enum AppInfo {
    static var version: String {
        (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "dev"
    }
    static var isBundled: Bool {
        Bundle.main.bundleURL.pathExtension == "app" && Bundle.main.bundleIdentifier != nil
    }
}
#endif
