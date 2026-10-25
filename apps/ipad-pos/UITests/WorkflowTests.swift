import XCTest

/// Deterministic client contract tests. These never assert that staging or physical hardware was verified.
final class WorkflowTests: XCTestCase {
    private let product = "11111111-1111-4111-8111-111111111111"
    private let branch = "22222222-2222-4222-8222-222222222222"
    private let order = "33333333-3333-4333-8333-333333333333"
    override func setUp() { super.setUp(); continueAfterFailure = false }
    private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        if id == "nav.settings", app.buttons["workspace.settings"].exists { return app.buttons["workspace.settings"] }
        let button = app.buttons.matching(identifier:id).firstMatch
        if button.exists { return button }
        let toggle = app.switches.matching(identifier:id).firstMatch
        if toggle.exists { return toggle }
        return app.descendants(matching:.any).matching(identifier:id).firstMatch
    }
    @discardableResult private func reveal(_ app: XCUIApplication, _ id: String, file: StaticString = #filePath, line: UInt = #line) -> XCUIElement? {
        var target = element(app,id)
        if !target.exists && !target.waitForExistence(timeout:2) {
            // SwiftUI Form lazily exposes rows. Scroll the frontmost form rather than assuming all rows exist.
            for _ in 0..<8 {
                let forms = app.collectionViews.allElementsBoundByIndex
                let identified = app.collectionViews.matching(identifier:id.hasPrefix("nav.") ? "workspace.sidebar" : "settings.form").firstMatch
                guard let form = identified.exists ? identified : (id.hasPrefix("nav.") ? forms.first : forms.last) else { break }
                form.swipeUp(); target = element(app,id)
                if target.exists || target.waitForExistence(timeout:1) { break }
            }
        }
        guard target.exists || target.waitForExistence(timeout:10) else { XCTFail("Missing \(id)\n\(app.debugDescription)",file:file,line:line); return nil }
        return target
    }
    private func tap(_ app: XCUIApplication, _ id: String,file: StaticString = #filePath,line: UInt = #line) {
        guard let target = reveal(app,id,file:file,line:line) else { return }
        if !target.isEnabled { expectation(for:NSPredicate(format:"enabled == true"),evaluatedWith:target); waitForExpectations(timeout:20) }
        if id == "nav.settings", !target.isHittable {
            expectation(for:NSPredicate(format:"hittable == true"),evaluatedWith:target); waitForExpectations(timeout:15)
        }
        target.tap()
    }
    private func assertOrderState(_ app: XCUIApplication,id: String,label: String,file: StaticString = #filePath,line: UInt = #line) {
        let state = app.staticTexts.matching(identifier:id).firstMatch
        for _ in 0..<6 {
            if state.exists && state.isHittable { break }
            app.collectionViews.allElementsBoundByIndex.last?.swipeDown()
        }
        XCTAssertTrue(state.waitForExistence(timeout:15),file:file,line:line)
        expectation(for:NSPredicate(format:"label == %@",label),evaluatedWith:state); waitForExpectations(timeout:15)
    }
    private func launch(reset: Bool = true, arabic: Bool = false, role: String = "manager", scenario: String = "normal", accessibilityText: Bool = false) throws -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--resuto-ui-testing"] + (reset ? ["--resuto-ui-reset"] : []) + ["-AppleLanguages", arabic ? "(ar)" : "(en)"]
        if accessibilityText { app.launchArguments += ["-UIPreferredContentSizeCategoryName","UICTContentSizeCategoryAccessibilityXXXL"] }
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
            let email = app.textFields["email"]; XCTAssertTrue(email.waitForExistence(timeout: 15))
            if !email.isEnabled { expectation(for:NSPredicate(format:"enabled == true"),evaluatedWith:email); waitForExpectations(timeout:15) }
            email.tap(); email.typeText("staff@resuto.test")
            let password = app.secureTextFields["password"]; password.tap()
            XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout:10)); password.tap(); password.typeText("UITestOnly000!")
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
        assertOrderState(app,id:"order.status",label:"Accepted")
        tap(app,"checkout.reviewCash"); tap(app,"checkout.confirmCash")
        assertOrderState(app,id:"order.paymentState",label:"Paid")
        tap(app,"receipt.enqueue"); tap(app,"order.done"); tap(app,"nav.settings")
        XCTAssertNotNil(reveal(app,"Waiting to print"))
        attach(app,"simulated-order-payment-receipt")
    }
    func testRefundRequestNeedsManualCompletionAndDoesNotReversePaidState() throws {
        let app = try launch()
        tap(app,"product." + product); tap(app,"product.add"); tap(app,"cart.review"); tap(app,"cart.confirm")
        tap(app,"nav.orders"); tap(app,"order." + order)
        tap(app,"checkout.reviewCash"); tap(app,"checkout.confirmCash")
        assertOrderState(app,id:"order.paymentState",label:"Paid")
        tap(app,"refund.open.payment")
        let amount = app.textFields["refund.amount"]; XCTAssertTrue(amount.waitForExistence(timeout:10)); amount.tap(); amount.typeText("1.00")
        let reason = app.textFields["refund.reason"]; reason.tap(); reason.typeText("Customer request")
        tap(app,"refund.review"); tap(app,"refund.confirm")
        let state = reveal(app,"refund.state")
        XCTAssertEqual(state?.label,"Refund: Manual completion required")
        assertOrderState(app,id:"order.paymentState",label:"Paid")
        attach(app,"simulated-refund-manual-pending")
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
        let restoredReview = element(app,"cart.review")
        expectation(for:NSPredicate(format:"enabled == true"),evaluatedWith:restoredReview); waitForExpectations(timeout:20)
        tap(app,"nav.orders")
        XCTAssertFalse(element(app,"order." + order).exists, "A restored cart must not silently submit")
    }
    func testAvailabilityIsServerRefreshedAndReversible() throws {
        let app = try launch()
        tap(app,"nav.availability")
        tap(app,"availability." + product)
        tap(app,"nav.pos")
        expectation(for:NSPredicate(format:"enabled == false"),evaluatedWith:app.buttons["product." + product]); waitForExpectations(timeout:15)
        tap(app,"nav.availability"); tap(app,"availability." + product); tap(app,"nav.pos")
        XCTAssertTrue(element(app,"product." + product).isEnabled)
    }
    func testFloorListSelectionPreservesDineInContext() throws {
        let app = try launch()
        tap(app,"nav.floor"); tap(app,"floor.mode")
        XCTAssertTrue(element(app,"floor.list").exists)
        tap(app,"table.table"); tap(app,"floor.order")
        XCTAssertTrue(app.staticTexts["T1"].waitForExistence(timeout:10))
        attach(app,"simulated-floor-list")
    }
    func testArabicAccessibilityTextUsesTableList() throws {
        let app = try launch(arabic:true,accessibilityText:true)
        tap(app,"nav.floor")
        XCTAssertFalse(app.buttons["floor.mode"].exists,"Accessibility text uses a list without scaled map labels")
        let table = app.buttons["table.table"]
        XCTAssertTrue(table.waitForExistence(timeout:15)); XCTAssertTrue(table.isHittable)
        tap(app,"table.table")
        XCTAssertTrue(app.buttons["floor.order"].waitForExistence(timeout:10))
        attach(app,"simulated-arabic-accessibility-floor")
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
    func testAmbiguousServerOrderSurvivesForceCloseWithoutDuplicate() throws {
        var app = try launch(scenario:"lost-order-until-relaunch")
        tap(app,"product." + product); tap(app,"product.add"); tap(app,"cart.review"); tap(app,"cart.confirm")
        tap(app,"nav.orders")
        let rows = app.buttons.matching(NSPredicate(format:"identifier BEGINSWITH %@","order."))
        XCTAssertTrue(rows.firstMatch.waitForExistence(timeout:20))
        let originalServerID = rows.firstMatch.identifier
        app.terminate(); XCTAssertTrue(app.wait(for:.notRunning,timeout:15))
        app = try launch(reset:false,scenario:"lost-order-until-relaunch")
        tap(app,"nav.sync")
        XCTAssertTrue(element(app,"sync.state.accepted").waitForExistence(timeout:20))
        tap(app,"nav.orders")
        XCTAssertTrue(app.buttons[originalServerID].waitForExistence(timeout:15))
        XCTAssertEqual(app.buttons.matching(NSPredicate(format:"identifier BEGINSWITH %@","order.")).count,1)
        attach(app,"simulated-force-close-same-server-order")
    }
    func testLostCashResponseRequiresExplicitSameKeyRecovery() throws {
        let app = try launch(scenario:"lost-cash-response")
        tap(app,"product." + product); tap(app,"product.add"); tap(app,"cart.review"); tap(app,"cart.confirm")
        tap(app,"nav.orders"); tap(app,"order." + order)
        tap(app,"checkout.reviewCash"); tap(app,"checkout.confirmCash"); tap(app,"order.done")
        tap(app,"nav.settings")
        XCTAssertNotNil(reveal(app,"financial.retry"),"Ambiguous cash must retain its original intent")
        tap(app,"financial.retry"); tap(app,"financial.confirmRetry")
        let cleared = NSPredicate(format:"exists == false")
        expectation(for:cleared,evaluatedWith:element(app,"financial.retry")); waitForExpectations(timeout:15)
        tap(app,"nav.orders"); tap(app,"order." + order)
        assertOrderState(app,id:"order.paymentState",label:"Paid")
        attach(app,"simulated-cash-same-key-reconciled")
    }
    func testPairedStaffSessionReadOnlyShadowAndLocalForget() throws {
        let app = try launch()
        tap(app,"nav.settings")
        let field = try XCTUnwrap(reveal(app,"pairing.code")); field.tap(); field.typeText("ABCDE-FGHJK")
        tap(app,"pairing.submit")
        XCTAssertTrue(element(app,"device.state.active").waitForExistence(timeout:20))
        XCTAssertTrue(element(app,"device.shadow.ready").waitForExistence(timeout:20))
        attach(app,"simulated-paired-staff-read-only-shadow")
        tap(app,"device.forget"); tap(app,"device.confirmForget")
        XCTAssertTrue(element(app,"device.state.none").waitForExistence(timeout:15))
        tap(app,"nav.pos"); XCTAssertTrue(app.buttons["product." + product].exists,"Local device forget must preserve staff sign-in")
    }
    func testHostCannotEnterPOSKitchenOrPayments() throws {
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
