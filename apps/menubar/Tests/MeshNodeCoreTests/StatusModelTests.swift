import XCTest
@testable import MeshNodeCore

final class StatusModelTests: XCTestCase {
    private let config = NodeConfig(gateway: "https://api.example.com/", nodeId: "node_3f9a1b2c3d4e", nodeToken: "mesh_nt_x", wallet: "7xKq")
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    func testNotLinkedIsOffline() {
        let s = StatusModel.derive(config: nil, stats: nil, paused: false, failure: nil, now: now)
        XCTAssertEqual(s.status, .offline)
        XCTAssertEqual(s.headline, "Not linked")
    }

    func testCheckingBeforeFirstAnswer() {
        let s = StatusModel.derive(config: config, stats: nil, paused: false, failure: nil, now: now)
        XCTAssertEqual(s.status, .offline)
        XCTAssertEqual(s.headline, "Checking")
    }

    func testIdleOnlineIsServingGreen() {
        let stats = NodeStats(state: .idle)
        let s = StatusModel.derive(config: config, stats: stats, paused: false, failure: nil, now: now)
        XCTAssertEqual(s.status, .serving)
        XCTAssertEqual(s.headline, "Serving")
        XCTAssertTrue(s.detail.contains("waiting"))
    }

    func testBusyIsServing() {
        let s = StatusModel.derive(config: config, stats: NodeStats(state: .busy), paused: false, failure: nil, now: now)
        XCTAssertEqual(s.status, .serving)
        XCTAssertTrue(s.detail.contains("Running"))
    }

    func testPausedOnlineIsAmberIdle() {
        let s = StatusModel.derive(config: config, stats: NodeStats(state: .idle), paused: true, failure: nil, now: now)
        XCTAssertEqual(s.status, .idle)
        XCTAssertEqual(s.headline, "Paused")
    }

    func testPausedButOfflineStaysOffline() {
        // The pause flag only matters while the agent is actually alive.
        let s = StatusModel.derive(config: config, stats: NodeStats(state: .offline), paused: true, failure: nil, now: now)
        XCTAssertEqual(s.status, .offline)
        XCTAssertEqual(s.headline, "Offline")
    }

    func testOfflineMentionsLastHeartbeat() {
        let stats = NodeStats(state: .offline, lastSeen: now.timeIntervalSince1970 - 7200)
        let s = StatusModel.derive(config: config, stats: stats, paused: false, failure: nil, now: now)
        XCTAssertEqual(s.status, .offline)
        XCTAssertTrue(s.detail.contains("2 h ago"), s.detail)
    }

    func testOfflineNeverSeen() {
        let s = StatusModel.derive(config: config, stats: NodeStats(state: .offline), paused: false, failure: nil, now: now)
        XCTAssertTrue(s.detail.contains("never checked in"), s.detail)
    }

    func testOnlineFalseOverridesStatusWord() {
        let stats = NodeStats(state: .idle, online: false)
        let s = StatusModel.derive(config: config, stats: stats, paused: false, failure: nil, now: now)
        XCTAssertEqual(s.status, .offline)
    }

    func testNetworkFailureIsRedAndNamesHost() {
        let s = StatusModel.derive(config: config, stats: NodeStats(state: .idle), paused: false, failure: .network("timed out"), now: now)
        XCTAssertEqual(s.status, .error)
        XCTAssertEqual(s.headline, "Unreachable")
        XCTAssertTrue(s.detail.contains("api.example.com"), s.detail)
        XCTAssertTrue(s.detail.contains("timed out"))
    }

    func testAuthFailureAsksToRelink() {
        let s = StatusModel.derive(config: config, stats: nil, paused: false, failure: .http(status: 401, code: "unauthorized"), now: now)
        XCTAssertEqual(s.status, .error)
        XCTAssertEqual(s.headline, "Not recognised")
        XCTAssertTrue(s.detail.contains("unauthorized"))
        XCTAssertTrue(PollFailure.http(status: 404, code: nil).isAuth)
        XCTAssertFalse(PollFailure.http(status: 500, code: nil).isAuth)
    }

    func testServerErrorIsRed() {
        let s = StatusModel.derive(config: config, stats: nil, paused: false, failure: .http(status: 503, code: nil), now: now)
        XCTAssertEqual(s.status, .error)
        XCTAssertEqual(s.headline, "Gateway error")
        XCTAssertTrue(s.detail.contains("503"))
    }

    func testFailureWinsOverStaleStats() {
        // Stale "busy" stats must not keep the icon green while the gateway is unreachable.
        let s = StatusModel.derive(config: config, stats: NodeStats(state: .busy), paused: false, failure: .decode("not JSON"), now: now)
        XCTAssertEqual(s.status, .error)
    }

    func testUnknownStatusWordStillServing() {
        let stats = NodeStats(state: .unknown, rawStatus: "degraded", online: true)
        let s = StatusModel.derive(config: config, stats: stats, paused: false, failure: nil, now: now)
        XCTAssertEqual(s.status, .serving)
        XCTAssertTrue(s.detail.contains("degraded"))
    }

    func testHostOnly() {
        XCTAssertEqual(StatusModel.hostOnly("https://api.example.com/x/y"), "api.example.com")
        XCTAssertEqual(StatusModel.hostOnly("http://localhost:8787"), "localhost:8787")
        XCTAssertEqual(StatusModel.hostOnly("not a url"), "not a url")
    }
}
