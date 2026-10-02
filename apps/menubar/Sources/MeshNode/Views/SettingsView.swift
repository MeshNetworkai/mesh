#if os(macOS)
import AppKit
import MeshNodeCore
import SwiftUI

/// Web app origin (dashboard + installer), gateway override for new links, launch at login.
struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
    @AppStorage(DefaultsKey.webURL) private var webURL = ""
    @AppStorage(DefaultsKey.gatewayURL) private var gatewayURL = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 6) {
                Eyebrow("Settings")
                Text("Mesh Node")
                    .font(.system(size: 22, weight: .medium))
            }

            field(
                label: "Web app",
                placeholder: Brand.defaultWebURL,
                text: $webURL,
                help: "Where Open dashboard goes (\(Brand.dashboardPath)) and where the installer is fetched from."
            )

            field(
                label: "Gateway for new links",
                placeholder: model.config?.gateway ?? NodeConfig.defaultGateway,
                text: $gatewayURL,
                help: "Leave empty to keep the gateway in \(MeshPaths.homeForDisplay)/config.json. Only used by Link this Mac."
            )

            VStack(alignment: .leading, spacing: 6) {
                Toggle(isOn: Binding(
                    get: { model.launchAtLogin },
                    set: { model.setLaunchAtLogin($0) }
                )) {
                    Text("Launch Mesh Node at login").font(TypeScale.body)
                }
                .toggleStyle(.switch)
                .controlSize(.small)
                .disabled(!LaunchAtLogin.isAvailable)
                Text(LaunchAtLogin.isAvailable
                     ? "The node agent itself is separate: it runs under launchd (xyz.mesh.node) whether or not this app is open."
                     : "Needs the built .app (make app); not available under swift run.")
                    .font(TypeScale.small)
                    .foregroundStyle(Color.meshMuted)
                    .fixedSize(horizontal: false, vertical: true)
                if LaunchAtLogin.requiresApproval {
                    Button("Open Login Items") { LaunchAtLogin.openLoginItemsSettings() }
                        .buttonStyle(SecondaryButtonStyle())
                }
            }

            Spacer(minLength: 0)

            HStack {
                Text("Mesh Node \(AppInfo.version) \u{00B7} data in \(MeshPaths.homeForDisplay)")
                    .font(TypeScale.small)
                    .foregroundStyle(Color.meshMuted)
                Spacer()
                Button("Reveal config") {
                    NSWorkspace.shared.activateFileViewerSelecting([MeshPaths.config])
                }
                .buttonStyle(SecondaryButtonStyle())
                .disabled(model.config == nil)
            }
        }
        .padding(24)
        .frame(minWidth: 400, minHeight: 280, alignment: .topLeading)
    }

    private func field(label: String, placeholder: String, text: Binding<String>, help: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Eyebrow(label)
            TextField(placeholder, text: text)
                .textFieldStyle(.plain)
                .font(TypeScale.code)
                .disableAutocorrection(true)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .strokeBorder(Color.meshLine, lineWidth: 1)
                )
            Text(help)
                .font(TypeScale.small)
                .foregroundStyle(Color.meshMuted)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}
#endif
