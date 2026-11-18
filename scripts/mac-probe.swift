// Read-only look at what this Mac lets a script see of Logic Pro.
// Run by scripts/mac-probe.sh. It changes nothing, clicks nothing and asks for
// no permission: every call here either reads state or reports "not allowed".
import Cocoa
import ApplicationServices

func line(_ s: String) { print(s) }

let trusted = AXIsProcessTrusted()
line("ax_trusted=\(trusted)")
line("screen_capture_allowed=\(CGPreflightScreenCaptureAccess())")
if let session = CGSessionCopyCurrentDictionary() as? [String: Any] {
    line("screen_locked=\(session["CGSSessionScreenIsLocked"] ?? "false")")
    line("on_console=\(session["kCGSSessionOnConsoleKey"] ?? "unknown")")
} else {
    line("session=none (not a logged-in desktop session)")
}

let logic = NSWorkspace.shared.runningApplications.filter {
    ($0.bundleIdentifier ?? "").lowercased().contains("logic")
}
line("logic_running=\(!logic.isEmpty)")
for app in logic {
    let version = app.bundleURL.flatMap { Bundle(url: $0)?.infoDictionary?["CFBundleShortVersionString"] as? String } ?? "?"
    line("logic_app name=\(app.localizedName ?? "?") bundle=\(app.bundleIdentifier ?? "?") version=\(version) pid=\(app.processIdentifier) frontmost=\(app.isActive) hidden=\(app.isHidden)")
}

func attr(_ element: AXUIElement, _ name: String) -> AnyObject? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
func text(_ element: AXUIElement, _ name: String) -> String {
    guard let value = attr(element, name) else { return "" }
    let s = String(describing: value).replacingOccurrences(of: "\n", with: " ")
    return s.count > 70 ? String(s.prefix(70)) + "…" : s
}
func kids(_ element: AXUIElement) -> [AXUIElement] {
    guard let value = attr(element, kAXChildrenAttribute as String) else { return [] }
    return (value as? [AXUIElement]) ?? []
}
func settable(_ element: AXUIElement, _ name: String) -> Bool {
    var flag = DarwinBoolean(false)
    return AXUIElementIsAttributeSettable(element, name as CFString, &flag) == .success && flag.boolValue
}

var budget = 0
func dump(_ element: AXUIElement, depth: Int, maxDepth: Int, limit: Int) {
    if depth > maxDepth || budget >= limit { return }
    budget += 1
    let role = text(element, kAXRoleAttribute as String)
    let title = text(element, kAXTitleAttribute as String)
    let desc = text(element, kAXDescriptionAttribute as String)
    let value = text(element, kAXValueAttribute as String)
    let canSet = settable(element, kAXValueAttribute as String) ? " settable" : ""
    line(String(repeating: "  ", count: depth) + "\(role) title=\"\(title)\" desc=\"\(desc)\" value=\"\(value)\"\(canSet)")
    for child in kids(element) { dump(child, depth: depth + 1, maxDepth: maxDepth, limit: limit) }
}

if trusted, let app = logic.first {
    let root = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(root, 3)
    line("--- menus (File, and the top level)")
    if let bar = attr(root, kAXMenuBarAttribute as String) {
        for menu in kids(bar as! AXUIElement) {
            let name = text(menu, kAXTitleAttribute as String)
            line("menu \(name)")
            if name == "File" { budget = 0; dump(menu, depth: 1, maxDepth: 5, limit: 220) }
        }
    }
    line("--- windows")
    let windows = (attr(root, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []
    line("window_count=\(windows.count)")
    for window in windows.prefix(8) {
        line("window title=\"\(text(window, kAXTitleAttribute as String))\" subrole=\(text(window, kAXSubroleAttribute as String))")
        budget = 0
        dump(window, depth: 1, maxDepth: 7, limit: 260)
    }
} else if !trusted {
    line("ax: not trusted, so Logic's windows and plug-in controls were not read")
} else {
    line("ax: trusted, but Logic is not running")
}
