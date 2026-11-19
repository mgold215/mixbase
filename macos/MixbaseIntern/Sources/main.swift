import AppKit
import ApplicationServices

// mixBASE Intern: the helper that works on the owner's Mac.
//
// It sits in the menu bar, signs in to mixBASE once, and runs the job loop
// (scripts/intern-worker.mjs), lending it the one thing a script cannot do by
// itself: operate Logic Pro through the Accessibility permission this app holds.
//
// It needs three things from a person, once: a sign-in, the Accessibility
// switch and the Full Disk Access switch. The setup window shows all three
// and closes itself when they are done.

final class SetupWindow: NSObject, NSWindowDelegate {
    private var window: NSWindow?
    private let email = NSTextField()
    private let password = NSSecureTextField()
    private let signInButton = NSButton(title: "Sign in", target: nil, action: nil)
    private let signInStatus = NSTextField(labelWithString: "")
    private let axStatus = NSTextField(labelWithString: "")
    private let diskStatus = NSTextField(labelWithString: "")
    private let footer = NSTextField(labelWithString: "")
    private var timer: Timer?

    var allDone: Bool { Auth.shared.isSignedIn && AXIsProcessTrusted() && Permissions.fullDisk }

    func show() {
        if window == nil { build() }
        refresh()
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.refresh() }
    }

    private func row(_ title: String, _ detail: String, _ status: NSTextField, button: NSButton?) -> NSView {
        let head = NSTextField(labelWithString: title); head.font = .boldSystemFont(ofSize: 13)
        let sub = NSTextField(wrappingLabelWithString: detail); sub.font = .systemFont(ofSize: 11); sub.textColor = .secondaryLabelColor
        let text = NSStackView(views: [head, sub]); text.orientation = .vertical; text.alignment = .leading; text.spacing = 2
        status.font = .systemFont(ofSize: 12)
        let right = NSStackView(views: button.map { [status, $0] } ?? [status]); right.orientation = .horizontal; right.spacing = 8
        let line = NSStackView(views: [text, NSView(), right]); line.orientation = .horizontal; line.alignment = .centerY
        return line
    }

    private func build() {
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 520, height: 380), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        w.title = "mixBASE Intern"
        w.isReleasedWhenClosed = false
        w.delegate = self
        w.center()

        let intro = NSTextField(wrappingLabelWithString: "The intern fixes Mix Check notes in your Logic projects, on a copy, and uploads the result. It needs three things from you, once.")
        email.placeholderString = "mixBASE email"; password.placeholderString = "Password"
        email.stringValue = Auth.shared.email ?? ""
        signInButton.target = self; signInButton.action = #selector(signIn)
        signInButton.keyEquivalent = "\r"
        password.target = self; password.action = #selector(signIn)
        signInStatus.font = .systemFont(ofSize: 12)
        let fields = NSStackView(views: [email, password, signInButton]); fields.orientation = .horizontal; fields.spacing = 8
        email.widthAnchor.constraint(equalToConstant: 210).isActive = true
        password.widthAnchor.constraint(equalToConstant: 160).isActive = true
        let one = NSTextField(labelWithString: "1. Sign in to mixBASE"); one.font = .boldSystemFont(ofSize: 13)

        let axButton = NSButton(title: "Open Settings", target: self, action: #selector(openAccessibility))
        let diskButton = NSButton(title: "Open Settings", target: self, action: #selector(openFullDisk))
        footer.font = .systemFont(ofSize: 12); footer.textColor = .secondaryLabelColor

        let stack = NSStackView(views: [
            intro, one, fields, signInStatus,
            row("2. Accessibility", "Switch on \u{201C}MixbaseIntern\u{201D} so it can operate Logic Pro.", axStatus, button: axButton),
            row("3. Full Disk Access", "Switch on \u{201C}MixbaseIntern\u{201D} so it can find and copy your Logic projects wherever they are.", diskStatus, button: diskButton),
            footer,
        ])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 14
        stack.edgeInsets = NSEdgeInsets(top: 20, left: 22, bottom: 20, right: 22)
        stack.translatesAutoresizingMaskIntoConstraints = false
        let content = NSView()
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor), stack.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            stack.topAnchor.constraint(equalTo: content.topAnchor), stack.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            content.widthAnchor.constraint(equalToConstant: 520),
        ])
        for v in stack.views where !(v is NSTextField) || v === intro { v.widthAnchor.constraint(equalToConstant: 476).isActive = true }
        w.contentView = content
        window = w
    }

    private func refresh() {
        let signedIn = Auth.shared.isSignedIn
        email.isEnabled = !signedIn; password.isEnabled = !signedIn; signInButton.isEnabled = !signedIn
        if signedIn { signInStatus.stringValue = "✓ Signed in" + (Auth.shared.email.map { " as \($0)" } ?? ""); signInStatus.textColor = .systemGreen }
        let ax = AXIsProcessTrusted(), disk = Permissions.fullDisk
        axStatus.stringValue = ax ? "✓ On" : "Off"; axStatus.textColor = ax ? .systemGreen : .systemOrange
        diskStatus.stringValue = disk ? "✓ On" : "Off"; diskStatus.textColor = disk ? .systemGreen : .systemOrange
        if allDone {
            footer.stringValue = "All set. You can close this window; the intern runs in the menu bar."
            (NSApp.delegate as? AppDelegate)?.permissionsChanged()
        } else {
            footer.stringValue = ""
        }
    }

    @objc private func signIn() {
        let e = email.stringValue.trimmingCharacters(in: .whitespaces), p = password.stringValue
        guard !e.isEmpty, !p.isEmpty else { return }
        signInButton.isEnabled = false
        signInStatus.stringValue = "Signing in…"; signInStatus.textColor = .secondaryLabelColor
        DispatchQueue.global().async {
            let problem = Auth.shared.signIn(email: e, password: p)
            DispatchQueue.main.async {
                self.password.stringValue = ""
                if let problem { self.signInStatus.stringValue = problem; self.signInStatus.textColor = .systemRed; self.signInButton.isEnabled = true }
                else { (NSApp.delegate as? AppDelegate)?.permissionsChanged() }
                self.refresh()
            }
        }
    }

    @objc private func openAccessibility() {
        // Asking is what puts the helper in the list, with its switch off.
        AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!)
    }
    @objc private func openFullDisk() {
        _ = Permissions.fullDisk
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")!)
    }

    func windowWillClose(_ notification: Notification) { timer?.invalidate(); timer = nil }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var item: NSStatusItem!
    private let setup = SetupWindow()
    private let server = LocalServer()
    private let statusLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let workerLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")

    func applicationDidFinishLaunching(_ notification: Notification) {
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.image = NSImage(systemSymbolName: "slider.horizontal.3", accessibilityDescription: "mixBASE Intern")
        let menu = NSMenu(); menu.delegate = self
        menu.addItem(statusLine); menu.addItem(workerLine); menu.addItem(.separator())
        menu.addItem(withTitle: "Setup…", action: #selector(showSetup), keyEquivalent: "").target = self
        menu.addItem(withTitle: "Show Log", action: #selector(showLog), keyEquivalent: "").target = self
        menu.addItem(withTitle: "Sign Out", action: #selector(signOut), keyEquivalent: "").target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit mixBASE Intern", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        item.menu = menu

        NotificationCenter.default.addObserver(forName: .internSignedOut, object: nil, queue: .main) { [weak self] _ in self?.showSetup() }
        server.start()
        Log.write("helper started; trusted=\(AXIsProcessTrusted()) fullDisk=\(Permissions.fullDisk) signedIn=\(Auth.shared.isSignedIn)")
        if setup.allDone { Worker.shared.start() } else { showSetup() }
    }

    /// Called as the setup window sees things change; starts the job loop once everything is in place.
    func permissionsChanged() { if setup.allDone { Worker.shared.start() } }

    func menuWillOpen(_ menu: NSMenu) {
        let s = AXBridge.shared.state()
        let missing = [(s["signed_in"] as? Bool == true) ? nil : "sign-in", (s["trusted"] as? Bool == true) ? nil : "Accessibility",
                       (s["full_disk"] as? Bool == true) ? nil : "Full Disk Access"].compactMap { $0 }
        statusLine.title = missing.isEmpty ? "Ready" : "Needs: " + missing.joined(separator: ", ")
        workerLine.title = Worker.shared.lastLine
    }

    @objc private func showSetup() { setup.show() }
    @objc private func showLog() { NSWorkspace.shared.open(Paths.logDir) }
    @objc private func signOut() { Worker.shared.stop(); Auth.shared.signOut(); setup.show() }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
