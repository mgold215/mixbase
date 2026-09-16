import XCTest

/// Walks the signed-in mixBase app and saves App Store screenshots.
///
/// Driven entirely by environment variables that xcodebuild forwards from
/// TEST_RUNNER_*: MIXBASE_EMAIL / MIXBASE_PASSWORD (the App Review demo login,
/// which the workflow reads from App Store Connect) and SCREENSHOT_DIR (a host
/// directory the PNGs are written to; simulator processes can write anywhere
/// the runner user can). The app must already be installed on the simulator —
/// this bundle has no host application and launches it by bundle id.
///
/// Screens, in order: Home, Projects, Project detail (version history open),
/// Now Playing, Pipeline, Artwork, Feed, Home again with the ambient backdrop.
final class ScreenshotTourTests: XCTestCase {

    private let app = XCUIApplication(bundleIdentifier: "com.moodmixformat.mixbase")
    private var outDir: URL!
    private var shotIndex = 0
    /// Anchors that never appeared. The tour keeps going (a screenshot of
    /// whatever is on screen is still useful) and fails at the end.
    private var misses: [String] = []

    override func setUpWithError() throws {
        continueAfterFailure = false
        let env = ProcessInfo.processInfo.environment
        let dir = env["SCREENSHOT_DIR"].flatMap { $0.isEmpty ? nil : $0 }
            ?? (NSTemporaryDirectory() as NSString).appendingPathComponent("mixbase-screenshots")
        outDir = URL(fileURLWithPath: dir, isDirectory: true)
        try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

        // A system permission alert would otherwise stall the whole tour.
        addUIInterruptionMonitor(withDescription: "system alert") { alert in
            for label in ["Allow", "OK", "Allow While Using App", "Not Now", "Don't Allow"] {
                let button = alert.buttons[label]
                if button.exists { button.tap(); return true }
            }
            return false
        }
    }

    func testTour() throws {
        let env = ProcessInfo.processInfo.environment
        guard let email = env["MIXBASE_EMAIL"], !email.isEmpty,
              let password = env["MIXBASE_PASSWORD"], !password.isEmpty else {
            throw XCTSkip("MIXBASE_EMAIL / MIXBASE_PASSWORD not provided")
        }

        app.launch()
        signIn(email: email, password: password)

        // 1. Home: stats, tracks carousel, recent activity. The first sign-in
        //    on a fresh simulator raises the Passwords "Save Password?" sheet.
        expect(app.tabBars.buttons["Home"], "the tab bar after sign-in", timeout: 60)
        dismissSystemPrompts(within: 6)
        expect(labeled("Recent Activity"), "Home content", timeout: 40)
        settle(8)
        snap("home")

        // 2. Projects grid.
        openTab("Projects", anchor: app.navigationBars["Projects"], "the Projects tab")
        let firstCard = labeled("KICK IT W/U")
        expect(firstCard, "the project grid", timeout: 30)
        settle(6)
        snap("projects")

        // 3. Project detail, then the same screen scrolled down with the
        //    version history and the feedback opened up (both sit below the
        //    fold, so scroll before tapping).
        tap(firstCard, "the first project card")
        let playLatest = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Play Latest'")).firstMatch
        expect(playLatest, "the project detail screen", timeout: 30)
        settle(4)
        snap("project")
        app.swipeUp()
        settle(3)
        let historyRow = labeled("ROUGH MIX")
        let historyHeader = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Version History'")).firstMatch
        if historyHeader.waitForExistence(timeout: 5) {
            // One tap opens it; a second would close it again, so wait for the
            // rows after each attempt and fall back to a coordinate tap.
            historyHeader.tap()
            if !historyRow.waitForExistence(timeout: 5) {
                historyHeader.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.5)).tap()
                _ = historyRow.waitForExistence(timeout: 5)
            }
            print("TOUR: version history expanded = \(historyRow.exists)")
        }
        expect(labeled("ROUGH MIX"), "the expanded version history", timeout: 5)
        let responses = app.buttons.matching(NSPredicate(format: "label CONTAINS 'responses'")).firstMatch
        if responses.waitForExistence(timeout: 3) {
            responses.tap()
            _ = labeled("Dani").waitForExistence(timeout: 4)
            print("TOUR: feedback expanded = \(labeled("Dani").exists)")
        }
        settle(3)
        snap("project-versions")

        // 4. Now Playing: start the latest mix, then open the full player.
        tap(playLatest, "Play Latest")
        settle(3)
        openTab("Player", anchor: app.buttons["Share"], "the Player tab")
        expect(labeled("KICK IT W/U"), "the now-playing title", timeout: 30)
        settle(8)
        snap("player")

        // 5. Pipeline board.
        openTab("Pipeline", anchor: labeled("Released Library"), "the Pipeline tab")
        settle(6)
        snap("pipeline")

        // 6. Artwork library.
        openTab("Artwork", anchor: app.navigationBars["Artwork"], "the Artwork tab")
        settle(7)
        snap("artwork")

        // 7. Community feed (reached from the Home root).
        let feedButton = app.buttons["mixBASE Feed"]
        openTab("Home", anchor: feedButton, "the Home tab")
        popToRoot(until: feedButton)
        expect(feedButton, "the feed button on Home", timeout: 20)
        tap(feedButton, "the feed button")
        expect(app.navigationBars["mixBASE Feed"], "the feed", timeout: 30)
        settle(8)
        snap("feed")

        // 8. Home again, now with the ambient now-playing backdrop.
        popToRoot(until: feedButton)
        expect(labeled("Recent Activity"), "Home after the feed", timeout: 20)
        settle(5)
        snap("home-playing")

        XCTAssertTrue(misses.isEmpty, "Never saw: \(misses.joined(separator: "; ")) — see diag-*.png / diag-*.txt")
    }

    // MARK: - Steps

    private func signIn(email: String, password: String) {
        let emailField = app.textFields["you@example.com"]
        guard emailField.waitForExistence(timeout: 30) else {
            // No login screen: a session was restored from the Keychain.
            return
        }
        emailField.tap()
        emailField.typeText(email)
        let passwordField = app.secureTextFields.firstMatch
        XCTAssertTrue(passwordField.waitForExistence(timeout: 10), "Missing the password field")
        passwordField.tap()
        passwordField.typeText(password)
        let signIn = app.buttons["Sign in"]
        XCTAssertTrue(signIn.waitForExistence(timeout: 10), "Missing the Sign in button")
        signIn.tap()
    }

    /// Any element whose accessibility label contains `text` — SwiftUI often
    /// folds a card's texts into one button label, so plain staticTexts
    /// queries miss them.
    private func labeled(_ text: String) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS[c] %@", text))
            .firstMatch
    }

    /// System sheets (the Passwords "Save Password?" prompt after the first
    /// sign-in, permission alerts) live in SpringBoard, outside the app's tree,
    /// and swallow the next tap if left up. Checks both hosts for a while.
    private func dismissSystemPrompts(within timeout: TimeInterval) {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            for host in [springboard, app] {
                for label in ["Not Now", "Allow", "OK", "Don't Allow"] {
                    let button = host.buttons[label]
                    if button.exists && button.isHittable {
                        button.tap()
                        print("TOUR: dismissed a '\(label)' prompt")
                        settle(1)
                        return dismissSystemPrompts(within: 2)
                    }
                }
            }
            settle(0.5)
        } while Date() < deadline
    }

    /// Selects a tab and verifies its content appeared; a prompt or a stale
    /// pushed screen can eat the first tap, so it retries.
    private func openTab(_ name: String, anchor: XCUIElement, _ what: String) {
        for attempt in 1...3 {
            dismissSystemPrompts(within: attempt == 1 ? 2 : 1)
            let button = app.tabBars.buttons[name]
            if button.waitForExistence(timeout: 10) { button.tap() }
            if anchor.waitForExistence(timeout: 12) { return }
        }
        misses.append(what)
        diagnose(what)
    }

    /// Pops pushed screens on the current tab until `anchor` (a root-only
    /// element) shows up.
    private func popToRoot(until anchor: XCUIElement) {
        for _ in 0..<4 where !anchor.exists {
            let back = app.navigationBars.buttons.matching(identifier: "BackButton").firstMatch
            guard back.waitForExistence(timeout: 3) else { return }
            back.tap()
            settle(1.5)
        }
    }

    /// Waits for an anchor element. A miss is recorded with a screenshot and
    /// the accessibility tree so the run explains itself, then the tour goes on.
    @discardableResult
    private func expect(_ element: XCUIElement, _ what: String, timeout: TimeInterval) -> Bool {
        if element.waitForExistence(timeout: timeout) { return true }
        misses.append(what)
        diagnose(what)
        return false
    }

    private func tap(_ element: XCUIElement, _ what: String) {
        if element.waitForExistence(timeout: 10) {
            element.tap()
        } else {
            misses.append(what)
            diagnose(what)
        }
    }

    private func diagnose(_ what: String) {
        let slug = what.replacingOccurrences(of: "[^A-Za-z0-9]+", with: "-", options: .regularExpression).lowercased()
        let shot = XCUIScreen.main.screenshot()
        try? shot.pngRepresentation.write(to: outDir.appendingPathComponent("diag-\(slug).png"))
        let tree = "app state: \(app.state.rawValue) (2 = not running, 4 = foreground)\n\n" + app.debugDescription
        try? tree.write(to: outDir.appendingPathComponent("diag-\(slug).txt"), atomically: true, encoding: .utf8)
        print("TOUR-DIAG \(what): app state \(app.state.rawValue)")
    }

    /// Give async images and lists time to load before the capture.
    private func settle(_ seconds: TimeInterval) {
        RunLoop.current.run(until: Date().addingTimeInterval(seconds))
    }

    private func snap(_ name: String) {
        dismissSystemPrompts(within: 1)
        shotIndex += 1
        let shot = XCUIScreen.main.screenshot()
        let file = outDir.appendingPathComponent(String(format: "%02d-%@.png", shotIndex, name))
        do {
            try shot.pngRepresentation.write(to: file)
        } catch {
            XCTFail("Could not write \(file.path): \(error)")
        }
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
