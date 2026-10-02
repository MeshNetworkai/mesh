#if os(macOS)
import Foundation

/// Runs `~/.mesh/bin/mesh-node <args>` and streams its merged stdout/stderr into `output`.
/// One process at a time; the Link sheet observes it.
@MainActor
final class AgentRunner: ObservableObject {
    @Published private(set) var output: String = ""
    @Published private(set) var isRunning = false
    @Published private(set) var lastExitCode: Int32?

    private var process: Process?

    func clear() {
        output = ""
        lastExitCode = nil
    }

    /// Resolves with the exit status (-1 when the process could not be started).
    @discardableResult
    func run(_ arguments: [String]) async -> Int32 {
        guard !isRunning else { return -1 }
        let binary = MeshPaths.agentBinary
        guard FileManager.default.isExecutableFile(atPath: binary.path) else {
            append("mesh-node is not installed at \(binary.path)\n")
            lastExitCode = -1
            return -1
        }

        let process = Process()
        process.executableURL = binary
        process.arguments = arguments
        process.environment = Self.environment()
        process.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        process.standardInput = FileHandle.nullDevice

        append("$ mesh-node \(arguments.joined(separator: " "))\n")
        isRunning = true
        lastExitCode = nil

        do {
            try process.run()
        } catch {
            append("could not start mesh-node: \(error.localizedDescription)\n")
            isRunning = false
            lastExitCode = -1
            return -1
        }
        self.process = process

        // Reading on the main actor is fine: `bytes.lines` suspends instead of blocking.
        let handle = pipe.fileHandleForReading
        let reader = Task { [weak self] in
            do {
                for try await line in handle.bytes.lines {
                    self?.append(Self.stripANSI(line) + "\n")
                }
            } catch {
                self?.append("[output closed: \(error.localizedDescription)]\n")
            }
        }

        let code: Int32 = await Task.detached(priority: .utility) {
            process.waitUntilExit()
            return process.terminationStatus
        }.value

        _ = await reader.result
        isRunning = false
        lastExitCode = code
        self.process = nil
        append(code == 0 ? "done (exit 0)\n" : "exited with status \(code)\n")
        return code
    }

    func cancel() {
        guard let process, process.isRunning else { return }
        process.interrupt() // SIGINT: the agent handles it and exits cleanly
        append("[cancelled]\n")
    }

    private func append(_ text: String) {
        output.append(text)
        // Keep the buffer bounded; model pulls can be chatty.
        if output.count > 200_000 {
            output = String(output.suffix(150_000))
        }
    }

    /// PATH covering Homebrew node, plus MESH_HOME when the app runs with an override.
    static func environment() -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        let extra = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
        let current = (env["PATH"] ?? "").split(separator: ":").map(String.init)
        var merged: [String] = []
        for p in extra + current where !merged.contains(p) { merged.append(p) }
        env["PATH"] = merged.joined(separator: ":")
        env["HOME"] = FileManager.default.homeDirectoryForCurrentUser.path
        env["MESH_HOME"] = MeshPaths.home.path
        env["NO_COLOR"] = "1"
        env["TERM"] = "dumb"
        return env
    }

    /// The CLI already honours NO_COLOR, but strip escapes anyway in case a tool it calls does not.
    static func stripANSI(_ s: String) -> String {
        guard s.contains("\u{1B}") else { return s }
        var out = ""
        var i = s.startIndex
        while i < s.endIndex {
            let ch = s[i]
            if ch == "\u{1B}" {
                // CSI ... final byte in 0x40...0x7E
                var j = s.index(after: i)
                if j < s.endIndex, s[j] == "[" {
                    j = s.index(after: j)
                    while j < s.endIndex, let v = s[j].asciiValue, !(0x40...0x7E).contains(v) {
                        j = s.index(after: j)
                    }
                    if j < s.endIndex { j = s.index(after: j) }
                }
                i = j
                continue
            }
            out.append(ch)
            i = s.index(after: i)
        }
        return out
    }
}
#endif
