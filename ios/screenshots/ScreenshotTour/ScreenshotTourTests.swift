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

        // 1. Home: stats, tracks carousel, recent activity.
        expect(app.tabBars.buttons["Home"], "the tab bar after sign-in", timeout: 60)
        expect(labeled("Recent Activity"), "Home content", timeout: 40)
        settle(8)
        snap("home")

        // 2. Projects grid.
        tap(app.tabBars.buttons["Projects"], "the Projects tab")
        let firstCard = labeled("KICK IT W/U")
        expect(firstCard, "the project grid", timeout: 30)
        settle(6)
        snap("projects")

        // 3. Project detail with the version history expanded.
        tap(firstCard, "the first project card")
        let playLatest = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Play Latest'")).firstMatch
        expect(playLatest, "the project detail screen", timeout: 30)
        let history = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Version History'")).firstMatch
        if history.waitForExistence(timeout: 5) { history.tap() }
        settle(5)
        snap("project")

        // 4. Now Playing: start the latest mix, then open the full player.
        tap(playLatest, "Play Latest")
        settle(3)
        tap(app.tabBars.buttons["Player"], "the Player tab")
        expect(labeled("KICK IT W/U"), "the now-playing title", timeout: 30)
        settle(8)
        snap("player")

        // 5. Pipeline board.
        tap(app.tabBars.buttons["Pipeline"], "the Pipeline tab")
        expect(labeled("Released Library"), "the pipeline", timeout: 30)
        settle(6)
        snap("pipeline")

        // 6. Artwork library.
        tap(app.tabBars.buttons["Artwork"], "the Artwork tab")
        expect(app.navigationBars["Artwork"], "the artwork library", timeout: 30)
        settle(7)
        snap("artwork")

        // 7. Community feed (reached from Home).
        tap(app.tabBars.buttons["Home"], "the Home tab")
        let feedButton = app.buttons["mixBASE Feed"]
        expect(feedButton, "the feed button on Home", timeout: 20)
        tap(feedButton, "the feed button")
        expect(app.navigationBars["mixBASE Feed"], "the feed", timeout: 30)
        settle(8)
        snap("feed")

        // 8. Home again, now with the ambient now-playing backdrop.
        let back = app.navigationBars["mixBASE Feed"].buttons.firstMatch
        if back.waitForExistence(timeout: 5) { back.tap() }
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
