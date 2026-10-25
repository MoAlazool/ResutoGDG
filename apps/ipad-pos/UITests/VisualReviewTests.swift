import XCTest
import Foundation

/// Current-run UX evidence from the actual app using explicit synthetic test transport.
/// Host CoreSimulator captures avoid the cropped landscape PNGs returned by XCTest on this runner.
final class VisualReviewTests: XCTestCase {
    private let item = "11111111-1111-4111-8111-111111111111"
    private let branch = "22222222-2222-4222-8222-222222222222"
    private let order = "33333333-3333-4333-8333-333333333333"
    override func setUp() { super.setUp(); continueAfterFailure = false }
    private func element(_ app: XCUIApplication,_ id: String) -> XCUIElement {
        let b=app.buttons.matching(identifier:id).firstMatch
        return b.exists ? b : app.descendants(matching:.any).matching(identifier:id).firstMatch
    }
    private func tap(_ app: XCUIApplication,_ id: String) {
        var target=element(app,id)
        for _ in 0..<7 {
            if target.exists { break }
            app.collectionViews.allElementsBoundByIndex.last?.swipeUp();target=element(app,id)
        }
        XCTAssertTrue(target.waitForExistence(timeout:15),"Missing \(id)")
        if !target.isEnabled { expectation(for:NSPredicate(format:"enabled == true"),evaluatedWith:target);waitForExpectations(timeout:20) }
        target.tap()
    }
    private func capture(_ app: XCUIApplication,_ name: String) throws {
        XCTAssertTrue(element(app,"simulatedTestBanner").exists)
        let idle=NSPredicate { _,_ in !app.progressIndicators.firstMatch.exists }
        expectation(for:idle,evaluatedWith:nil);waitForExpectations(timeout:15)
        let directory=FileManager.default.urls(for:.documentDirectory,in:.userDomainMask)[0].appendingPathComponent("ResutoVisualRequests")
        try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true)
        let sequence=UUID().uuidString
        let data=try JSONSerialization.data(withJSONObject:["sequence":sequence,"name":name,"landscape":app.frame.width > app.frame.height,"requestedAt":Date().timeIntervalSince1970] as [String:Any])
        try data.write(to:directory.appendingPathComponent(sequence+".json"),options:.atomic)
        let ack=directory.appendingPathComponent(sequence+".ack.json")
        expectation(for:NSPredicate { _,_ in
            guard let bytes=try? Data(contentsOf:ack),let value=try? JSONSerialization.jsonObject(with:bytes) as? [String:String] else { return false }
            return value["sequence"] == sequence
        },evaluatedWith:nil);waitForExpectations(timeout:60)
        let attachment=XCTAttachment(screenshot:app.screenshot());attachment.name=name+"-XCTest-diagnostic";attachment.lifetime = .keepAlways;add(attachment)
    }
    private func launch(arabic: Bool) throws -> XCUIApplication {
        let app=XCUIApplication()
        app.launchArguments=["--resuto-ui-testing","--resuto-ui-reset","-AppleLanguages",arabic ? "(ar)" : "(en)"]
        app.launchEnvironment["RESUTO_UI_ROLE"]="manager"
        let directory=Bundle(for:Self.self).url(forResource:"menu",withExtension:"json",subdirectory:"Fixtures")!.deletingLastPathComponent()
        var fixtures:[String:Any]=[:]
        for name in ["menu","me","detail","orders","accepted","floor"] {
            fixtures[name]=try JSONSerialization.jsonObject(with:Data(contentsOf:directory.appendingPathComponent(name+".json")))
        }
        // Rich, deliberately synthetic catalogue. Never compiled into the application or sent to staging.
        var menu=fixtures["menu"] as! [String:Any]
        var base=(menu["products"] as! [[String:Any]])[0]
        base["name"]="Chicken burger";base["nameAr"]="برغر الدجاج"
        base["description"]="Grilled chicken, crisp lettuce and house sauce on a warm bun."
        base["descriptionAr"]="دجاج مشوي وخس مقرمش وصلصة خاصة في خبز دافئ."
        var products=[[String:Any]]();products.append(base)
        let names=[("Garden salad","سلطة الحديقة"),("Classic fries","بطاطس مقلية"),("Margherita pizza","بيتزا مارغريتا"),("Grilled chicken","دجاج مشوي"),("Fresh lemonade","ليمون طازج"),("Iced coffee","قهوة مثلجة"),("Chocolate cake","كعكة الشوكولاتة")]
        var categories=menu["categories"] as! [[String:Any]]
        for (i,n) in [("drinks",("Drinks","المشروبات")),("desserts",("Desserts","الحلويات"))] { categories.append(["id":i,"menuId":"menu","name":n.0,"nameAr":n.1,"isActive":true]) }
        for (index,n) in names.enumerated() {
            var p=base;p["id"]=String(format:"77777777-7777-4777-8777-%012d",index+1);p["name"]=n.0;p["nameAr"]=n.1;p["modifierGroupIds"]=[];p["categoryId"]=index==6 ? "desserts" : (index>=4 ? "drinks" : "category");products.append(p)
        }
        menu["products"]=products;menu["categories"]=categories;fixtures["menu"]=menu
        var detail=fixtures["detail"] as! [String:Any];var lines=detail["lines"] as! [[String:Any]];lines[0]["name"]=base["name"];lines[0]["nameAr"]=base["nameAr"];detail["lines"]=lines;fixtures["detail"]=detail
        app.launchEnvironment["RESUTO_UI_FIXTURES"]=String(data:try JSONSerialization.data(withJSONObject:fixtures),encoding:.utf8)
        XCUIDevice.shared.orientation = .landscapeLeft;app.launch()
        XCTAssertTrue(app.textFields["email"].waitForExistence(timeout:15))
        try capture(app,arabic ? "01-sign-in-ar" : "01-sign-in-en")
        app.textFields["email"].tap();app.textFields["email"].typeText("staff@resuto.test")
        let password=app.secureTextFields["password"];password.tap();XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout:10));password.tap();password.typeText("UITestOnly000!")
        tap(app,"signIn");tap(app,"restaurant.org")
        try capture(app,arabic ? "02-workspace-ar" : "02-workspace-en")
        tap(app,"branch."+branch)
        XCTAssertTrue(app.buttons["product."+item].waitForExistence(timeout:15))
        return app
    }
    func testEnglishOperationalScreens() throws {
        let app=try launch(arabic:false)
        try capture(app,"03-menu-en")
        tap(app,"product."+item);try capture(app,"04-customization-en");tap(app,"product.add")
        try capture(app,"05-cart-en");tap(app,"cart.review");try capture(app,"06-review-en");tap(app,"cart.confirm")
        tap(app,"nav.orders");XCTAssertTrue(app.buttons["order."+order].waitForExistence(timeout:15));try capture(app,"07-orders-en")
        tap(app,"order."+order);try capture(app,"08-checkout-en")
        tap(app,"checkout.reviewCash");tap(app,"checkout.confirmCash")
        let paid=app.staticTexts["order.paymentState"]
        for _ in 0..<6 { if paid.exists { break };app.collectionViews.allElementsBoundByIndex.last?.swipeDown() }
        XCTAssertTrue(paid.waitForExistence(timeout:15))
        expectation(for:NSPredicate(format:"label == 'Paid'"),evaluatedWith:paid);waitForExpectations(timeout:15)
        try capture(app,"09-paid-en");tap(app,"order.done")
        tap(app,"nav.kitchen");try capture(app,"10-kitchen-en")
        tap(app,"nav.floor");try capture(app,"11-floor-en")
        tap(app,"nav.pos");tap(app,"product."+item);tap(app,"product.add");tap(app,"cart.save")
        tap(app,"nav.sync");try capture(app,"12-local-draft-en")
        tap(app,"workspace.settings");try capture(app,"13-device-settings-en")
    }
    func testArabicOrderingScreens() throws {
        let app=try launch(arabic:true)
        try capture(app,"03-menu-ar");tap(app,"product."+item);try capture(app,"04-customization-ar");tap(app,"product.add")
        try capture(app,"05-cart-ar");tap(app,"cart.review");try capture(app,"06-review-ar")
    }
}
