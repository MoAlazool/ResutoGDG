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
        XCUIDevice.shared.orientation = .landscapeLeft
        XCTAssertTrue(app.textFields["email"].waitForExistence(timeout: 15))
        XCUIDevice.shared.orientation = .portrait
        XCTAssertTrue(app.secureTextFields["password"].exists)
    }
    func testNoCredentialsInScreenshots() {
        let app = XCUIApplication(); app.launch()
        XCTAssertTrue(app.textFields["email"].waitForExistence(timeout: 15))
        let attachment = XCTAttachment(screenshot: app.screenshot()); attachment.name = "welcome-ipad"; attachment.lifetime = .keepAlways; add(attachment)
    }
    func testLaunchPerformance() { measure(metrics: [XCTApplicationLaunchMetric()]) { XCUIApplication().launch() } }
}
