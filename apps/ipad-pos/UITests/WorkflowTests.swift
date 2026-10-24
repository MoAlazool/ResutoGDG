import XCTest

/// Deterministic client contract tests. These never assert that staging or physical hardware was verified.
final class WorkflowTests: XCTestCase {
    private let product = "11111111-1111-4111-8111-111111111111"
    private let branch = "22222222-2222-4222-8222-222222222222"
    private let order = "33333333-3333-4333-8333-333333333333"
    override func setUp() { super.setUp(); continueAfterFailure = false }
    private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        let button = app.buttons.matching(identifier:id).firstMatch
        if button.exists { return button }
        let toggle = app.switches.matching(identifier:id).firstMatch
        if toggle.exists { return toggle }
        return app.descendants(matching:.any).matching(identifier:id).firstMatch
    }
    private func tap(_ app: XCUIApplication, _ id: String, file: StaticString = #filePath, line: UInt = #line) {
        var target = element(app,id)
        if !target.waitForExistence(timeout:2) {
            // SwiftUI Form lazily exposes rows. Scroll the frontmost form rather than assuming all rows exist.
            for _ in 0..<8 {
                guard let form = app.collectionViews.allElementsBoundByIndex.last else { break }
                form.swipeUp(); target = element(app,id)
                if target.waitForExistence(timeout:1) { break }
            }
        }
        guard target.waitForExistence(timeout:10) else { XCTFail("Missing \(id)\n\(app.debugDescription)",file:file,line:line); return }
        target.tap()
    }
    private func launch(reset: Bool = true, arabic: Bool = false, role: String = "manager", scenario: String = "normal") throws -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--resuto-ui-testing"] + (reset ? ["--resuto-ui-reset"] : []) + ["-AppleLanguages", arabic ? "(ar)" : "(en)"]
        app.launchEnvironment["RESUTO_UI_ROLE"] = role
        app.launchEnvironment["RESUTO_UI_SCENARIO"] = scenario
        let fixtureURL = Bundle(for: WorkflowTests.self).url(forResource: "menu", withExtension: "json", subdirectory: "Fixtures")!
        var fixtures: [String: Any] = [:]
        for name in ["menu","me","detail","orders","accepted","floor"] {
            let url = fixtureURL.deletingLastPathComponent().appendingPathComponent(name + ".json")
            fixtures[name] = try JSONSerialization.jsonObject(with: Data(contentsOf: url))
        }
        app.launchEnvironment["RESUTO_UI_FIXTURES"] = String(data: try JSONSerialization.data(withJSONObject: fixtures), encoding: .utf8)
        XCUIDevice.shared.orientation = .landscapeLeft; app.launch()
        XCTAssertTrue(element(app, "simulatedTestBanner").waitForExistence(timeout: 15))
        if reset {
            let email = app.textFields["email"]; XCTAssertTrue(email.waitForExistence(timeout: 15)); email.tap(); email.typeText("staff@resuto.test")
            let password = app.secureTextFields["password"]; password.tap(); password.typeText("UITestOnly000!")
            tap(app,"signIn")
        }
        tap(app,"restaurant.org"); tap(app,"branch." + branch)
        return app
    }
    func testOrderKitchenStatusCashAndReceiptThroughClientContracts() throws {
        let app = try launch()
        tap(app,"product." + product); tap(app,"product.add")
        tap(app,"cart.review"); tap(app,"cart.confirm")
        tap(app,"nav.kitchen"); tap(app,"kitchen.open." + order)
        tap(app,"order.advance")
        XCTAssertTrue(app.staticTexts["Accepted"].waitForExistence(timeout: 15))
        tap(app,"checkout.reviewCash"); tap(app,"checkout.confirmCash")
        XCTAssertTrue(app.staticTexts["Paid"].waitForExistence(timeout: 15))
        tap(app,"receipt.enqueue"); tap(app,"order.done"); tap(app,"nav.settings")
        XCTAssertTrue(app.staticTexts["Waiting to print"].waitForExistence(timeout: 15))
        attach(app,"simulated-order-payment-receipt")
    }
    func testArabicOrderEntryAndRotation() throws {
        let app = try launch(arabic: true)
        XCTAssertTrue(app.staticTexts["نقطة البيع"].waitForExistence(timeout: 15))
        tap(app,"product." + product)
        XCTAssertTrue(app.staticTexts["عادي"].waitForExistence(timeout: 10))
        tap(app,"product.add")
        XCUIDevice.shared.orientation = .portrait
        XCTAssertTrue(element(app,"cart.save").waitForExistence(timeout: 15))
        attach(app,"simulated-arabic-order-entry")
    }
    func testDraftSurvivesTerminationWithoutBecomingServerOrder() throws {
        var app = try launch()
        tap(app,"product." + product); tap(app,"product.add")
        app.terminate(); XCTAssertTrue(app.wait(for: .notRunning, timeout: 15))
        app = try launch(reset: false)
        XCTAssertTrue(element(app,"cart.review").isEnabled)
        tap(app,"nav.orders")
        XCTAssertFalse(element(app,"order." + order).exists, "A restored cart must not silently submit")
    }
    func testAvailabilityIsServerRefreshedAndReversible() throws {
        let app = try launch()
        tap(app,"nav.availability")
        tap(app,"availability." + product)
        tap(app,"nav.pos")
        XCTAssertFalse(element(app,"product." + product).isEnabled)
        tap(app,"nav.availability"); tap(app,"availability." + product); tap(app,"nav.pos")
        XCTAssertTrue(element(app,"product." + product).isEnabled)
    }
    func testDineInTableSelectionAndOrderSubmission() throws {
        let app = try launch()
        tap(app,"nav.floor"); tap(app,"table.table"); tap(app,"floor.order")
        XCTAssertTrue(app.staticTexts["T1"].waitForExistence(timeout:10))
        tap(app,"product." + product); tap(app,"product.add"); tap(app,"cart.review"); tap(app,"cart.confirm")
        tap(app,"nav.orders"); tap(app,"order." + order)
        XCTAssertTrue(app.staticTexts["Placed"].waitForExistence(timeout:15))
        attach(app,"simulated-dine-in-order")
    }
    func testEnglishAndArabicAccessibilityDescriptions() throws {
        for arabic in [false,true] {
            let app = try launch(arabic:arabic)
            try app.performAccessibilityAudit(for:[.sufficientElementDescription])
            attach(app,arabic ? "simulated-arabic-accessibility" : "simulated-english-accessibility")
            app.terminate()
        }
    }
    func testLostOrderResponseReplaysOriginalKeyWithoutDuplicate() throws {
        let app = try launch(scenario:"lost-order-response")
        tap(app,"product." + product); tap(app,"product.add"); tap(app,"cart.review"); tap(app,"cart.confirm")
        tap(app,"nav.sync")
        XCTAssertTrue(element(app,"sync.state.accepted").waitForExistence(timeout:30))
        tap(app,"nav.orders")
        XCTAssertTrue(element(app,"order." + order).waitForExistence(timeout:15))
        XCTAssertEqual(app.descendants(matching:.any).matching(identifier:"order." + order).count,1)
        attach(app,"simulated-lost-response-original-key-reconciled")
    }
    func testLostCashResponseRequiresExplicitSameKeyRecovery() throws {
        let app = try launch(scenario:"lost-cash-response")
        tap(app,"product." + product); tap(app,"product.add"); tap(app,"cart.review"); tap(app,"cart.confirm")
        tap(app,"nav.orders"); tap(app,"order." + order)
        tap(app,"checkout.reviewCash"); tap(app,"checkout.confirmCash"); tap(app,"order.done")
        tap(app,"nav.settings")
        XCTAssertTrue(element(app,"financial.retry").waitForExistence(timeout:15),"Ambiguous cash must retain its original intent")
        tap(app,"financial.retry"); tap(app,"financial.confirmRetry")
        let cleared = NSPredicate(format:"exists == false")
        expectation(for:cleared,evaluatedWith:element(app,"financial.retry")); waitForExpectations(timeout:15)
        tap(app,"nav.orders"); tap(app,"order." + order)
        XCTAssertTrue(app.staticTexts["Paid"].waitForExistence(timeout:15))
        attach(app,"simulated-cash-same-key-reconciled")
    }
    func testHostCannotEnterOrdersOrPayments() throws {
        let app = try launch(role: "host")
        XCTAssertFalse(element(app,"nav.pos").exists)
        XCTAssertFalse(element(app,"nav.kitchen").exists)
        XCTAssertFalse(element(app,"checkout.reviewCash").exists)
        attach(app,"simulated-host-permissions")
    }
    private func attach(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot()); attachment.name = name + "-NOT-STAGING"; attachment.lifetime = .keepAlways; add(attachment)
    }
}
