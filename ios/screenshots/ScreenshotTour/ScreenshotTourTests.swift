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
        require(app.tabBars.buttons["Home"], "the tab bar after sign-in", timeout: 60)
        require(app.staticTexts["Recent Activity"], "Home content", timeout: 30)
        settle(8)
        snap("home")

        // 2. Projects grid.
        app.tabBars.buttons["Projects"].tap()
        let firstCard = labeled("KICK IT W/U")
        require(firstCard, "the project grid", timeout: 30)
        settle(6)
        snap("projects")

        // 3. Project detail with the version history expanded.
        firstCard.tap()
        let playLatest = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Play Latest'")).firstMatch
        require(playLatest, "the project detail screen", timeout: 30)
        let history = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Version History'")).firstMatch
        if history.waitForExistence(timeout: 5) { history.tap() }
        settle(5)
        snap("project")

        // 4. Now Playing: start the latest mix, then open the full player.
        playLatest.tap()
        settle(3)
        app.tabBars.buttons["Player"].tap()
        require(labeled("KICK IT W/U"), "the now-playing title", timeout: 30)
        settle(8)
        snap("player")

        // 5. Pipeline board.
        app.tabBars.buttons["Pipeline"].tap()
        require(labeled("Released Library"), "the pipeline", timeout: 30)
        settle(6)
        snap("pipeline")

        // 6. Artwork library.
        app.tabBars.buttons["Artwork"].tap()
        require(app.navigationBars["Artwork"], "the artwork library", timeout: 30)
        settle(7)
        snap("artwork")

        // 7. Community feed (reached from Home).
        app.tabBars.buttons["Home"].tap()
        let feedButton = app.buttons["mixBASE Feed"]
        require(feedButton, "the feed button on Home", timeout: 20)
        feedButton.tap()
        require(app.navigationBars["mixBASE Feed"], "the feed", timeout: 30)
        settle(8)
        snap("feed")

        // 8. Home again, now with the ambient now-playing backdrop.
        let back = app.navigationBars["mixBASE Feed"].buttons.firstMatch
        if back.waitForExistence(timeout: 5) { back.tap() }
        require(app.staticTexts["Recent Activity"], "Home after the feed", timeout: 20)
        settle(5)
        snap("home-playing")
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

    private func require(_ element: XCUIElement, _ what: String, timeout: TimeInterval) {
        XCTAssertTrue(element.waitForExistence(timeout: timeout), "Never saw \(what)")
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
