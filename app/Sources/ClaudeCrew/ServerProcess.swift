import Foundation

@MainActor
final class ServerProcess {
    private var process: Process?
    private let port: Int
    private let projectRoot: String

    init(port: Int = 3140) {
        self.port = port
        // Resolve project root relative to executable or use env
        if let envRoot = ProcessInfo.processInfo.environment["CREW_PROJECT_ROOT"] {
            self.projectRoot = envRoot
        } else {
            // Default: assume binary is in app/.build/release/ or app/.build/debug/
            let execDir = Bundle.main.executablePath.map { URL(fileURLWithPath: $0).deletingLastPathComponent().path } ?? FileManager.default.currentDirectoryPath
            self.projectRoot = URL(fileURLWithPath: execDir).appendingPathComponent("../../..").standardized.path
        }
    }

    func findNodePath() -> String? {
        let explicitPath = ProcessInfo.processInfo.environment["NODE_PATH"]
        let nvmBinPath = ProcessInfo.processInfo.environment["NVM_BIN"].map { "\($0)/node" }
        let nvmVersions = resolvePath("~/.nvm/versions/node")
            .flatMap { findAllNodesIn(dir: $0) } ?? []
        let shellNode = shellWhich("node")
        let candidates = [explicitPath, nvmBinPath]
            + nvmVersions.map(Optional.some)
            + [shellNode, "/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]

        for candidate in candidates {
            guard let p = candidate else { continue }
            if nodeSupportsServer(atPath: p) {
                return p
            }
        }

        for candidate in candidates {
            guard let p = candidate else { continue }
            if FileManager.default.isExecutableFile(atPath: p) {
                return p
            }
        }
        return nil
    }

    func start() throws {
        guard process == nil || process?.isRunning != true else { return }

        guard let nodePath = findNodePath() else {
            throw ServerError.nodeNotFound
        }

        let serverScript = "\(projectRoot)/packages/server/dist/index.js"
        guard FileManager.default.fileExists(atPath: serverScript) else {
            throw ServerError.serverScriptNotFound(serverScript)
        }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: nodePath)
        proc.arguments = [serverScript]

        var env = ProcessInfo.processInfo.environment
        env["CREW_PORT"] = String(port)
        env["NODE_ENV"] = "production"
        env["NODE_PATH"] = nodePath
        proc.environment = env

        proc.currentDirectoryURL = URL(fileURLWithPath: projectRoot)

        // Send server output to log file
        let logDir = "\(projectRoot)/data"
        try FileManager.default.createDirectory(atPath: logDir, withIntermediateDirectories: true)
        let logPath = "\(logDir)/server.log"
        FileManager.default.createFile(atPath: logPath, contents: nil)
        let logHandle = FileHandle(forWritingAtPath: logPath)
        proc.standardOutput = logHandle
        proc.standardError = logHandle

        try proc.run()
        self.process = proc
        NSLog("[ClaudeCrew] Node server started (PID: %d)", proc.processIdentifier)
    }

    func stop() {
        guard let proc = process, proc.isRunning else { return }
        proc.terminate()
        proc.waitUntilExit()
        NSLog("[ClaudeCrew] Node server stopped")
        self.process = nil
    }

    func waitForReady(timeout: TimeInterval = 10) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if await checkHealth() { return true }
            try? await Task.sleep(for: .milliseconds(300))
        }
        return false
    }

    var isRunning: Bool {
        process?.isRunning ?? false
    }

    // MARK: - Private

    private func checkHealth() async -> Bool {
        guard let url = URL(string: "http://127.0.0.1:\(port)/api/status") else { return false }
        do {
            let (_, response) = try await URLSession.shared.data(from: url)
            return (response as? HTTPURLResponse)?.statusCode == 200
        } catch {
            return false
        }
    }

    private func resolvePath(_ path: String) -> String? {
        let expanded = NSString(string: path).expandingTildeInPath
        if FileManager.default.fileExists(atPath: expanded) {
            return expanded
        }
        return nil
    }

    private func findAllNodesIn(dir: String) -> [String] {
        guard let contents = try? FileManager.default.contentsOfDirectory(atPath: dir) else { return [] }
        let sorted = contents.sorted { $0 > $1 }
        var results: [String] = []
        for version in sorted {
            let nodeBin = "\(dir)/\(version)/bin/node"
            if FileManager.default.isExecutableFile(atPath: nodeBin) {
                results.append(nodeBin)
            }
        }
        return results
    }

    private func nodeSupportsServer(atPath path: String) -> Bool {
        guard FileManager.default.isExecutableFile(atPath: path) else { return false }
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: path)
        proc.arguments = ["-e", "require('better-sqlite3')"]
        proc.currentDirectoryURL = URL(fileURLWithPath: projectRoot).appendingPathComponent("packages/server")
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        do {
            try proc.run()
            proc.waitUntilExit()
            return proc.terminationStatus == 0
        } catch {
            return false
        }
    }

    private func shellWhich(_ cmd: String) -> String? {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/bin/sh")
        proc.arguments = ["-l", "-c", "which \(cmd)"]
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = FileHandle.nullDevice
        try? proc.run()
        proc.waitUntilExit()
        guard proc.terminationStatus == 0 else { return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

enum ServerError: LocalizedError {
    case nodeNotFound
    case serverScriptNotFound(String)

    var errorDescription: String? {
        switch self {
        case .nodeNotFound:
            return "Node.js not found. Please install Node.js or set NODE_PATH environment variable."
        case .serverScriptNotFound(let path):
            return "Server script not found at: \(path). Run 'pnpm build' first."
        }
    }
}
