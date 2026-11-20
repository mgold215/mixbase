import AppKit
import ApplicationServices
import CoreGraphics
import IOKit.pwr_mgt

// The hands: reading and operating Logic Pro's interface through the macOS
// Accessibility API. Every command is aimed at Logic and nothing else.
//
// Elements are handed out as short handles ("e12") that stay valid until the
// table is reset, so a caller can find a control once and act on it later.

struct AXFailure: Error { let message: String }

final class AXBridge {
    static let shared = AXBridge()
    static let logicBundleId = "com.apple.logic10"

    private let queue = DispatchQueue(label: "intern.ax")
    private var handles: [String: AXUIElement] = [:]
    private var counter = 0
    private var powerAssertion: IOPMAssertionID = 0

    // MARK: Entry point

    /// Runs one command. `allowAuth` is true only for the worker the helper
    /// started itself; the local socket never hands out the access token.
    func run(_ cmd: [String: Any], allowAuth: Bool) -> [String: Any] {
        let name = cmd["cmd"] as? String ?? "?"
        // The token has nothing to do with Logic: it must not wait behind a slow answer from it,
        // or a job could not report (its heartbeat) while Logic is busy.
        if name == "auth.token" || name == "ping" {
            do { return ["ok": true, "result": try dispatch(cmd, allowAuth: allowAuth)] }
            catch let e as AXFailure { return ["ok": false, "error": e.message] }
            catch { return ["ok": false, "error": "\(error)"] }
        }
        let asked = Date()
        return queue.sync {
            let started = Date()
            defer {
                // Anything slow is written down: it is how a stuck step is found afterwards.
                let waited = started.timeIntervalSince(asked), took = Date().timeIntervalSince(started)
                if waited > 2 || took > 2 { Log.write(String(format: "slow: %@ waited %.1fs took %.1fs", name, waited, took)) }
            }
            do { return ["ok": true, "result": try dispatch(cmd, allowAuth: allowAuth)] }
            catch let e as AXFailure { return ["ok": false, "error": e.message] }
            catch { return ["ok": false, "error": "\(error)"] }
        }
    }

    private func dispatch(_ c: [String: Any], allowAuth: Bool) throws -> Any {
        let name = c["cmd"] as? String ?? ""
        switch name {
        case "ping": return state()
        case "auth.token":
            guard allowAuth else { throw AXFailure(message: "Not available on this channel") }
            guard let t = Auth.shared.token() else { throw AXFailure(message: "Not signed in") }
            return ["token": t, "api": Paths.apiBase, "supabase": Paths.supabaseURL, "key": Paths.supabaseKey]
        case "app.launch": return try launchLogic()
        case "app.open":
            guard let path = c["path"] as? String else { throw AXFailure(message: "Missing path") }
            return try openInLogic(path)
        case "app.activate":
            guard let app = logicApp() else { throw AXFailure(message: "Logic Pro is not running") }
            return app.activate(options: [.activateAllWindows])
        case "app.windows": return try windows()
        case "ax.reset": handles.removeAll(); return true
        case "ax.dump":
            let el = try element(c["el"])
            findDeadline = Date().addingTimeInterval(25)
            let tree = dump(el, depth: c["depth"] as? Int ?? 3, maxChildren: c["max"] as? Int ?? 80)
            // Half a tree is worse than none: the caller would act on what is missing.
            if Date() > findDeadline { throw AXFailure(message: "Logic is too busy to answer") }
            return tree
        case "ax.find":
            let el = try element(c["el"])
            var out: [[String: Any]] = []
            // A search is given 25 seconds: part of Logic's interface (a third-party
            // plug-in's editor) can take that long to answer for a single element.
            findDeadline = Date().addingTimeInterval(25)
            find(el, c, depth: c["depth"] as? Int ?? 14, limit: c["limit"] as? Int ?? 50, into: &out)
            return out
        case "ax.attrs": return try attributes(try element(c["el"]))
        case "ax.get":
            guard let attr = c["attr"] as? String else { throw AXFailure(message: "Missing attr") }
            return json(try copy(try element(c["el"]), attr)) ?? NSNull()
        case "ax.param":
            guard let attr = c["attr"] as? String else { throw AXFailure(message: "Missing attr") }
            var out: CFTypeRef?
            let err = AXUIElementCopyParameterizedAttributeValue(try element(c["el"]), attr as CFString, (c["param"] as AnyObject?) ?? (0 as CFNumber), &out)
            if err != .success { throw AXFailure(message: "\(attr): \(axName(err))") }
            return json(out) ?? NSNull()
        case "ax.set":
            guard let attr = c["attr"] as? String, let value = c["value"] else { throw AXFailure(message: "Missing attr or value") }
            let el = try element(c["el"])
            let err = AXUIElementSetAttributeValue(el, attr as CFString, value as CFTypeRef)
            if err != .success { throw AXFailure(message: "set \(attr): \(axName(err))") }
            return json(try? copy(el, attr)) ?? NSNull()
        case "ax.act":
            let el = try element(c["el"])
            let action = c["action"] as? String ?? kAXPressAction as String
            let err = AXUIElementPerformAction(el, action as CFString)
            // Logic often answers a press that opened a dialog with "cannot complete":
            // the action happened, the reply timed out behind the new window.
            if err != .success && err != .cannotComplete { throw AXFailure(message: "\(action): \(axName(err))") }
            return ["action": action, "reply": axName(err)]
        case "ax.menu":
            guard let path = c["path"] as? [String], !path.isEmpty else { throw AXFailure(message: "Missing path") }
            return try menu(path, press: c["press"] as? Bool ?? true)
        case "sys.key":
            guard let code = c["code"] as? Int else { throw AXFailure(message: "Missing code") }
            return try key(CGKeyCode(code), mods: c["mods"] as? [String] ?? [])
        case "sys.axkey":
            guard let code = c["code"] as? Int else { throw AXFailure(message: "Missing code") }
            return try axKey(CGKeyCode(code), mods: c["mods"] as? [String] ?? [])
        case "sys.type":
            guard let text = c["text"] as? String else { throw AXFailure(message: "Missing text") }
            return try type(text)
        case "sys.click":
            guard let x = c["x"] as? Double, let y = c["y"] as? Double else { throw AXFailure(message: "Missing x or y") }
            return try click(CGPoint(x: x, y: y), double: c["double"] as? Bool ?? false)
        case "logic.savedir":
            // Where Logic's next save dialog will open. With `path`, points it at
            // that folder; with `restore` (what an earlier call returned), puts it back.
            return try saveDirectory(path: c["path"] as? String, restore: c["restore"] as? String)
        case "sys.awake":
            return holdAwake(c["on"] as? Bool ?? true)
        case "sys.wake":
            var id: IOPMAssertionID = 0
            let r = IOPMAssertionDeclareUserActivity("mixBASE intern" as CFString, kIOPMUserActiveLocal, &id)
            return r == kIOReturnSuccess
        default: throw AXFailure(message: "Unknown command: \(name)")
        }
    }

    // MARK: Logic, and the state of the Mac

    private func logicApp() -> NSRunningApplication? {
        NSRunningApplication.runningApplications(withBundleIdentifier: Self.logicBundleId).first
    }

    /// No single question to Logic may wait longer than this, on any element.
    /// (Set on the system-wide element, which is how the limit is made global;
    /// nothing else is ever asked of it.)
    func limitWaits() { AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 6) }

    private func logicElement() throws -> AXUIElement {
        guard let app = logicApp() else { throw AXFailure(message: "Logic Pro is not running") }
        let el = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(el, 6)
        return el
    }

    func state() -> [String: Any] {
        let session = CGSessionCopyCurrentDictionary() as? [String: Any] ?? [:]
        let app = logicApp()
        var out: [String: Any] = [
            "trusted": AXIsProcessTrusted(),
            "full_disk": Permissions.fullDisk,
            "signed_in": Auth.shared.isSignedIn,
            "screen_locked": (session["CGSSessionScreenIsLocked"] as? Int ?? 0) == 1,
            "display_asleep": CGDisplayIsAsleep(CGMainDisplayID()) != 0,
            "logic_running": app != nil,
            "logic_frontmost": app?.isActive ?? false,
        ]
        if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: Self.logicBundleId),
           let v = Bundle(url: url)?.infoDictionary?["CFBundleShortVersionString"] as? String { out["logic_version"] = v }
        return out
    }

    private func launchLogic() throws -> Any {
        if logicApp() != nil { return ["already": true] }
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: Self.logicBundleId) else {
            throw AXFailure(message: "Logic Pro is not installed on this Mac")
        }
        let cfg = NSWorkspace.OpenConfiguration(); cfg.activates = true
        NSWorkspace.shared.openApplication(at: url, configuration: cfg, completionHandler: nil)
        return ["launched": true]
    }

    private func openInLogic(_ path: String) throws -> Any {
        guard let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: Self.logicBundleId) else {
            throw AXFailure(message: "Logic Pro is not installed on this Mac")
        }
        // Only ever a Logic project, so this cannot be used to open anything else.
        guard path.lowercased().hasSuffix(".logicx") else { throw AXFailure(message: "Not a Logic project") }
        guard FileManager.default.fileExists(atPath: path) else { throw AXFailure(message: "No such project: \((path as NSString).lastPathComponent)") }
        let cfg = NSWorkspace.OpenConfiguration(); cfg.activates = true
        NSWorkspace.shared.open([URL(fileURLWithPath: path)], withApplicationAt: app, configuration: cfg, completionHandler: nil)
        return ["opening": (path as NSString).lastPathComponent]
    }

    /// Logic's save dialogs open in the folder used last, kept in its
    /// preferences as a bookmark. Keys cannot be typed into that dialog from
    /// outside (and nobody is there to type), so a job points the dialog at its
    /// own folder here and puts the owner's folder back when it is done.
    private func saveDirectory(path: String?, restore: String?) throws -> Any {
        let key = "NSOSPLastRootDirectory" as CFString, app = Self.logicBundleId as CFString
        let was = CFPreferencesCopyAppValue(key, app) as? Data
        var out: [String: Any] = [:]
        if let was {
            out["was"] = was.base64EncodedString()
            var stale = false
            if let url = try? URL(resolvingBookmarkData: was, options: [.withoutUI], relativeTo: nil, bookmarkDataIsStale: &stale) { out["path"] = url.path }
        }
        var next: Data?
        if let restore { next = Data(base64Encoded: restore) }
        else if let path {
            var isDir: ObjCBool = false
            guard FileManager.default.fileExists(atPath: path, isDirectory: &isDir), isDir.boolValue else { throw AXFailure(message: "No such folder") }
            next = try URL(fileURLWithPath: path, isDirectory: true).bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
        }
        if let next {
            CFPreferencesSetAppValue(key, next as CFData, app)
            out["set"] = CFPreferencesAppSynchronize(app)
        }
        return out
    }

    /// Keeps the display (and so the Mac) awake while a job runs: with the
    /// display asleep Logic's windows cannot be read. Like a video player
    /// does; it changes no setting and ends with the job.
    private func holdAwake(_ on: Bool) -> Bool {
        if powerAssertion != 0 { IOPMAssertionRelease(powerAssertion); powerAssertion = 0 }
        guard on else { return true }
        return IOPMAssertionCreateWithName(kIOPMAssertPreventUserIdleDisplaySleep as CFString, IOPMAssertionLevel(kIOPMAssertionLevelOn),
                                           "mixBASE intern is working on a mix" as CFString, &powerAssertion) == kIOReturnSuccess
    }

    // MARK: Handles

    private func handle(_ el: AXUIElement) -> String {
        counter += 1
        if handles.count > 60_000 { handles.removeAll() }
        let h = "e\(counter)"
        handles[h] = el
        return h
    }

    private func element(_ ref: Any?) throws -> AXUIElement {
        guard let h = ref as? String, h != "app" else { return try logicElement() }
        guard let el = handles[h] else { throw AXFailure(message: "Unknown element \(h) (the table was reset)") }
        return el
    }

    // MARK: Reading

    private func copy(_ el: AXUIElement, _ attr: String) throws -> CFTypeRef? {
        var out: CFTypeRef?
        let err = AXUIElementCopyAttributeValue(el, attr as CFString, &out)
        if err == .noValue || err == .attributeUnsupported { return nil }
        if err != .success { throw AXFailure(message: "\(attr): \(axName(err))") }
        return out
    }

    private func string(_ el: AXUIElement, _ attr: String) -> String? {
        guard let v = try? copy(el, attr) else { return nil }
        if let s = v as? String { return s.isEmpty ? nil : s }
        return nil
    }

    private func children(_ el: AXUIElement) -> [AXUIElement] {
        ((try? copy(el, kAXChildrenAttribute as String)) as? [AXUIElement]) ?? []
    }

    /// Anything the Accessibility API returns, as something JSON can carry.
    private func json(_ value: CFTypeRef?) -> Any? {
        guard let value else { return nil }
        let type = CFGetTypeID(value)
        if type == AXUIElementGetTypeID() { return ["el": handle(value as! AXUIElement)] }
        if type == AXValueGetTypeID() {
            let v = value as! AXValue
            switch AXValueGetType(v) {
            case .cgPoint: var p = CGPoint.zero; AXValueGetValue(v, .cgPoint, &p); return ["x": p.x, "y": p.y]
            case .cgSize: var s = CGSize.zero; AXValueGetValue(v, .cgSize, &s); return ["w": s.width, "h": s.height]
            case .cgRect: var r = CGRect.zero; AXValueGetValue(v, .cgRect, &r); return ["x": r.origin.x, "y": r.origin.y, "w": r.width, "h": r.height]
            case .cfRange: var r = CFRange(); AXValueGetValue(v, .cfRange, &r); return ["loc": r.location, "len": r.length]
            default: return "\(v)"
            }
        }
        if let s = value as? String { return s.count > 400 ? String(s.prefix(400)) + "…" : s }
        if let n = value as? NSNumber { return n }
        if let a = value as? [AnyObject] { return a.prefix(200).map { json($0) ?? NSNull() } }
        if let u = value as? URL { return u.path }
        return "\(value)"
    }

    private func describe(_ el: AXUIElement) -> [String: Any] {
        var d: [String: Any] = ["h": handle(el)]
        d["role"] = string(el, kAXRoleAttribute as String) ?? "?"
        if let s = string(el, kAXSubroleAttribute as String) { d["sub"] = s }
        if let s = string(el, kAXTitleAttribute as String) { d["title"] = s }
        if let s = string(el, kAXDescriptionAttribute as String) { d["desc"] = s }
        if let s = string(el, kAXIdentifierAttribute as String) { d["id"] = s }
        if let s = string(el, kAXHelpAttribute as String) { d["help"] = s }
        if let s = string(el, kAXRoleDescriptionAttribute as String) { d["rdesc"] = s }
        if let v = try? copy(el, kAXValueAttribute as String), let j = json(v) { d["value"] = j }
        if let v = string(el, kAXValueDescriptionAttribute as String) { d["vdesc"] = v }
        if let v = (try? copy(el, kAXEnabledAttribute as String)) as? Bool, !v { d["enabled"] = false }
        if let v = (try? copy(el, kAXSelectedAttribute as String)) as? Bool, v { d["selected"] = true }
        if let p = try? copy(el, kAXPositionAttribute as String), let s = try? copy(el, kAXSizeAttribute as String),
           let pj = json(p) as? [String: Any], let sj = json(s) as? [String: Any] {
            d["frame"] = [pj["x"] ?? 0, pj["y"] ?? 0, sj["w"] ?? 0, sj["h"] ?? 0]
        }
        return d
    }

    private func dump(_ el: AXUIElement, depth: Int, maxChildren: Int) -> [String: Any] {
        var d = describe(el)
        let kids = children(el)
        if !kids.isEmpty {
            d["n"] = kids.count
            if depth > 0 && Date() < findDeadline { d["children"] = kids.prefix(maxChildren).map { dump($0, depth: depth - 1, maxChildren: maxChildren) } }
        }
        return d
    }

    private func attributes(_ el: AXUIElement) throws -> [String: Any] {
        var names: CFArray?, params: CFArray?, actions: CFArray?
        AXUIElementCopyAttributeNames(el, &names)
        AXUIElementCopyParameterizedAttributeNames(el, &params)
        AXUIElementCopyActionNames(el, &actions)
        var values: [String: Any] = [:]
        var settable: [String] = []
        for name in (names as? [String]) ?? [] {
            if name == (kAXChildrenAttribute as String) { values[name] = "(\(children(el).count))"; continue }
            values[name] = json(try? copy(el, name)) ?? NSNull()
            var can: DarwinBoolean = false
            if AXUIElementIsAttributeSettable(el, name as CFString, &can) == .success, can.boolValue { settable.append(name) }
        }
        return ["attributes": values, "settable": settable, "parameterized": (params as? [String]) ?? [], "actions": (actions as? [String]) ?? []]
    }

    // MARK: Searching

    private func matches(_ el: AXUIElement, _ c: [String: Any]) -> Bool {
        func eq(_ key: String, _ attr: String) -> Bool {
            guard let want = c[key] as? String else { return true }
            return string(el, attr) == want
        }
        func has(_ key: String, _ attr: String) -> Bool {
            guard let want = c[key] as? String else { return true }
            return string(el, attr)?.localizedCaseInsensitiveContains(want) ?? false
        }
        if !eq("role", kAXRoleAttribute as String) || !eq("sub", kAXSubroleAttribute as String) { return false }
        if !eq("title", kAXTitleAttribute as String) || !has("titleHas", kAXTitleAttribute as String) { return false }
        if !eq("desc", kAXDescriptionAttribute as String) || !has("descHas", kAXDescriptionAttribute as String) { return false }
        if !eq("id", kAXIdentifierAttribute as String) || !has("idHas", kAXIdentifierAttribute as String) { return false }
        if !has("helpHas", kAXHelpAttribute as String) { return false }
        if let want = c["valueHas"] as? String {
            guard let v = (try? copy(el, kAXValueAttribute as String)) as? String, v.localizedCaseInsensitiveContains(want) else { return false }
        }
        return true
    }

    private var findDeadline = Date.distantFuture

    private func find(_ el: AXUIElement, _ c: [String: Any], depth: Int, limit: Int, into out: inout [[String: Any]]) {
        if out.count >= limit || Date() > findDeadline { return }
        if matches(el, c) { out.append(describe(el)) }
        guard depth > 0 else { return }
        for kid in children(el) {
            if out.count >= limit { return }
            find(kid, c, depth: depth - 1, limit: limit, into: &out)
        }
    }

    private func windows() throws -> [[String: Any]] {
        let app = try logicElement()
        let list = ((try copy(app, kAXWindowsAttribute as String)) as? [AXUIElement]) ?? []
        return list.map { w in
            var d = describe(w)
            if let m = (try? copy(w, kAXMainAttribute as String)) as? Bool { d["main"] = m }
            if let m = (try? copy(w, kAXModalAttribute as String)) as? Bool, m { d["modal"] = true }
            if let doc = string(w, kAXDocumentAttribute as String) { d["document"] = doc }
            return d
        }
    }

    // MARK: Menus

    /// "Bounce…" in the menu and "Bounce..." in a script are the same item.
    private func plain(_ s: String) -> String {
        s.replacingOccurrences(of: "…", with: "...").trimmingCharacters(in: .whitespaces).lowercased()
    }

    private func menu(_ path: [String], press: Bool) throws -> Any {
        let app = try logicElement()
        guard let bar = try copy(app, kAXMenuBarAttribute as String) else { throw AXFailure(message: "Logic's menu bar cannot be read") }
        var current = bar as! AXUIElement
        for (i, name) in path.enumerated() {
            // A menu bar item or a menu item holds its items inside one AXMenu child.
            var items = children(current)
            if items.count == 1, string(items[0], kAXRoleAttribute as String) == (kAXMenuRole as String) { items = children(items[0]) }
            guard let next = items.first(where: { plain(string($0, kAXTitleAttribute as String) ?? "") == plain(name) }) else {
                let have = items.compactMap { string($0, kAXTitleAttribute as String) }
                throw AXFailure(message: "No menu item \"\(name)\" under \(path.prefix(i).joined(separator: " > ")). There: \(have.joined(separator: " | "))")
            }
            current = next
        }
        if !press {
            var items = children(current)
            if items.count == 1, string(items[0], kAXRoleAttribute as String) == (kAXMenuRole as String) { items = children(items[0]) }
            return items.map { item -> [String: Any] in
                var d: [String: Any] = ["h": handle(item), "title": string(item, kAXTitleAttribute as String) ?? ""]
                if let e = (try? copy(item, kAXEnabledAttribute as String)) as? Bool, !e { d["enabled"] = false }
                if let m = string(item, kAXMenuItemMarkCharAttribute as String) { d["mark"] = m }
                return d
            }
        }
        let disabled = { ((try? self.copy(current, kAXEnabledAttribute as String)) as? Bool) == false }
        if disabled() {
            // Logic only works out which items are enabled when a menu is opened: what
            // reads as greyed out may be left over from before the project was open.
            // Open the menu to make it look again.
            if let top = self.children(bar as! AXUIElement).first(where: { plain(string($0, kAXTitleAttribute as String) ?? "") == plain(path[0]) }) {
                AXUIElementPerformAction(top, kAXPressAction as CFString)
                usleep(700_000)
                if disabled() {
                    AXUIElementPerformAction(top, kAXCancelAction as CFString)
                    throw AXFailure(message: "\"\(path.joined(separator: " > "))\" is greyed out")
                }
            }
        }
        let err = AXUIElementPerformAction(current, kAXPressAction as CFString)
        if err != .success && err != .cannotComplete { throw AXFailure(message: "\(path.last ?? ""): \(axName(err))") }
        return ["pressed": path.joined(separator: " > "), "reply": axName(err)]
    }

    // MARK: Keys and clicks (sent to Logic itself, not to whatever is in front)

    private func key(_ code: CGKeyCode, mods: [String]) throws -> Any {
        guard let app = logicApp() else { throw AXFailure(message: "Logic Pro is not running") }
        var flags: CGEventFlags = []
        for m in mods {
            switch m { case "cmd": flags.insert(.maskCommand); case "shift": flags.insert(.maskShift)
            case "alt": flags.insert(.maskAlternate); case "ctrl": flags.insert(.maskControl); default: break }
        }
        let src = CGEventSource(stateID: .hidSystemState)
        for down in [true, false] {
            guard let e = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: down) else { continue }
            e.flags = flags
            e.postToPid(app.processIdentifier)
            usleep(20_000)
        }
        return true
    }

    /// A key press handed to Logic through the Accessibility API itself, with
    /// the modifier keys pressed around it. Swift hides this old call, so it is
    /// looked up by name.
    private typealias PostKey = @convention(c) (AXUIElement, CGCharCode, CGKeyCode, DarwinBoolean) -> AXError
    private func axKey(_ code: CGKeyCode, mods: [String]) throws -> Any {
        guard let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "AXUIElementPostKeyboardEvent") else { throw AXFailure(message: "key posting is not available") }
        let post = unsafeBitCast(sym, to: PostKey.self)
        let app = try logicElement()
        let modCodes: [CGKeyCode] = mods.compactMap { ["cmd": 55, "shift": 56, "alt": 58, "ctrl": 59][$0] }
        for m in modCodes { _ = post(app, 0, m, true) }
        let down = post(app, 0, code, true)
        usleep(30_000)
        _ = post(app, 0, code, false)
        for m in modCodes.reversed() { _ = post(app, 0, m, false) }
        if down != .success { throw AXFailure(message: "key: \(axName(down))") }
        return true
    }

    private func type(_ text: String) throws -> Any {
        guard let app = logicApp() else { throw AXFailure(message: "Logic Pro is not running") }
        let src = CGEventSource(stateID: .hidSystemState)
        for ch in text.utf16 {
            for down in [true, false] {
                guard let e = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: down) else { continue }
                var u = ch
                e.keyboardSetUnicodeString(stringLength: 1, unicodeString: &u)
                e.postToPid(app.processIdentifier)
                usleep(8_000)
            }
        }
        return true
    }

    /// A click is delivered to Logic's own process and only at a point inside
    /// one of Logic's windows: never to whatever else is on screen.
    private func click(_ p: CGPoint, double: Bool) throws -> Any {
        guard let app = logicApp() else { throw AXFailure(message: "Logic Pro is not running") }
        let inside = try windows().contains { w in
            guard let f = w["frame"] as? [Any], f.count == 4,
                  let x = f[0] as? CGFloat, let y = f[1] as? CGFloat, let width = f[2] as? CGFloat, let height = f[3] as? CGFloat else { return false }
            return CGRect(x: x, y: y, width: width, height: height).contains(p)
        }
        guard inside else { throw AXFailure(message: "That point is not inside a Logic window") }
        let src = CGEventSource(stateID: .hidSystemState)
        for n in 1...(double ? 2 : 1) {
            for type in [CGEventType.leftMouseDown, .leftMouseUp] {
                guard let e = CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: p, mouseButton: .left) else { continue }
                e.setIntegerValueField(.mouseEventClickState, value: Int64(n))
                e.postToPid(app.processIdentifier)
                usleep(30_000)
            }
        }
        return true
    }

    private func axName(_ e: AXError) -> String {
        switch e {
        case .success: return "ok"
        case .apiDisabled: return "Accessibility is switched off for the helper"
        case .cannotComplete: return "cannot complete"
        case .attributeUnsupported: return "attribute unsupported"
        case .actionUnsupported: return "action unsupported"
        case .invalidUIElement: return "the element is gone"
        case .illegalArgument: return "illegal argument"
        case .noValue: return "no value"
        case .notImplemented: return "not implemented"
        case .failure: return "failed"
        default: return "error \(e.rawValue)"
        }
    }
}

enum Permissions {
    /// Full Disk Access shows itself by whether a file only it unlocks can be
    /// opened. Trying also makes the helper appear in that list in System
    /// Settings. Several files are tried, because they move: macOS 27 no longer
    /// keeps a privacy database in the user's Library, and with only that one
    /// probed the helper read the switch as off and never started its worker.
    static var fullDisk: Bool {
        let home = NSHomeDirectory()
        let probes = [
            "/Library/Application Support/com.apple.TCC/TCC.db",
            home + "/Library/Application Support/com.apple.TCC/TCC.db",
            home + "/Library/Safari/Bookmarks.plist",
            home + "/Library/Mail",
        ]
        for path in probes {
            let fd = open(path, O_RDONLY)
            if fd >= 0 { close(fd); return true }
        }
        return false
    }
}
