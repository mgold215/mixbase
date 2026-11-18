import AppKit
import ApplicationServices
import AVFoundation

// MARK: - InternDiagnostics (macOS only, owner only)
// First piece of the mixing intern: this Mac app is the intern's hands, because
// Logic Pro only exists here and the app is already installed, signed in and
// updating itself. Before it is taught to change anything, it reports what this
// Mac lets it READ of Logic: whether it has the Accessibility permission, which
// Logic is running, its File menu (Bounce, Export), and how an open plug-in
// window's controls appear (names, values, which can be set).
//
// Read-only. It clicks nothing and changes nothing in Logic. The report goes to
// POST /api/intern/diagnostics, which only the owner's account may call.
// Started from AuthService once the server says this account has owner tools.
enum InternDiagnostics {

    private static let lock = NSLock()
    private static var started = false

    static func start() {
        lock.lock()
        let first = !started
        started = true
        lock.unlock()
        guard first else { return }
        Task.detached(priority: .utility) { await watch() }
    }

    // Report now, then again whenever there is more to see (the permission was
    // granted, Logic was opened, a plug-in window appeared), for half an hour.
    private static func watch() async {
        askForAccessibilityOnce()
        var lastSignature = ""
        var sent = 0
        for _ in 0..<90 {
            let snapshot = collect()
            if snapshot.signature != lastSignature && sent < 8 {
                lastSignature = snapshot.signature
                sent += 1
                try? await MixbaseAPI.shared.sendInternDiagnostics(report: snapshot.report)
            }
            try? await Task.sleep(nanoseconds: 20_000_000_000)
        }
    }

    // The system's own prompt, once: it names the app and opens the right
    // pane of System Settings. Asking again on every launch would be nagging.
    private static func askForAccessibilityOnce() {
        let key = "internAskedForAccessibility"
        guard !AXIsProcessTrusted(), !UserDefaults.standard.bool(forKey: key) else { return }
        UserDefaults.standard.set(true, forKey: key)
        let options = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
    }

    private struct Snapshot {
        let report: String
        let signature: String
    }

    private static func collect() -> Snapshot {
        var lines: [String] = []
        let trusted = AXIsProcessTrusted()
        let info = Bundle.main.infoDictionary
        lines.append("=== mixBASE Mac app")
        lines.append("app_version=\(info?["CFBundleShortVersionString"] as? String ?? "?") build=\(info?["CFBundleVersion"] as? String ?? "?")")
        lines.append("macos=\(ProcessInfo.processInfo.operatingSystemVersionString)")
        lines.append("ax_trusted=\(trusted)")

        let logic = NSWorkspace.shared.runningApplications.filter {
            ($0.bundleIdentifier ?? "").lowercased().contains("logic")
        }
        lines.append("logic_running=\(!logic.isEmpty)")
        for app in logic {
            let version = app.bundleURL.flatMap { Bundle(url: $0)?.infoDictionary?["CFBundleShortVersionString"] as? String } ?? "?"
            lines.append("logic_app name=\(app.localizedName ?? "?") bundle=\(app.bundleIdentifier ?? "?") version=\(version) frontmost=\(app.isActive) hidden=\(app.isHidden)")
        }

        var windowTitles: [String] = []
        if trusted, let app = logic.first {
            let root = AXUIElementCreateApplication(app.processIdentifier)
            AXUIElementSetMessagingTimeout(root, 3)

            lines.append("=== Logic menus")
            if let bar = attribute(root, "AXMenuBar") {
                for menu in children(bar as! AXUIElement) {
                    let name = text(menu, "AXTitle")
                    lines.append("menu \(name)")
                    if name == "File" {
                        var budget = 240
                        dump(menu, depth: 1, maxDepth: 5, budget: &budget, into: &lines)
                    }
                }
            } else {
                lines.append("menu bar could not be read")
            }

            lines.append("=== Logic windows")
            let windows = (attribute(root, "AXWindows") as? [AXUIElement]) ?? []
            lines.append("window_count=\(windows.count)")
            for window in windows.prefix(8) {
                let title = text(window, "AXTitle")
                windowTitles.append(title)
                lines.append("window title=\"\(title)\" subrole=\(text(window, "AXSubrole"))")
                var budget = 300
                dump(window, depth: 1, maxDepth: 8, budget: &budget, into: &lines)
            }
        } else if !trusted {
            lines.append("Logic's windows were not read: this app does not have the Accessibility permission yet")
        }

        lines.append("=== Audio Unit plug-ins")
        let components = AVAudioUnitComponentManager.shared().components(matching: AudioComponentDescription())
        let wanted = components.filter { ["Effect", "Music Effect", "Music Device"].contains($0.typeName) }
        lines.append("count=\(wanted.count)")
        for component in wanted.prefix(600) {
            lines.append("\(component.manufacturerName): \(component.name) [\(component.typeName)]")
        }

        let signature = "\(trusted)|\(logic.count)|\(windowTitles.joined(separator: ";"))"
        return Snapshot(report: lines.joined(separator: "\n"), signature: signature)
    }

    // MARK: Reading another app's interface

    private static func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
    }

    private static func text(_ element: AXUIElement, _ name: String) -> String {
        guard let value = attribute(element, name) else { return "" }
        let whole = String(describing: value).replacingOccurrences(of: "\n", with: " ")
        return whole.count > 70 ? String(whole.prefix(70)) + "…" : whole
    }

    private static func children(_ element: AXUIElement) -> [AXUIElement] {
        (attribute(element, "AXChildren") as? [AXUIElement]) ?? []
    }

    private static func isSettable(_ element: AXUIElement, _ name: String) -> Bool {
        var flag = DarwinBoolean(false)
        return AXUIElementIsAttributeSettable(element, name as CFString, &flag) == .success && flag.boolValue
    }

    private static func dump(_ element: AXUIElement, depth: Int, maxDepth: Int, budget: inout Int, into lines: inout [String]) {
        guard depth <= maxDepth, budget > 0 else { return }
        budget -= 1
        let settable = isSettable(element, "AXValue") ? " settable" : ""
        lines.append(String(repeating: "  ", count: depth)
            + "\(text(element, "AXRole")) title=\"\(text(element, "AXTitle"))\" desc=\"\(text(element, "AXDescription"))\" value=\"\(text(element, "AXValue"))\"\(settable)")
        for child in children(element) {
            dump(child, depth: depth + 1, maxDepth: maxDepth, budget: &budget, into: &lines)
        }
    }
}
