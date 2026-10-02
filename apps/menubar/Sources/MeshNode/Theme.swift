#if os(macOS)
import AppKit
import MeshNodeCore
import SwiftUI

/// Colours from docs/design-system.html (light / dark pairs). Text is ink on the system window
/// background; green appears only where value moves toward you; status dots carry the state.
enum Theme {
    static let accent = dynamic(light: 0x1F9D66, dark: 0x4FD394)      // --accent
    static let warn = dynamic(light: 0xD9962B, dark: 0xD9962B)        // --warn
    static let bad = dynamic(light: 0xD64545, dark: 0xD64545)         // --bad
    static let faint = dynamic(light: 0xA4ADB9, dark: 0x5D6977)       // --faint
    static let muted = dynamic(light: 0x7B8798, dark: 0x8793A3)       // --muted
    static let fg2 = dynamic(light: 0x4B5563, dark: 0xC2CAD4)         // --fg-2
    static let line = dynamic(light: 0xE6E9EE, dark: 0x1B2432)        // --line
    static let bg2 = dynamic(light: 0xF6F7F9, dark: 0x0D131C)         // --bg-2

    static func nsColor(for status: NodeStatus) -> NSColor {
        switch status {
        case .serving: return accent
        case .idle: return warn
        case .offline: return faint
        case .error: return bad
        }
    }

    static func color(for status: NodeStatus) -> Color {
        Color(nsColor: nsColor(for: status))
    }

    /// An NSColor that resolves per appearance, so one value works in light and dark menus.
    static func dynamic(light: UInt32, dark: UInt32) -> NSColor {
        NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            return NSColor(hex: isDark ? dark : light)
        }
    }
}

extension NSColor {
    convenience init(hex: UInt32) {
        self.init(
            srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: 1
        )
    }
}

extension Color {
    static let meshAccent = Color(nsColor: Theme.accent)
    static let meshMuted = Color(nsColor: Theme.muted)
    static let meshFg2 = Color(nsColor: Theme.fg2)
    static let meshLine = Color(nsColor: Theme.line)
    static let meshBg2 = Color(nsColor: Theme.bg2)
    static let meshBad = Color(nsColor: Theme.bad)
}

/// Type scale: system font (SF) standing in for Onest/Inter/JetBrains Mono, same restraint.
enum TypeScale {
    /// Mono eyebrow: 10pt, wide tracking, uppercase (the design system's 11px eyebrow, menu-sized).
    static let eyebrow = Font.system(size: 10, weight: .medium, design: .monospaced)
    static let headline = Font.system(size: 15, weight: .medium)
    static let body = Font.system(size: 12)
    static let small = Font.system(size: 11)
    static let value = Font.system(size: 12, weight: .medium, design: .monospaced)
    static let big = Font.system(size: 26, weight: .light)
    static let code = Font.system(size: 11, design: .monospaced)
    static let codeInput = Font.system(size: 22, weight: .regular, design: .monospaced)
}
#endif
