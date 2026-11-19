import Foundation

// Where the helper keeps its things. Nothing here is specific to one Mac:
// every path is worked out from the signed-in user's home folder at run time.
enum Paths {
    static let bundleId = "app.mixbase.intern"
    static let supabaseURL = "https://mdefkqaawrusoaojstpq.supabase.co"
    // The publishable (public) key, the same one the apps ship with.
    static let supabaseKey = "sb_publishable_z4qhiUQPNegRhalC-p-YKg_-Ubu_qpD"
    static let apiBase = "https://mixbase.app"

    static var support: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent("MixbaseIntern", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }
    /// The local control socket (Logic-only commands; see Server.swift).
    static var socket: String { support.appendingPathComponent("ax.sock").path }
    /// The worker scripts and their rules, copied here by install.sh.
    static var runtime: URL { support.appendingPathComponent("runtime", isDirectory: true) }
    static var config: URL { support.appendingPathComponent("config.json") }
    static var logDir: URL {
        let dir = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Logs/MixbaseIntern", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }
}

enum Log {
    private static let queue = DispatchQueue(label: "intern.log")
    private static let stamp: ISO8601DateFormatter = ISO8601DateFormatter()
    static func write(_ line: String, file: String = "helper.log") {
        queue.async {
            let url = Paths.logDir.appendingPathComponent(file)
            let text = "\(stamp.string(from: Date())) \(line)\n"
            guard let data = text.data(using: .utf8) else { return }
            if let h = try? FileHandle(forWritingTo: url) {
                // Keep the log from growing without end: start again past 5 MB.
                if (try? h.seekToEnd()) ?? 0 > 5_000_000 { try? h.truncate(atOffset: 0) }
                h.write(data); try? h.close()
            } else {
                try? data.write(to: url)
            }
        }
    }
}
