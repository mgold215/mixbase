import Foundation

// Two ways in, one set of commands (AX.swift):
//
//  - LocalServer: a socket in the helper's own folder, readable by this user
//    only. It is how a person or a script on this Mac tries a command against
//    Logic (scripts/intern-ax.mjs). It never hands out the access token.
//  - Worker: the node process the helper starts itself (the job loop). It asks
//    over its own stdout/stdin, and may ask for the access token.
//
// Both speak one JSON object per line: {"id":1,"cmd":"ping"} -> {"id":1,"ok":true,"result":{…}}

func answer(_ line: Data, allowAuth: Bool) -> Data {
    var reply: [String: Any]
    if let cmd = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] {
        reply = AXBridge.shared.run(cmd, allowAuth: allowAuth)
        if let id = cmd["id"] { reply["id"] = id }
    } else {
        reply = ["ok": false, "error": "Not a JSON object"]
    }
    var out = (try? JSONSerialization.data(withJSONObject: reply, options: [.withoutEscapingSlashes])) ?? Data("{\"ok\":false}".utf8)
    out.append(0x0A)
    return out
}

final class LocalServer {
    private var fd: Int32 = -1

    func start() {
        let path = Paths.socket
        unlink(path)
        fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { Log.write("socket: could not create"); return }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else { Log.write("socket: path too long"); return }
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in
            for (i, b) in bytes.enumerated() { raw[i] = b }
        }
        let size = socklen_t(MemoryLayout<sockaddr_un>.size)
        let bound = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, size) } }
        guard bound == 0 else { Log.write("socket: bind failed \(errno)"); return }
        chmod(path, 0o600)
        guard listen(fd, 8) == 0 else { Log.write("socket: listen failed"); return }
        Thread.detachNewThread { [fd] in
            while true {
                let client = accept(fd, nil, nil)
                if client < 0 { if errno == EINTR { continue }; break }
                Thread.detachNewThread { LocalServer.serve(client) }
            }
        }
    }

    private static func serve(_ client: Int32) {
        defer { close(client) }
        var noSigPipe: Int32 = 1
        setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))
        var pending = Data()
        var buf = [UInt8](repeating: 0, count: 65536)
        while true {
            let n = read(client, &buf, buf.count)
            if n <= 0 { return }
            pending.append(contentsOf: buf[0..<n])
            while let nl = pending.firstIndex(of: 0x0A) {
                let line = pending.subdata(in: pending.startIndex..<nl)
                pending.removeSubrange(pending.startIndex...nl)
                if line.isEmpty { continue }
                let out = answer(line, allowAuth: false)
                let sent = out.withUnsafeBytes { write(client, $0.baseAddress, out.count) }
                if sent < 0 { return }
            }
        }
    }
}

/// Starts the job loop (node) and keeps it running while the owner is signed in.
final class Worker {
    static let shared = Worker()
    private var process: Process?
    private var wanted = false
    private let queue = DispatchQueue(label: "intern.worker")
    private(set) var lastLine = "Not started"

    private func nodePath() -> String? {
        if let data = try? Data(contentsOf: Paths.config),
           let cfg = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
           let p = cfg["node"] as? String, FileManager.default.isExecutableFile(atPath: p) { return p }
        return ["/opt/homebrew/bin/node", "/usr/local/bin/node"].first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    func start() { queue.async { self.wanted = true; self.launch() } }
    func stop() { queue.async { self.wanted = false; self.process?.terminate(); self.process = nil } }

    private func launch() {
        guard wanted, process == nil else { return }
        let script = Paths.runtime.appendingPathComponent("scripts/intern-worker.mjs")
        guard FileManager.default.fileExists(atPath: script.path) else { lastLine = "The worker is not installed yet"; return }
        guard let node = nodePath() else { lastLine = "node was not found on this Mac"; Log.write(lastLine); return }
        guard Auth.shared.isSignedIn else { lastLine = "Waiting for sign-in"; return }

        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [script.path]
        p.currentDirectoryURL = Paths.runtime
        var env = ProcessInfo.processInfo.environment
        env["INTERN_SUPPORT"] = Paths.support.path
        env["INTERN_DEVICE"] = Host.current().localizedName ?? "Mac"
        env.removeValue(forKey: "NODE_OPTIONS")
        p.environment = env
        let stdin = Pipe(), stdout = Pipe(), stderr = Pipe()
        p.standardInput = stdin; p.standardOutput = stdout; p.standardError = stderr

        // Requests from the worker, one JSON object per line on its stdout.
        var pending = Data()
        let writeLock = NSLock()
        stdout.fileHandleForReading.readabilityHandler = { h in
            let chunk = h.availableData
            if chunk.isEmpty { h.readabilityHandler = nil; return }
            pending.append(chunk)
            while let nl = pending.firstIndex(of: 0x0A) {
                let line = pending.subdata(in: pending.startIndex..<nl)
                pending.removeSubrange(pending.startIndex...nl)
                if line.isEmpty { continue }
                // Answered off this thread so a slow Logic never blocks reading.
                DispatchQueue.global().async {
                    let out = answer(line, allowAuth: true)
                    writeLock.lock(); defer { writeLock.unlock() }
                    try? stdin.fileHandleForWriting.write(contentsOf: out)
                }
            }
        }
        // What the worker says about itself goes to its log; the last line shows in the menu.
        stderr.fileHandleForReading.readabilityHandler = { [weak self] h in
            let chunk = h.availableData
            if chunk.isEmpty { h.readabilityHandler = nil; return }
            for line in (String(data: chunk, encoding: .utf8) ?? "").split(separator: "\n") {
                Log.write(String(line), file: "worker.log")
                self?.lastLine = String(line.prefix(120))
            }
        }
        p.terminationHandler = { [weak self] proc in
            Log.write("worker exited (\(proc.terminationStatus))")
            self?.queue.asyncAfter(deadline: .now() + 15) {
                self?.process = nil
                self?.launch()
            }
        }
        do { try p.run(); process = p; lastLine = "Running"; Log.write("worker started") }
        catch { lastLine = "Could not start the worker: \(error.localizedDescription)"; Log.write(lastLine) }
    }
}
