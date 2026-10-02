#if os(macOS)
import AppKit
import MeshNodeCore
import SwiftUI

/// First-run window. With the agent installed it runs `mesh-node setup --link <code>` and
/// `mesh-node service install`; without it, it shows the install one-liner to paste in Terminal.
struct LinkView: View {
    @ObservedObject private var model: AppModel
    /// Observed separately: changes inside the nested runner do not bump `model.objectWillChange`.
    @ObservedObject private var runner: AgentRunner

    @State private var code = ""
    @State private var gateway = ""
    @State private var phase: Phase = .idle
    @State private var copied = false
    @FocusState private var codeFocused: Bool

    enum Phase: Equatable {
        case idle
        case running
        case done
        case failed
    }

    init(model: AppModel) {
        _model = ObservedObject(wrappedValue: model)
        _runner = ObservedObject(wrappedValue: model.runner)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 6) {
                Eyebrow("Run a node")
                Text("Link this Mac")
                    .font(.system(size: 22, weight: .medium))
                Text("Open the Mesh app, go to Run a node, click Link a Mac and paste the 8-character code. Your wallet signs in the browser; this Mac never holds a key. Codes last 15 minutes.")
                    .font(TypeScale.body)
                    .foregroundStyle(Color.meshFg2)
                    .fixedSize(horizontal: false, vertical: true)
            }

            codeField

            gatewayField

            if model.agentInstalled {
                installedFlow
            } else {
                notInstalledFlow
            }

            Spacer(minLength: 0)
        }
        .padding(24)
        .frame(minWidth: 440, minHeight: 480, alignment: .topLeading)
        .onAppear {
            if gateway.isEmpty { gateway = model.gatewayForLinking }
            codeFocused = true
            Task { await model.refresh() }
        }
    }

    // MARK: fields

    private var codeField: some View {
        VStack(alignment: .leading, spacing: 6) {
            Eyebrow("Link code")
            TextField("K7QM 2XDA", text: $code)
                .textFieldStyle(.plain)
                .font(TypeScale.codeInput)
                .focused($codeFocused)
                .disableAutocorrection(true)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .background(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .strokeBorder(codeFocused ? Color.primary : Color.meshLine, lineWidth: 1)
                )
                .onChange(of: code) { newValue in
                    let clipped = LinkCode.clip(newValue)
                    if clipped != newValue { code = clipped }
                }
                .onSubmit { if canLink { startLink() } }
            Text(codeHint)
                .font(TypeScale.small)
                .foregroundStyle(codeHintIsWarning ? Color(nsColor: Theme.warn) : Color.meshMuted)
                .frame(minHeight: 14, alignment: .leading)
        }
    }

    private var codeHint: String {
        switch LinkCode.check(code) {
        case .empty: return "Letters and digits; case and dashes do not matter."
        case .tooShort(let n): return "\(n) of 8 characters."
        case .tooLong: return "Too long."
        case .suspiciousCharacters(let chars):
            return "Codes never contain \(chars.map(String.init).joined(separator: ", ")). Check for 0/O or 1/I mix-ups."
        case .ok: return "Looks good: \(LinkCode.pretty(code))"
        }
    }

    private var codeHintIsWarning: Bool {
        if case .suspiciousCharacters = LinkCode.check(code) { return true }
        return false
    }

    private var gatewayField: some View {
        VStack(alignment: .leading, spacing: 6) {
            Eyebrow("Gateway")
            TextField("https://api.example.com", text: $gateway)
                .textFieldStyle(.plain)
                .font(TypeScale.code)
                .disableAutocorrection(true)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .strokeBorder(Color.meshLine, lineWidth: 1)
                )
        }
    }

    // MARK: agent present

    private var canLink: Bool {
        LinkCode.isSendable(code) && !runner.isRunning
    }

    private var installedFlow: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Button(phase == .running ? "Linking" : "Link and start serving") { startLink() }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(!canLink || phase == .running)
                    .keyboardShortcut(.defaultAction)
                if phase == .running {
                    Button("Cancel") { runner.cancel() }
                        .buttonStyle(SecondaryButtonStyle())
                }
                if phase == .done {
                    Button("Close") { Windows.closeLink() }
                        .buttonStyle(SecondaryButtonStyle())
                }
                Spacer()
                Text("mesh-node found at \(MeshPaths.homeForDisplay)/bin")
                    .font(TypeScale.small)
                    .foregroundStyle(Color.meshMuted)
            }

            if phase == .done {
                Text("Linked. The node runs in the background and starts at login. You can close this window.")
                    .font(TypeScale.body)
                    .foregroundStyle(Color.meshAccent)
                    .fixedSize(horizontal: false, vertical: true)
            } else if phase == .failed {
                Text("Setup did not finish. The output below says why; a used or expired code needs a fresh one from the web app.")
                    .font(TypeScale.body)
                    .foregroundStyle(Color.meshBad)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if !runner.output.isEmpty {
                OutputLog(text: runner.output)
                    .frame(minHeight: 140, maxHeight: .infinity)
            }
        }
    }

    private func startLink() {
        guard canLink else { return }
        phase = .running
        let c = code
        let g = gateway
        Task {
            let ok = await model.link(code: c, gateway: g)
            phase = ok ? .done : .failed
            if ok {
                UserDefaults.standard.set(true, forKey: DefaultsKey.suppressedFirstRun)
            }
        }
    }

    // MARK: agent missing

    private var oneLiner: String {
        InstallCommand.oneLiner(web: model.webURL, gateway: gateway, code: code.isEmpty ? nil : code)
    }

    private var notInstalledFlow: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("The node agent is not installed yet (\(MeshPaths.homeForDisplay)/bin/mesh-node is missing). Paste this in Terminal; it installs Node and Ollama if needed, links the Mac with the code above and starts the background service. This window updates on its own when it finishes.")
                .font(TypeScale.body)
                .foregroundStyle(Color.meshFg2)
                .fixedSize(horizontal: false, vertical: true)

            HStack(alignment: .top, spacing: 8) {
                Text(oneLiner)
                    .font(TypeScale.code)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button(copied ? "Copied" : "Copy") {
                    let pb = NSPasteboard.general
                    pb.clearContents()
                    pb.setString(oneLiner, forType: .string)
                    copied = true
                    Task {
                        try? await Task.sleep(for: .seconds(1.5))
                        copied = false
                    }
                }
                .buttonStyle(SecondaryButtonStyle())
            }
            .padding(12)
            .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color.meshBg2))

            HStack(spacing: 10) {
                Button("Open Terminal") {
                    if let url = URL(string: "file:///System/Applications/Utilities/Terminal.app") {
                        NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration())
                    }
                }
                .buttonStyle(SecondaryButtonStyle())
                Button("Check again") { Task { await model.refresh() } }
                    .buttonStyle(SecondaryButtonStyle())
                Spacer()
                Text("Web app: \(model.webURL)")
                    .font(TypeScale.small)
                    .foregroundStyle(Color.meshMuted)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
    }
}

/// Mono, selectable, auto-scrolling output of the agent.
struct OutputLog: View {
    let text: String

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                Text(text)
                    .font(TypeScale.code)
                    .foregroundStyle(Color.meshFg2)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                Color.clear.frame(height: 1).id("end")
            }
            .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color.meshBg2))
            .onChange(of: text) { _ in
                withAnimation(.linear(duration: 0.1)) { proxy.scrollTo("end", anchor: .bottom) }
            }
        }
    }
}
#endif
