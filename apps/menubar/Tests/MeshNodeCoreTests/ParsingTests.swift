import XCTest
@testable import MeshNodeCore

final class NodeConfigParsingTests: XCTestCase {
    func testParsesWhatSetupWrites() throws {
        let json = """
        {
          "gateway": "https://api.example.com/",
          "nodeId": "node_3f9a1b2c3d4e5f60",
          "nodeToken": "mesh_nt_abc",
          "wallet": "9xQeKf2abcdefHn4kTzAq",
          "models": ["llama3.1:8b", "qwen2.5:14b"],
          "ollama": "http://127.0.0.1:11434/",
          "chip": "Apple M3 Max",
          "ramGb": 64,
          "registeredAt": 1727950000
        }
        """
        let cfg = try NodeConfig.parse(jsonString: json)
        XCTAssertEqual(cfg.gateway, "https://api.example.com")
        XCTAssertEqual(cfg.ollama, "http://127.0.0.1:11434")
        XCTAssertEqual(cfg.models, ["llama3.1:8b", "qwen2.5:14b"])
        XCTAssertEqual(cfg.chip, "Apple M3 Max")
        XCTAssertEqual(cfg.ramGb, 64)
        XCTAssertEqual(cfg.registeredAt, 1_727_950_000)
        XCTAssertEqual(cfg.shortNodeId, "node_3f9a\u{2026}5f60")
        XCTAssertEqual(cfg.shortWallet, "9xQe\u{2026}TzAq")
    }

    func testDefaultsForOptionalFields() throws {
        let cfg = try NodeConfig.parse(jsonString: #"{"gateway":"http://localhost:8787","nodeId":"n","nodeToken":"t","wallet":"w"}"#)
        XCTAssertEqual(cfg.models, [])
        XCTAssertEqual(cfg.ollama, NodeConfig.defaultOllama)
        XCTAssertEqual(cfg.chip, "unknown")
        XCTAssertEqual(cfg.ramGb, 0)
        XCTAssertEqual(cfg.shortNodeId, "n")
    }

    func testNumericStringsAreAccepted() throws {
        let cfg = try NodeConfig.parse(jsonString: #"{"gateway":"g","nodeId":"n","nodeToken":"t","wallet":"w","ramGb":"32"}"#)
        XCTAssertEqual(cfg.ramGb, 32)
    }

    func testIncompleteConfigNamesMissingFields() {
        XCTAssertThrowsError(try NodeConfig.parse(jsonString: #"{"gateway":"g","nodeId":"n"}"#)) { error in
            XCTAssertEqual(error as? NodeConfigError, .incomplete(missing: ["nodeToken", "wallet"]))
        }
    }

    func testNotJSON() {
        XCTAssertThrowsError(try NodeConfig.parse(jsonString: "nope")) { error in
            XCTAssertEqual(error as? NodeConfigError, .notJSON)
        }
    }
}

final class NodeStatsParsingTests: XCTestCase {
    func testParsesFullGatewayAnswer() throws {
        let json = """
        {
          "nodeId": "node_3f9a", "status": "busy", "online": true,
          "uptimePct24h": 98.3, "jobs24h": 1284, "jobsDone24h": 1280, "jobsFailed24h": 4,
          "tokens24h": 1234567, "earnedUsd24h": 0.0741, "earnedUsdTotal": 12.5,
          "reputation": {"jobs": 100, "successRate": 0.99, "avgFirstTokenMs": 420, "eligible": true, "window": 100, "minSuccessRate": 0.8},
          "models": ["llama3.1:8b"], "chip": "M3 Max", "ramGb": 64, "loadAvg": 1.7,
          "agentVersion": "0.3.0", "lastSeen": 1727950000, "createdAt": 1727000000
        }
        """
        let s = try NodeStats.parse(jsonString: json)
        XCTAssertEqual(s.state, .busy)
        XCTAssertTrue(s.online)
        XCTAssertEqual(s.uptimePct24h, 98.3)
        XCTAssertEqual(s.jobs24h, 1284)
        XCTAssertEqual(s.jobsFailed24h, 4)
        XCTAssertEqual(s.tokens24h, 1_234_567)
        XCTAssertEqual(s.earnedUsd24h, 0.0741)
        XCTAssertEqual(s.earnedUsdTotal, 12.5)
        XCTAssertEqual(s.models, ["llama3.1:8b"])
        XCTAssertEqual(s.chip, "M3 Max")
        XCTAssertEqual(s.ramGb, 64)
        XCTAssertEqual(s.lastSeen, 1_727_950_000)
        XCTAssertEqual(s.reputation?.jobs, 100)
        XCTAssertEqual(s.reputation?.eligible, true)
    }

    func testMinimalAnswer() throws {
        let s = try NodeStats.parse(jsonString: #"{"status":"idle"}"#)
        XCTAssertEqual(s.state, .idle)
        XCTAssertTrue(s.online)
        XCTAssertNil(s.jobs24h)
        XCTAssertNil(s.lastSeen)
    }

    func testOfflineDefaultsOnlineFalse() throws {
        let s = try NodeStats.parse(jsonString: #"{"status":"offline","lastSeen":null}"#)
        XCTAssertEqual(s.state, .offline)
        XCTAssertFalse(s.online)
        XCTAssertNil(s.lastSeen)
    }

    func testLegacyOnlineWordAndUnknownWord() throws {
        XCTAssertEqual(try NodeStats.parse(jsonString: #"{"status":"online"}"#).state, .idle)
        let odd = try NodeStats.parse(jsonString: #"{"status":"degraded","online":true}"#)
        XCTAssertEqual(odd.state, .unknown)
        XCTAssertEqual(odd.rawStatus, "degraded")
        XCTAssertTrue(odd.online)
    }

    func testMissingStatusFallsBackToOnline() throws {
        let s = try NodeStats.parse(jsonString: #"{"online":false}"#)
        XCTAssertEqual(s.state, .offline)
        XCTAssertThrowsError(try NodeStats.parse(jsonString: #"{"jobs24h":1}"#))
    }

    func testLastSeenInMillisecondsIsNormalised() throws {
        let s = try NodeStats.parse(jsonString: #"{"status":"idle","lastSeen":1727950000000}"#)
        XCTAssertEqual(s.lastSeen, 1_727_950_000)
    }

    func testNotJSON() {
        XCTAssertThrowsError(try NodeStats.parse(Data("<html>".utf8))) { error in
            XCTAssertEqual(error as? NodeStatsError, .notJSON)
        }
    }
}

final class FormatTests: XCTestCase {
    let now = Date(timeIntervalSince1970: 1_800_000_000)

    func testUSD() {
        XCTAssertEqual(Format.usd(0.0741), "$0.0741")
        XCTAssertEqual(Format.usd(12.5, digits: 2), "$12.50")
        XCTAssertEqual(Format.usd(nil), Format.dash)
        XCTAssertEqual(Format.usd(0), "$0.0000")
        XCTAssertEqual(Format.usd(-0.00001), "$0.0000")
    }

    func testInt() {
        XCTAssertEqual(Format.int(1284), "1,284")
        XCTAssertEqual(Format.int(1_234_567), "1,234,567")
        XCTAssertEqual(Format.int(7), "7")
        XCTAssertEqual(Format.int(Int?.none), Format.dash)
        XCTAssertEqual(Format.int(-1200), "-1,200")
    }

    func testPctAndRam() {
        XCTAssertEqual(Format.pct(98.34), "98.3%")
        XCTAssertEqual(Format.pct(nil), Format.dash)
        XCTAssertEqual(Format.ram(64), "64 GB")
        XCTAssertEqual(Format.ram(0), Format.dash)
        XCTAssertEqual(Format.machine(chip: "M3 Max", ramGb: 64), "M3 Max \u{00B7} 64 GB")
        XCTAssertEqual(Format.machine(chip: nil, ramGb: 0), Format.dash)
        XCTAssertEqual(Format.machine(chip: "M1", ramGb: nil), "M1")
    }

    func testAgo() {
        let t = now.timeIntervalSince1970
        XCTAssertEqual(Format.ago(nil, now: now), "never")
        XCTAssertEqual(Format.ago(t - 2, now: now), "just now")
        XCTAssertEqual(Format.ago(t - 42, now: now), "42 s ago")
        XCTAssertEqual(Format.ago(t - 180, now: now), "3 min ago")
        XCTAssertEqual(Format.ago(t - 7200, now: now), "2 h ago")
        XCTAssertEqual(Format.ago(t - 3 * 86400, now: now), "3 d ago")
        XCTAssertEqual(Format.ago((t - 60) * 1000, now: now), "1 min ago", "milliseconds are accepted")
    }

    func testModels() {
        XCTAssertEqual(Format.models(["a", "b"]), "a, b")
        XCTAssertEqual(Format.models([]), Format.dash)
        XCTAssertEqual(Format.models(nil), Format.dash)
    }
}

final class LinkCodeTests: XCTestCase {
    func testNormalize() {
        XCTAssertEqual(LinkCode.normalize("k7qm-2xda"), "K7QM2XDA")
        XCTAssertEqual(LinkCode.normalize(" K7QM 2XDA "), "K7QM2XDA")
        XCTAssertEqual(LinkCode.clip("k7qm-2xda-extra"), "K7QM2XDA")
        XCTAssertEqual(LinkCode.pretty("k7qm2xda"), "K7QM-2XDA")
    }

    func testCheck() {
        XCTAssertEqual(LinkCode.check(""), .empty)
        XCTAssertEqual(LinkCode.check("K7QM"), .tooShort(4))
        XCTAssertEqual(LinkCode.check("K7QM2XDA9"), .tooLong(9))
        XCTAssertEqual(LinkCode.check("K7QM2XDA"), .ok)
        XCTAssertEqual(LinkCode.check("K7OM2XDA"), .suspiciousCharacters(["O"]))
        XCTAssertTrue(LinkCode.isSendable("K7OM2XDA"), "odd characters are still sent; the gateway decides")
        XCTAssertFalse(LinkCode.isSendable("K7QM"))
    }

    func testInstallCommand() {
        XCTAssertEqual(
            InstallCommand.oneLiner(web: "https://app.example.com/", gateway: "https://api.example.com/", code: "k7qm-2xda"),
            "curl -fsSL https://app.example.com/install-node.sh | sh -s -- --link K7QM2XDA --gateway https://api.example.com"
        )
        XCTAssertEqual(
            InstallCommand.oneLiner(web: "https://app.example.com", gateway: "http://localhost:8787", code: nil),
            "curl -fsSL https://app.example.com/install-node.sh | sh -s -- --gateway http://localhost:8787"
        )
        XCTAssertEqual(InstallCommand.setupArguments(code: "k7qm2xda", gateway: " https://api.example.com/ "),
                       ["setup", "--link", "K7QM2XDA", "--gateway", "https://api.example.com"])
        XCTAssertEqual(InstallCommand.setupArguments(code: "K7QM2XDA", gateway: ""), ["setup", "--link", "K7QM2XDA"])
    }
}
