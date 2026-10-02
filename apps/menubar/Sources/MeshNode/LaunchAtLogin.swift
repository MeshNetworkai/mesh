#if os(macOS)
import Foundation
import ServiceManagement

/// Launch-at-login for the menu-bar app itself via SMAppService (macOS 13+). This is separate from
/// the node agent's launchd job (`xyz.mesh.node`), which `mesh-node service install` owns.
enum LaunchAtLogin {
    /// SMAppService needs a real .app bundle with a bundle identifier; `swift run` has neither.
    static var isAvailable: Bool { AppInfo.isBundled }

    static var isEnabled: Bool {
        guard isAvailable else { return false }
        return SMAppService.mainApp.status == .enabled
    }

    /// `requiresApproval` means the user has to flip it in System Settings > General > Login Items.
    static var requiresApproval: Bool {
        guard isAvailable else { return false }
        return SMAppService.mainApp.status == .requiresApproval
    }

    static func set(enabled: Bool) throws {
        guard isAvailable else { return }
        if enabled {
            try SMAppService.mainApp.register()
        } else {
            try SMAppService.mainApp.unregister()
        }
    }

    static func openLoginItemsSettings() {
        SMAppService.openSystemSettingsLoginItems()
    }
}
#endif
