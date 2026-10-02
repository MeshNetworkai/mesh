#if os(macOS)
import MeshNodeCore
import SwiftUI

/// The popover under the menu-bar icon.
struct StatusView: View {
    @EnvironmentObject private var model: AppModel
    @State private var now = Date()

    private let tick = Timer.publish(every: 5, on: .main, in: .common).autoconnect()

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
                .padding(.horizontal, 16)
                .padding(.top, 14)
                .padding(.bottom, 12)

            Hairline()

            if model.config != nil {
                statsBlock
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                Hairline()
            } else {
                notLinkedBlock
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                Hairline()
            }

            actions
                .padding(.horizontal, 10)
                .padding(.vertical, 8)

            Hairline()

            footer
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
        }
        .frame(width: 320)
        .onReceive(tick) { now = $0 }
        .onAppear {
            now = Date()
            Task { await model.refresh() }
        }
    }

    // MARK: header

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Circle()
                .fill(Theme.color(for: model.snapshot.status))
                .frame(width: 8, height: 8)
                .alignmentGuide(.firstTextBaseline) { d in d[VerticalAlignment.center] + 4 }
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline) {
                    Text(model.snapshot.headline)
                        .font(TypeScale.headline)
                    Spacer()
                    if let cfg = model.config {
                        Text(cfg.shortNodeId)
                            .font(TypeScale.code)
                            .foregroundStyle(Color.meshMuted)
                            .help(cfg.nodeId)
                    }
                }
                Text(model.snapshot.detail)
                    .font(TypeScale.small)
                    .foregroundStyle(Color.meshFg2)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: stats

    private var statsBlock: some View {
        let s = model.stats
        let cfg = model.config
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 16) {
                Tile(label: "Earned 24h", value: Format.usd(s?.earnedUsd24h), accent: (s?.earnedUsd24h ?? 0) > 0)
                Tile(label: "Earned total", value: Format.usd(s?.earnedUsdTotal), accent: false)
            }
            .padding(.bottom, 2)

            StatRow(label: "Jobs 24h", value: jobsText(s))
            StatRow(label: "Uptime 24h", value: Format.pct(s?.uptimePct24h))
            StatRow(label: "Last seen", value: Format.ago(s?.lastSeen, now: now))
            StatRow(label: "Machine", value: Format.machine(chip: s?.chip ?? cfg?.chip, ramGb: s?.ramGb ?? cfg?.ramGb))
            StatRow(label: "Models", value: Format.models(s?.models ?? cfg?.models), wraps: true)
        }
    }

    private func jobsText(_ s: NodeStats?) -> String {
        let total = Format.int(s?.jobs24h)
        if let failed = s?.jobsFailed24h, failed > 0 {
            return "\(total)  \u{00B7}  \(failed) failed"
        }
        return total
    }

    private var notLinkedBlock: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("This Mac is not serving yet. Link it with the code from the Mesh app (Run a node, then Link a Mac). Your wallet signs in the browser; this Mac never holds a key.")
                .font(TypeScale.small)
                .foregroundStyle(Color.meshFg2)
                .fixedSize(horizontal: false, vertical: true)
            Button("Link this Mac") { Windows.showLink(model: model) }
                .buttonStyle(PrimaryButtonStyle())
        }
    }

    // MARK: actions

    private var actions: some View {
        VStack(spacing: 0) {
            if model.config != nil {
                RowButton(
                    title: model.paused ? "Resume" : "Pause",
                    subtitle: model.paused ? "Take jobs again" : "Stop taking jobs after the current one",
                    shortcut: "P"
                ) { model.togglePause() }
                .keyboardShortcut("p", modifiers: .command)
            }
            RowButton(title: "Open dashboard", subtitle: nil, shortcut: "D") { model.openDashboard() }
                .keyboardShortcut("d", modifiers: .command)
            RowButton(title: "View logs", subtitle: nil, shortcut: "L") { model.openLogs() }
                .keyboardShortcut("l", modifiers: .command)
            RowButton(title: model.config == nil ? "Link this Mac" : "Re-link this Mac", subtitle: nil, shortcut: nil) {
                Windows.showLink(model: model)
            }
            RowButton(title: "Settings", subtitle: nil, shortcut: ",") { Windows.showSettings(model: model) }
                .keyboardShortcut(",", modifiers: .command)
        }
    }

    // MARK: footer

    private var footer: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let err = model.actionError {
                HStack(alignment: .top, spacing: 8) {
                    Text(err)
                        .font(TypeScale.small)
                        .foregroundStyle(Color.meshBad)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 4)
                    Button("Dismiss") { model.actionError = nil }
                        .buttonStyle(.plain)
                        .font(TypeScale.small)
                        .foregroundStyle(Color.meshMuted)
                }
            }
            HStack(spacing: 10) {
                Toggle(isOn: Binding(
                    get: { model.launchAtLogin },
                    set: { model.setLaunchAtLogin($0) }
                )) {
                    Text("Launch at login")
                        .font(TypeScale.small)
                        .foregroundStyle(LaunchAtLogin.isAvailable ? Color.meshFg2 : Color.meshMuted)
                }
                .toggleStyle(.switch)
                .controlSize(.mini)
                .disabled(!LaunchAtLogin.isAvailable)
                .help(LaunchAtLogin.isAvailable ? "Start Mesh Node when you log in" : "Available when running from the built .app (make app)")

                Spacer()

                Text(model.isRefreshing ? "Updating" : "Updated \(Format.shortAgo(model.lastUpdated, now: now)) ago")
                    .font(TypeScale.small)
                    .foregroundStyle(Color.meshMuted)
                    .monospacedDigit()

                Button("Quit") { model.quit() }
                    .buttonStyle(.plain)
                    .font(TypeScale.small)
                    .foregroundStyle(Color.meshFg2)
                    .keyboardShortcut("q", modifiers: .command)
            }
        }
    }
}

// MARK: - pieces

/// 1pt rule in the design system's --line colour.
struct Hairline: View {
    var body: some View {
        Rectangle()
            .fill(Color.meshLine)
            .frame(height: 1)
    }
}

/// Mono eyebrow over a light display number (the dashboard tile, menu-sized).
struct Tile: View {
    let label: String
    let value: String
    let accent: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Eyebrow(label)
            Text(value)
                .font(TypeScale.big)
                .monospacedDigit()
                .foregroundStyle(accent ? Color.meshAccent : Color.primary)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct Eyebrow: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text.uppercased())
            .font(TypeScale.eyebrow)
            .tracking(1.4)
            .foregroundStyle(Color.meshMuted)
    }
}

/// Label left, mono value right. `wraps` lets long model lists break onto more lines.
struct StatRow: View {
    let label: String
    let value: String
    var wraps = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(label)
                .font(TypeScale.body)
                .foregroundStyle(Color.meshFg2)
            Spacer(minLength: 8)
            Text(value)
                .font(TypeScale.value)
                .monospacedDigit()
                .foregroundStyle(Color.primary)
                .multilineTextAlignment(.trailing)
                .lineLimit(wraps ? 4 : 1)
                .fixedSize(horizontal: false, vertical: wraps)
        }
    }
}

/// Menu-like full-width row with a hover highlight; the shortcut hint sits on the right.
struct RowButton: View {
    let title: String
    let subtitle: String?
    let shortcut: String?
    let action: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(title).font(TypeScale.body).foregroundStyle(Color.primary)
                    if let subtitle {
                        Text(subtitle).font(TypeScale.small).foregroundStyle(Color.meshMuted)
                    }
                }
                Spacer()
                if let shortcut {
                    Text("\u{2318}\(shortcut)")
                        .font(TypeScale.small)
                        .foregroundStyle(Color.meshMuted)
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(hovering ? Color.primary.opacity(0.06) : Color.clear)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
    }
}

/// The design system's primary button: ink fill, white text, pill radius. System font.
struct PrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(Color(nsColor: .windowBackgroundColor))
            .padding(.horizontal, 14)
            .padding(.vertical, 7)
            .background(Capsule().fill(Color.primary.opacity(configuration.isPressed ? 0.75 : 1)))
    }
}

/// Secondary: transparent, hairline border.
struct SecondaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(Color.primary)
            .padding(.horizontal, 14)
            .padding(.vertical, 7)
            .background(Capsule().strokeBorder(Color.meshLine, lineWidth: 1))
            .opacity(configuration.isPressed ? 0.6 : 1)
    }
}
#endif
