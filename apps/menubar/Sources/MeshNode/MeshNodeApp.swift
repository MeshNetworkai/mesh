#if os(macOS)
import AppKit
import MeshNodeCore
import SwiftUI

@main
struct MeshNodeApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var model: AppModel

    init() {
        let model = AppModel()
        _model = StateObject(wrappedValue: model)
        AppDelegate.sharedModel = model
    }

    var body: some Scene {
        MenuBarExtra {
            StatusView()
                .environmentObject(model)
        } label: {
            Image(nsImage: StatusIcon.image(for: model.snapshot.status))
        }
        .menuBarExtraStyle(.window)
    }
}

/// Keeps the app out of the Dock when run without a bundle (`swift run`), starts polling, and opens
/// the Link window on first run.
final class AppDelegate: NSObject, NSApplicationDelegate {
    static var sharedModel: AppModel?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // The .app bundle sets LSUIElement; under `swift run` this does the same job.
        NSApp.setActivationPolicy(.accessory)
        Task { @MainActor in
            guard let model = AppDelegate.sharedModel else { return }
            model.start()
            await model.refresh()
            let suppressed = UserDefaults.standard.bool(forKey: DefaultsKey.suppressedFirstRun)
            if model.config == nil, !suppressed {
                Windows.showLink(model: model)
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        Task { @MainActor in AppDelegate.sharedModel?.stop() }
    }
}

/// The two auxiliary windows.
@MainActor
enum Windows {
    static let linkId = "link"
    static let settingsId = "settings"

    static func showLink(model: AppModel) {
        PanelWindow.shared.show(id: linkId, title: "Link this Mac", size: NSSize(width: 460, height: 520)) {
            LinkView(model: model)
        }
    }

    static func closeLink() {
        PanelWindow.shared.close(id: linkId)
    }

    static func showSettings(model: AppModel) {
        PanelWindow.shared.show(id: settingsId, title: "Mesh Node Settings", size: NSSize(width: 420, height: 300)) {
            SettingsView().environmentObject(model)
        }
    }
}
#else
// Linux / non-macOS: only MeshNodeCore builds and tests. This keeps `swift test` working there.
@main
enum MeshNodeUnsupported {
    static func main() {
        print("MeshNode is a macOS menu-bar app; only the MeshNodeCore library builds on this platform.")
    }
}
#endif
