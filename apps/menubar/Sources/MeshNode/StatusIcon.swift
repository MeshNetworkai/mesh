#if os(macOS)
import AppKit
import MeshNodeCore

/// The menu-bar glyph: the Mesh "nodes" mark (a row of five dots, one accented) with the accented
/// dot carrying the status colour. Drawn as a non-template image so the colour survives; the grey
/// dots use the label colour and so follow the menu bar's light/dark appearance.
enum StatusIcon {
    static let size = NSSize(width: 22, height: 16)

    @MainActor private static var cache: [NodeStatus: NSImage] = [:]

    /// Images are drawn lazily per appearance, so one cached instance serves light and dark menus.
    @MainActor
    static func image(for status: NodeStatus) -> NSImage {
        if let cached = cache[status] { return cached }
        let img = render(status)
        cache[status] = img
        return img
    }

    static func render(_ status: NodeStatus) -> NSImage {
        let img = NSImage(size: size, flipped: false) { rect in
            let dotCount = 5
            let small: CGFloat = 3
            let big: CGFloat = 5
            let gap: CGFloat = 1.6
            let totalWidth = small * CGFloat(dotCount - 1) + big + gap * CGFloat(dotCount - 1)
            var x = rect.midX - totalWidth / 2
            let midY = rect.midY
            for i in 0..<dotCount {
                let isStatus = i == 2
                let d = isStatus ? big : small
                let dot = NSRect(x: x, y: midY - d / 2, width: d, height: d)
                let color = isStatus ? Theme.nsColor(for: status) : NSColor.labelColor.withAlphaComponent(0.85)
                color.setFill()
                NSBezierPath(ovalIn: dot).fill()
                x += d + gap
            }
            return true
        }
        img.isTemplate = false
        img.accessibilityDescription = "Mesh node: \(status.rawValue)"
        return img
    }
}
#endif
