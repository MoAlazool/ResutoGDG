import XCTest
final class ResutoPOSUITests: XCTestCase {
    func testLaunchRequiresAuthenticatedSession() {
        let app = XCUIApplication(); app.launch()
        XCTAssertTrue(app.textFields["email"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.secureTextFields["password"].exists)
        XCTAssertFalse(app.buttons["signIn"].isEnabled)
    }
    func testArabicLaunchAndRotation() {
        let app = XCUIApplication(); app.launchArguments += ["-AppleLanguages", "(ar)", "-AppleLocale", "ar_EG@numbers=latn"]
        app.launch()
        XCTAssertTrue(app.staticTexts["مرحباً بك في ريسوتو"].waitForExistence(timeout: 15))
        XCUIDevice.shared.orientation = .landscapeLeft
        XCTAssertTrue(app.textFields["email"].waitForExistence(timeout: 15))
        XCUIDevice.shared.orientation = .portrait
        XCTAssertTrue(app.secureTextFields["password"].exists)
    }
    func testNoCredentialsInScreenshots() {
        let app = XCUIApplication(); app.launch()
        XCTAssertTrue(app.textFields["email"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.staticTexts["Welcome Detail"].exists)
        let attachment = XCTAttachment(screenshot: app.screenshot()); attachment.name = "welcome-ipad"; attachment.lifetime = .keepAlways; add(attachment)
    }
    func testLaunchPerformance() {
        let app = XCUIApplication()
        let options = XCTMeasureOptions(); options.iterationCount = 3
        measure(metrics: [XCTApplicationLaunchMetric(waitUntilResponsive: true)], options: options) {
            app.launch()
            app.terminate()
            XCTAssertTrue(app.wait(for: .notRunning, timeout: 15), "Simulator must finish terminating before the next launch sample")
        }
    }
}
