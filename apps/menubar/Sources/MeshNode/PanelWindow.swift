#if os(macOS)
import AppKit
import SwiftUI

/// Hosts a SwiftUI view in a plain titled window. Menu-bar apps have no main window, so the Link
/// sheet and Settings live here; one window per id, re-shown rather than re-created.
@MainActor
final class PanelWindow {
    static let shared = PanelWindow()

    private var windows: [String: NSWindow] = [:]

    func show<Content: View>(id: String, title: String, size: NSSize, @ViewBuilder content: () -> Content) {
        if let existing = windows[id] {
            existing.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        let hosting = NSHostingController(rootView: content())
        let window = NSWindow(contentViewController: hosting)
        window.title = title
        window.styleMask = [.titled, .closable, .miniaturizable]
        window.titlebarAppearsTransparent = true
        window.isReleasedWhenClosed = false
        window.setContentSize(size)
        window.center()
        window.isMovableByWindowBackground = true
        windows[id] = window
        NotificationCenter.default.addObserver(
            forName: NSWindow.willCloseNotification, object: window, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.windows[id] = nil }
        }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func close(id: String) {
        windows[id]?.close()
    }
}
#endif
