import XCTest
@testable import ResutoCore
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

final class MemoryStore: DataStore, SecretStore, @unchecked Sendable {
    private let lock = NSLock(); private var values: [String: Data] = [:]
    var fail = false
    func read() throws -> Data? { try read("data") }
    func write(_ data: Data) throws { try write(data, key: "data") }
    func read(_ key: String) throws -> Data? { lock.lock(); defer { lock.unlock() }; return values[key] }
    func write(_ data: Data, key: String) throws { lock.lock(); defer { lock.unlock() }; if fail { throw RuleError.invalid("disk_full") }; values[key] = data }
    func remove(_ key: String) throws { lock.lock(); defer { lock.unlock() }; values.removeValue(forKey: key) }
}
func fixture(_ name: String) throws -> Data { try Data(contentsOf: Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures")!) }
func decode<T: Decodable>(_ name: String, _: T.Type = T.self) throws -> T { try JSONDecoder().decode(T.self, from: fixture(name)) }
let branchID = "22222222-2222-4222-8222-222222222222"
let productID = "11111111-1111-4111-8111-111111111111"
func payload(quantity: Int = 1, modifiers: [ModifierSelection] = [ModifierSelection(groupId: "group", optionId: "option")]) -> StaffOrder { StaffOrder(branchId: branchID, fulfillment: "pickup", lines: [CartLine(productId: productID, quantity: quantity, modifiers: modifiers)]) }
func scope(user: String = "user", org: String = "org", environment: String = "https://api.example/v1") -> Scope { Scope(environment: environment, userId: user, orgId: org, branchId: branchID) }
actor Submitter: OrderSubmitting {
    var calls: [PendingOrder] = []; var failures = 0; var status = 503
    func fail(_ count: Int, status: Int = 503) { failures = count; self.status = status }
    func submit(_ op: PendingOrder) async throws -> OrderAccepted {
        calls.append(op)
        if failures > 0 { failures -= 1; throw APIError(status: status, code: "server_failure", message: "failure", retryAfter: 120) }
        return try decode("accepted")
    }
}
actor ScriptedTransport: HTTPTransport {
    var results: [HTTPResult]; var requests: [URLRequest] = []
    init(_ results: [HTTPResult]) { self.results = results }
    func send(_ request: URLRequest) async throws -> HTTPResult {
        requests.append(request)
        guard !results.isEmpty else { throw URLError(.notConnectedToInternet) }
        return results.removeFirst()
    }
}
final class DomainTests: XCTestCase {
    func testBranchOverrideAndRequiredModifier() throws { XCTAssertEqual(try CartRules.estimate(payload(quantity: 2), menu: decode("menu")), 18300) }
    func testRequiredModifierCannotBeOmitted() throws { XCTAssertThrowsError(try CartRules.estimate(payload(modifiers: []), menu: decode("menu"))) }
    func testForeignModifierRejected() throws { XCTAssertThrowsError(try CartRules.estimate(payload(modifiers: [.init(groupId: "other", optionId: "option")]), menu: decode("menu"))) }
    func testDuplicateModifierRejected() throws { let option = ModifierSelection(groupId: "group", optionId: "option"); XCTAssertThrowsError(try CartRules.estimate(payload(modifiers: [option, option]), menu: decode("menu"))) }
    func testQuantityBounds() throws { for quantity in [0, -1, 100] { XCTAssertThrowsError(try CartRules.estimate(payload(quantity: quantity), menu: decode("menu"))) } }
    func testDineInNeedsTable() throws { let order = StaffOrder(branchId: branchID, fulfillment: "dine_in", lines: payload().lines); XCTAssertThrowsError(try CartRules.estimate(order, menu: decode("menu"))) }
    func testDeliveryCannotBeInventedWithoutAddressFlow() throws { let order = StaffOrder(branchId: branchID, fulfillment: "delivery", lines: payload().lines); XCTAssertThrowsError(try CartRules.estimate(order, menu: decode("menu"))) }
    func testUnavailableProductRejected() throws {
        let data = String(data: try fixture("menu"), encoding: .utf8)!.replacingOccurrences(of: "\"soldOut\": false", with: "\"soldOut\": true")
        let menu = try JSONDecoder().decode(Menu.self, from: Data(data.utf8)); XCTAssertThrowsError(try CartRules.estimate(payload(), menu: menu))
    }
    func testWesternMoneyAndArabicInput() { XCTAssertEqual(Money.text(10001, currency: "SAR"), "100.01 SAR"); XCTAssertEqual(Money.parse("١٢.٣٤"), 1234); XCTAssertEqual(Money.western("۱۲۳"), "123") }
    func testMoneyRejectsAmbiguousValues() { for value in ["-1", "1e2", "1.001", "1,25", "", "NaN", "9999999999999999999"] { XCTAssertNil(Money.parse(value)) } }
    func testSplitPreservesEveryMinorUnit() throws { for amount in 20...1000 { for people in 2...20 { let shares = try Money.split(Int64(amount), people: people); XCTAssertEqual(shares.reduce(0,+), Int64(amount)); XCTAssertLessThanOrEqual(shares.max()! - shares.min()!, 1) } } }
    func testLifecycleRespectsFulfillment() { XCTAssertEqual(OrderLifecycle.next("ready", fulfillment: "dine_in"), "served"); XCTAssertEqual(OrderLifecycle.next("ready", fulfillment: "pickup"), "picked_up"); XCTAssertNil(OrderLifecycle.next("cancelled", fulfillment: "pickup")) }
    func testPermissionsFailClosed() { XCTAssertFalse(Permissions.can("driver", "orders:write")); XCTAssertFalse(Permissions.can("cashier", "payments:refund")); XCTAssertTrue(Permissions.can("cashier", "payments:collect")); XCTAssertFalse(Permissions.can("unknown", "orders:read")); XCTAssertTrue(Permissions.can("owner", "orders:cancel")) }
    func testMembershipBranchIsolation() throws { let me: Me = try decode("me"); XCTAssertTrue(me.memberships[0].allows(branch: branchID)); XCTAssertFalse(me.memberships[0].allows(branch: "other")) }
    func testResponseContracts() throws { let _: Menu = try decode("menu"); let _: Page<OrderSummary> = try decode("orders"); let _: FloorLayout = try decode("floor"); let detail: OrderDetail = try decode("detail"); let receipt = Receipt(order: detail, restaurant: "Venue", arabic: true); XCTAssertTrue(receipt.lines[0].contains("غداء")); XCTAssertEqual(receipt.total, 10431); XCTAssertEqual(receipt.due, 10431) }
    func testRequestUsesSupportedStaffChannel() throws { let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(payload())) as! [String: Any]; XCTAssertEqual(object["channel"] as? String, "staff"); XCTAssertNil(object["expectedTotalMinor"]); XCTAssertNil(object["totalMinor"]) }
}
final class SynchronizationTests: XCTestCase {
    func testLocalDraftDoesNotSendUntilApproved() async throws {
        let sender = Submitter(), store = MemoryStore(); let queue = try OrderQueue(storage: store, submitter: sender)
        _ = try await queue.save(scope: scope(), payload: payload()); try await queue.drain(scope: scope(), authorized: true)
        let calls = await sender.calls; XCTAssertTrue(calls.isEmpty)
    }
    func testApprovalAndAcknowledgementPersist() async throws {
        let sender = Submitter(), store = MemoryStore(); let queue = try OrderQueue(storage: store, submitter: sender)
        let id = try await queue.save(scope: scope(), payload: payload()); try await queue.approve(id, scope: scope(), menu: decode("menu")); try await queue.drain(scope: scope(), authorized: true)
        let reopened = try OrderQueue(storage: store, submitter: sender); let operations = await reopened.list(scope: scope())
        XCTAssertEqual(operations.first?.state, .accepted); XCTAssertEqual(operations.first?.serverNumber, "42")
        try await reopened.drain(scope: scope(), authorized: true); let calls = await sender.calls; XCTAssertEqual(calls.count, 1)
    }
    func testLostResponseRetainsIdentityAndPayload() async throws {
        let sender = Submitter(), store = MemoryStore(); await sender.fail(1)
        let queue = try OrderQueue(storage: store, submitter: sender); let id = try await queue.save(scope: scope(), payload: payload())
        try await queue.approve(id, scope: scope(), menu: decode("menu")); try await queue.drain(scope: scope(), authorized: true)
        let first = await queue.list(scope: scope())[0]; XCTAssertEqual(first.state, .queued); XCTAssertGreaterThanOrEqual(first.nextAttemptAt.timeIntervalSinceNow, 118)
        let restarted = try OrderQueue(storage: store, submitter: sender); try await restarted.drain(scope: scope(), authorized: true, now: Date().addingTimeInterval(301))
        let calls = await sender.calls; XCTAssertEqual(calls.count, 2); XCTAssertEqual(calls[0].id, calls[1].id); XCTAssertEqual(calls[0].payload, calls[1].payload)
    }
    func testCrossTenantAndCrossUserCannotReplay() async throws {
        let sender = Submitter(); let queue = try OrderQueue(storage: MemoryStore(), submitter: sender); let id = try await queue.save(scope: scope(), payload: payload())
        try await queue.approve(id, scope: scope(), menu: decode("menu"))
        for other in [scope(user: "other"), scope(org: "other"), scope(environment: "https://other/v1")] { try await queue.drain(scope: other, authorized: true); let hidden = await queue.list(scope: other); XCTAssertTrue(hidden.isEmpty) }
        let calls = await sender.calls; XCTAssertTrue(calls.isEmpty)
    }
    func testUnauthorizedCannotDrain() async throws {
        let sender = Submitter(); let queue = try OrderQueue(storage: MemoryStore(), submitter: sender); let id = try await queue.save(scope: scope(), payload: payload()); try await queue.approve(id, scope: scope(), menu: decode("menu")); try await queue.drain(scope: scope(), authorized: false); let calls = await sender.calls; XCTAssertTrue(calls.isEmpty)
    }
    func testServerConflictNeedsAttentionAndDoesNotRetry() async throws {
        let sender = Submitter(); await sender.fail(1, status: 409); let queue = try OrderQueue(storage: MemoryStore(), submitter: sender)
        let id = try await queue.save(scope: scope(), payload: payload()); try await queue.approve(id, scope: scope(), menu: decode("menu")); try await queue.drain(scope: scope(), authorized: true)
        let operations = await queue.list(scope: scope()); XCTAssertEqual(operations[0].state, .attention)
        try await queue.drain(scope: scope(), authorized: true, now: Date().addingTimeInterval(1000)); let calls = await sender.calls; XCTAssertEqual(calls.count, 1)
    }
    func testExpiryPreventsReplayAfterServerRetention() async throws {
        let sender = Submitter(); let queue = try OrderQueue(storage: MemoryStore(), submitter: sender)
        let old = Date().addingTimeInterval(-7 * 86400); let id = try await queue.save(scope: scope(), payload: payload(), now: old)
        try await queue.approve(id, scope: scope(), menu: decode("menu")); try await queue.drain(scope: scope(), authorized: true)
        let state = await queue.list(scope: scope())[0].state; let calls = await sender.calls; XCTAssertEqual(state, .attention); XCTAssertTrue(calls.isEmpty)
    }
    func testFailedPersistenceNeverQueuesOrSends() async throws {
        let store = MemoryStore(); let sender = Submitter(); let queue = try OrderQueue(storage: store, submitter: sender); store.fail = true
        do { _ = try await queue.save(scope: scope(), payload: payload()); XCTFail("Expected disk failure") } catch {}
        let operations = await queue.list(scope: scope()); XCTAssertTrue(operations.isEmpty)
    }
    func testConcurrentDrainDoesNotDuplicate() async throws {
        let sender = Submitter(); let queue = try OrderQueue(storage: MemoryStore(), submitter: sender); let id = try await queue.save(scope: scope(), payload: payload()); try await queue.approve(id, scope: scope(), menu: decode("menu"))
        async let a: Void = queue.drain(scope: scope(), authorized: true); async let b: Void = queue.drain(scope: scope(), authorized: true); _ = try await (a,b)
        let calls = await sender.calls; XCTAssertEqual(calls.count, 1)
    }
    func testCorruptStorageDoesNotSilentlyReset() throws { let store = MemoryStore(); try store.write(Data("broken".utf8)); XCTAssertThrowsError(try OrderQueue(storage: store, submitter: Submitter())) }
}
final class NetworkTests: XCTestCase {
    func auth(_ transport: ScriptedTransport) throws -> AuthService { try AuthService(url: URL(string: "https://auth.example")!, publicKey: "public", transport: transport, secrets: MemoryStore()) }
    func session(expired: Bool = false) -> HTTPResult { HTTPResult(data: Data("{\"access_token\":\"access\",\"refresh_token\":\"refresh\",\"expires_in\":\(expired ? 0 : 3600)}".utf8), status: 200) }
    func testAuthHeadersAndTypedDecoding() async throws {
        let transport = ScriptedTransport([session(), HTTPResult(data: try fixture("me"), status: 200)])
        let auth = try auth(transport); try await auth.signIn(email: "staff@example.test", password: "never-logged")
        let client = try APIClient(base: URL(string: "https://api.example/v1")!, auth: auth, transport: transport); let me: Me = try await client.get("me")
        XCTAssertEqual(me.user.id, "user"); let requests = await transport.requests; XCTAssertEqual(requests[1].url?.path, "/v1/me"); XCTAssertEqual(requests[1].value(forHTTPHeaderField: "Authorization"), "Bearer access"); XCTAssertNotNil(requests[1].value(forHTTPHeaderField: "X-Request-ID"))
    }
    func testRefreshSingleFlight() async throws {
        let transport = ScriptedTransport([session(expired: true), session()]); let auth = try auth(transport)
        try await auth.signIn(email: "a", password: "b")
        async let first = auth.token(); async let second = auth.token(); _ = try await (first, second)
        let requests = await transport.requests; XCTAssertEqual(requests.count, 2); XCTAssertTrue(requests[1].url!.absoluteString.contains("grant_type=refresh_token"))
    }
    func testErrorEnvelopeAndRequestID() async throws {
        let transport = ScriptedTransport([session(), HTTPResult(data: try fixture("error"), status: 409)]); let auth = try auth(transport); try await auth.signIn(email: "a", password: "b")
        let client = try APIClient(base: URL(string: "https://api.example/v1")!, auth: auth, transport: transport)
        do { let _: Me = try await client.get("me"); XCTFail("Expected conflict") } catch let error as APIError { XCTAssertEqual(error.code, "version_conflict"); XCTAssertEqual(error.requestId, "request-42") }
    }
    func testETag304ReusesDecodedBody() async throws {
        let transport = ScriptedTransport([session(), HTTPResult(data: try fixture("me"), status: 200, headers: ["etag":"tag"]), HTTPResult(data: Data(), status: 304)])
        let auth = try auth(transport); try await auth.signIn(email: "a", password: "b"); let client = try APIClient(base: URL(string: "https://api.example/v1")!, auth: auth, transport: transport)
        let _: Me = try await client.get("me"); let me: Me = try await client.get("me"); XCTAssertEqual(me.user.id, "user"); let requests = await transport.requests; XCTAssertEqual(requests.last?.value(forHTTPHeaderField: "If-None-Match"), "tag")
    }
    func testMutationNeverAutomaticallyRetries() async throws {
        let transport = ScriptedTransport([session(), HTTPResult(data: try fixture("error"), status: 401)]); let auth = try auth(transport); try await auth.signIn(email: "a", password: "b"); let client = try APIClient(base: URL(string: "https://api.example/v1")!, auth: auth, transport: transport)
        do { let _: OrderAccepted = try await client.post("o/org/orders", body: payload(), key: "stable-key"); XCTFail("Expected error") } catch {}
        let requests = await transport.requests; XCTAssertEqual(requests.count, 2); XCTAssertEqual(requests.last?.value(forHTTPHeaderField: "Idempotency-Key"), "stable-key")
    }
    func testHTTPSRequired() throws { let transport = ScriptedTransport([]); XCTAssertThrowsError(try AuthService(url: URL(string: "http://auth.example")!, publicKey: "public", transport: transport, secrets: MemoryStore())) }
}
actor TestPrinter: ReceiptPrinter {
    var count = 0; var fail = false
    func failNext() { fail = true }
    func printReceipt(_ receipt: Receipt) async throws { count += 1; if fail { fail = false; throw URLError(.timedOut) } }
}
final class PrinterTests: XCTestCase {
    func receipt() throws -> Receipt { Receipt(order: try decode("detail"), restaurant: "Venue", arabic: true) }
    func testPrintQueueSurvivesRestart() async throws {
        let store = MemoryStore(); let queue = try PrintQueue(storage: store); let id = try await queue.enqueue(receipt())
        let restarted = try PrintQueue(storage: store); let jobs = await restarted.list(); XCTAssertEqual(jobs.first?.id, id); XCTAssertEqual(jobs.first?.state, .waiting)
    }
    func testAmbiguousPrintRequiresExplicitReprint() async throws {
        let queue = try PrintQueue(storage: MemoryStore()); let id = try await queue.enqueue(receipt()); let printer = TestPrinter(); await printer.failNext()
        do { try await queue.send(id, printer: printer); XCTFail("Expected timeout") } catch {}
        let state = await queue.list()[0].state; XCTAssertEqual(state, .uncertain)
        do { try await queue.send(id, printer: printer); XCTFail("Expected confirmation") } catch {}
        let count = await printer.count; XCTAssertEqual(count, 1)
        try await queue.send(id, printer: printer, confirmReprint: true); let after = await queue.list()[0].state; XCTAssertEqual(after, .handedToPrinter)
    }
    func testInterruptedPrintIsUncertainAfterRestart() async throws {
        let store = MemoryStore(); var job = PrintJob(receipt: try receipt()); job.state = .sending
        try store.write(JSONEncoder().encode([job])); let queue = try PrintQueue(storage: store); let state = await queue.list()[0].state; XCTAssertEqual(state, .uncertain)
    }
    func testReceiptContainsServerTotalsNotLocalEstimate() throws { let value = try receipt(); XCTAssertEqual(value.total, 10431); XCTAssertNotEqual(value.total, 9150); XCTAssertEqual(value.paymentStatus, "unpaid") }
}
final class PerformanceTests: XCTestCase {
    func testMenuPriceValidationPerformance() throws {
        let menu: Menu = try decode("menu"), order = payload(quantity: 5)
        measure { for _ in 0..<1000 { _ = try? CartRules.estimate(order, menu: menu) } }
    }
}
final class ExtendedCatalogueTests: XCTestCase {
    func testInactiveCategoryIsNotOrderable() throws {
        var object = try JSONSerialization.jsonObject(with: fixture("menu")) as! [String: Any]
        var categories = object["categories"] as! [[String: Any]]; categories[0]["isActive"] = false; object["categories"] = categories
        let menu = try JSONDecoder().decode(Menu.self, from: JSONSerialization.data(withJSONObject: object))
        XCTAssertTrue(menu.products(branch: branchID).isEmpty); XCTAssertThrowsError(try CartRules.estimate(payload(), menu: menu))
    }
    func testOtherBranchMenuIsNotOrderable() throws {
        var object = try JSONSerialization.jsonObject(with: fixture("menu")) as! [String: Any]
        var menus = object["menus"] as! [[String: Any]]; menus[0]["branchId"] = "other-branch"; object["menus"] = menus
        let menu = try JSONDecoder().decode(Menu.self, from: JSONSerialization.data(withJSONObject: object))
        XCTAssertThrowsError(try CartRules.estimate(payload(), menu: menu))
    }
    func testDeliveryWithAddressUsesSupportedStaffContract() throws {
        let order = StaffOrder(branchId: branchID, fulfillment: "delivery", lines: payload().lines, customerId: "customer", deliveryAddress: DeliveryAddress(line1: "Street 123", area: "Area", city: "Cairo"))
        XCTAssertEqual(try CartRules.estimate(order, menu: decode("menu")), 9150)
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(order)) as! [String: Any]
        XCTAssertEqual(encoded["customerId"] as? String, "customer"); XCTAssertNotNil(encoded["deliveryAddress"])
    }
}
actor RefreshGateTransport: HTTPTransport {
    private var gate: CheckedContinuation<HTTPResult, Never>?
    private var waiting: CheckedContinuation<Void, Never>?
    func send(_ request: URLRequest) async throws -> HTTPResult {
        if request.url?.query?.contains("grant_type=refresh_token") == true {
            return await withCheckedContinuation { continuation in gate = continuation; waiting?.resume(); waiting = nil }
        }
        if request.url?.path.hasSuffix("logout") == true { return HTTPResult(data: Data(), status: 204) }
        return HTTPResult(data: Data("{\"access_token\":\"old\",\"refresh_token\":\"refresh\",\"expires_in\":0}".utf8), status: 200)
    }
    func waitForRefresh() async { if gate != nil { return }; await withCheckedContinuation { waiting = $0 } }
    func finishRefresh() { gate?.resume(returning: HTTPResult(data: Data("{\"access_token\":\"new\",\"refresh_token\":\"rotated\",\"expires_in\":3600}".utf8), status: 200)); gate = nil }
}
final class AuthenticationRaceTests: XCTestCase {
    func testLateRefreshCannotRestoreSignedOutSession() async throws {
        let transport = RefreshGateTransport(), secrets = MemoryStore()
        let auth = try AuthService(url: URL(string: "https://auth.example")!, publicKey: "public", transport: transport, secrets: secrets)
        try await auth.signIn(email: "a", password: "b")
        let refresh = Task { try await auth.token() }; await transport.waitForRefresh()
        try await auth.signOut(); await transport.finishRefresh()
        do { _ = try await refresh.value; XCTFail("Late refresh must be discarded") } catch {}
        XCTAssertNil(try secrets.read("session"))
        do { _ = try await auth.token(); XCTFail("Must remain signed out") } catch {}
    }
}
final class TimestampTests: XCTestCase {
    func testBackendFractionalISOTimeAndOffsets() {
        XCTAssertEqual(ServerDate.parse("2026-10-24T12:00:00.000Z"), ServerDate.parse("2026-10-24T15:00:00+03:00"))
        XCTAssertNotNil(ServerDate.parse("2026-10-24T12:00:00.123Z")); XCTAssertNil(ServerDate.parse("invalid"))
    }
}
final class CaptureAtomicityTests: XCTestCase {
    func testCrashBeforeCartClearCannotCreateSecondOperation() async throws {
        let storage = MemoryStore(), sender = Submitter(), draftID = UUID()
        let first = try OrderQueue(storage: storage, submitter: sender)
        _ = try await first.save(scope: scope(), payload: payload(), id: draftID)
        // Simulate process death before the separate cart snapshot was cleared.
        let restarted = try OrderQueue(storage: storage, submitter: sender)
        let recoveredID = try await restarted.save(scope: scope(), payload: payload(), id: draftID)
        XCTAssertEqual(recoveredID, draftID)
        let operations = await restarted.list(scope: scope()); XCTAssertEqual(operations.count, 1)
        try await restarted.approve(draftID, scope: scope(), menu: decode("menu")); try await restarted.drain(scope: scope(), authorized: true)
        _ = try await restarted.save(scope: scope(), payload: payload(), id: draftID)
        try await restarted.drain(scope: scope(), authorized: true)
        let calls = await sender.calls; XCTAssertEqual(calls.count, 1)
    }
    func testCapturedIDCannotBeReusedWithDifferentPayloadOrTenant() async throws {
        let queue = try OrderQueue(storage: MemoryStore(), submitter: Submitter()), id = UUID()
        _ = try await queue.save(scope: scope(), payload: payload(), id: id)
        do { _ = try await queue.save(scope: scope(), payload: payload(quantity: 2), id: id); XCTFail("Immutable payload must be preserved") } catch {}
        do { _ = try await queue.save(scope: scope(org: "other"), payload: payload(), id: id); XCTFail("Scope must be preserved") } catch {}
    }
}
final class StorageIdentityTests: XCTestCase {
    func testScopeIdentityIsCanonicalAcrossRelaunches() throws {
        let original = Scope(environment: "a", userId: "bc", orgId: "d", branchId: "e")
        XCTAssertEqual(original.storageIdentity, "1:a2:bc1:d1:e")
        let restored = try JSONDecoder().decode(Scope.self, from: JSONEncoder().encode(original))
        XCTAssertEqual(restored.storageIdentity, original.storageIdentity)
    }
    func testFieldBoundariesAndTenantsCannotCollide() {
        let a = Scope(environment: "a", userId: "bc", orgId: "d", branchId: "e")
        let b = Scope(environment: "ab", userId: "c", orgId: "d", branchId: "e")
        XCTAssertNotEqual(a.storageIdentity, b.storageIdentity)
        XCTAssertNotEqual(scope().storageIdentity, scope(user: "other").storageIdentity)
        XCTAssertNotEqual(scope().storageIdentity, scope(org: "other").storageIdentity)
    }
}
final class CatalogueScaleTests: XCTestCase {
    func testLargeCatalogueAndSixtyLineEstimate() throws {
        var object = try JSONSerialization.jsonObject(with: fixture("menu")) as! [String: Any]
        let original = (object["products"] as! [[String: Any]])[0]
        object["products"] = (0..<1000).map { index -> [String: Any] in var product = original; product["id"] = "product-\(index)"; return product }
        let menu = try JSONDecoder().decode(Menu.self, from: JSONSerialization.data(withJSONObject: object))
        let lines = (0..<60).map { CartLine(productId:"product-\($0)",quantity:1,modifiers:[.init(groupId:"group",optionId:"option")]) }
        let order = StaffOrder(branchId:branchID,fulfillment:"pickup",lines:lines)
        XCTAssertEqual(try CartRules.estimate(order,menu:menu),549000)
        measure { for _ in 0..<10 { _ = try? CartRules.estimate(order,menu:menu) } }
    }
    func testModifierOverflowIsRejectedWithoutTrapping() throws {
        var object = try JSONSerialization.jsonObject(with: fixture("menu")) as! [String: Any]
        var groups = object["modifierGroups"] as! [[String: Any]]
        var options = groups[0]["options"] as! [[String: Any]]; options[0]["priceDeltaMinor"] = Int64.max
        groups[0]["options"] = options; object["modifierGroups"] = groups
        let menu = try JSONDecoder().decode(Menu.self, from: JSONSerialization.data(withJSONObject: object))
        XCTAssertThrowsError(try CartRules.estimate(payload(),menu:menu))
    }
    func testArabicCombiningNotesMatchBackendUTF16Limit() throws {
        let notes = String(repeating:"نَ",count:101)
        XCTAssertLessThan(notes.count,200); XCTAssertGreaterThan(notes.utf16.count,200)
        let line = CartLine(productId:productID,quantity:1,modifiers:payload().lines[0].modifiers,notes:notes)
        XCTAssertThrowsError(try CartRules.estimate(StaffOrder(branchId:branchID,fulfillment:"pickup",lines:[line]),menu:decode("menu")))
    }
}
final class SessionScopeTests: XCTestCase {
    func testNativeLogoutRevokesOnlyItsOwnSession() async throws {
        let response = HTTPResult(data:Data("{\"access_token\":\"access\",\"refresh_token\":\"refresh\",\"expires_in\":3600}".utf8),status:200)
        let transport = ScriptedTransport([response,HTTPResult(data:Data(),status:204)]), secrets = MemoryStore()
        let auth = try AuthService(url:URL(string:"https://auth.example")!,publicKey:"public",transport:transport,secrets:secrets)
        try await auth.signIn(email:"staff@example.test",password:"test-only")
        try await auth.signOut()
        let requests = await transport.requests
        XCTAssertEqual(requests.last?.url?.query,"scope=local")
        XCTAssertEqual(requests.last?.value(forHTTPHeaderField:"Authorization"),"Bearer access")
        XCTAssertNil(try secrets.read("session"))
        do { _ = try await auth.token(); XCTFail("Signed-out token must be inaccessible") } catch {}
    }
}
