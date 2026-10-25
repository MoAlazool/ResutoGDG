import XCTest
@testable import ResutoCore
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// Synthetic reviewed draft-0.2.0 fixtures. These are NOT captures from staging or backend acceptance evidence.
private let testDeviceToken = "rpos_" + String(repeating:"a",count:43)
private func jsonResult(_ object: Any,status: Int = 200) throws -> HTTPResult { HTTPResult(data:try JSONSerialization.data(withJSONObject:object),status:status) }
private func parsed<T: Decodable>(_ object: Any, _: T.Type = T.self) throws -> T { try JSONDecoder().decode(T.self,from:JSONSerialization.data(withJSONObject:object)) }
private func device(role: String = "cashier", requireStaff: Bool = true) -> [String:Any] {
    ["id":"device", "branchId":branchID, "name":"QA synthetic", "actingRole":role,"status":"active","expired":false,"requireStaff":requireStaff]
}
private func pair(version: String = "0.2.0",branch: String = branchID,token: String = testDeviceToken) throws -> POSPairResult {
    var d = device(); d["branchId"] = branch
    return try parsed(["token":token,"device":d,"orgId":"org","contractVersion":version])
}
private func member(role: String = "manager") throws -> Membership { try parsed(["orgId":"org","orgSlug":"qa","orgName":"QA","role":role,"branchIds":[branchID]]) }
private func sessionJSON(role: String = "manager", actingRole: String = "cashier", version: String = "0.2.0", staff: Bool = true) -> [String:Any] {
    var value: [String:Any] = ["device":device(role:actingRole), "org":["id":"org","name":"QA","currency":"EGP","timezone":"Africa/Cairo"],"branch":["id":branchID,"name":"Main"],"permissions":["menu:read","floor:read","orders:read","orders:write","orders:status","kitchen:operate","payments:collect"],"feed":["epoch":"epoch","head":0,"oldest":0],"contractVersion":version,"requireStaff":true]
    if staff { value["staff"] = ["id":"user","email":"staff@example.test","role":role] }
    return value
}
private func authResponse(_ token: String = "staff-access") throws -> HTTPResult { try jsonResult(["access_token":token,"refresh_token":"staff-refresh","expires_in":3600]) }
private func setup(_ replies: [HTTPResult]) async throws -> (POSClient,ScriptedTransport,MemoryStore,DeviceCredentialStore,AuthService) {
    let transport = ScriptedTransport(try [authResponse()] + replies), staff = MemoryStore(), deviceSecrets = MemoryStore()
    let auth = try AuthService(url:URL(string:"https://auth.example")!,publicKey:"public",transport:transport,secrets:staff)
    try await auth.signIn(email:"staff@example.test",password:"synthetic")
    let devices = DeviceCredentialStore(secrets:deviceSecrets); try await devices.save(pair(),scope:scope())
    return (try POSClient(base:URL(string:scope().environment)!,auth:auth,devices:devices,transport:transport,scope:scope()),transport,staff,devices,auth)
}
private func quote() throws -> POSQuote {
    try parsed(["currency":"EGP","lines":[["index":0,"productId":productID,"unitPriceMinor":9150,"modifiersTotalMinor":0,"lineTotalMinor":9150]],"subtotalMinor":9150,"discountMinor":0,"serviceChargeMinor":0,"deliveryFeeMinor":0,"taxMinor":1281,"taxInclusive":false,"totalMinor":10431,"menuCursor":"menu-1"])
}
private func page(_ sequences: [Int64], kinds: [String]? = nil,epoch: String = "epoch",head: Int64? = nil,next: Int64? = nil) throws -> POSEventPage {
    let events = sequences.enumerated().map { i,seq -> [String:Any] in ["seq":seq,"kind":kinds?[i] ?? "order.updated","entityType":"order","entityId":"shared-order","payload":["version":i+1],"at":"2026-10-24T12:00:00Z"] }
    let last: Int64 = sequences.max() ?? 0, actualHead: Int64 = head ?? last, actualNext: Int64 = next ?? last
    return try parsed(["epoch":epoch,"head":actualHead,"events":events,"nextAfter":actualNext,"hasMore":false])
}
private actor RefreshRecorder {
    var sets: [Set<POSProjection>] = []
    func record(_ values: Set<POSProjection>) { sets.append(values) }
}
final class POSCredentialTests: XCTestCase {
    func testPOSHeadersNeverReplaceStaffRouteAuthorization() async throws {
        let (client,transport,_,_,_) = try await setup([jsonResult(sessionJSON())])
        let session = try await client.session(membership:member()); XCTAssertEqual(session.staff?.id,"user")
        let requests = await transport.requests, request = try XCTUnwrap(requests.last)
        XCTAssertEqual(request.url?.path,"/v1/pos/session")
        XCTAssertEqual(request.value(forHTTPHeaderField:"Authorization"),"Bearer " + testDeviceToken)
        XCTAssertEqual(request.value(forHTTPHeaderField:"X-Resuto-Staff-Authorization"),"Bearer staff-access")
    }
    func testDeviceCannotEscapePOSRouteFamily() async throws {
        let (client,transport,_,_,_) = try await setup([])
        for path in ["../me","o/org/orders","/orders","orders/%2e%2e/me","orders?branch=other","orders/#fragment"] {
            do { let _: EmptyResponse = try await client.get(path); XCTFail(path) } catch {}
        }
        let count = await transport.requests.count; XCTAssertEqual(count,1) // Only initial staff sign-in.
    }
    func testRevokedDeviceDeletesOnlyDeviceCredential() async throws {
        let denied = try jsonResult(["error":["code":"device_revoked","message":"Revoked"]],status:401)
        let (client,_,staff,devices,auth) = try await setup([denied])
        do { let _: EmptyResponse = try await client.get("session"); XCTFail() } catch let e as APIError { XCTAssertEqual(e.code,"device_revoked") }
        do { _ = try await devices.token(scope:scope()); XCTFail() } catch {}
        XCTAssertNotNil(try staff.read("session")); let token = try await auth.token(); XCTAssertEqual(token,"staff-access")
    }
    func testDeniedStaffKeepsDeviceAndDoesNotDowngradeToDeviceOnly() async throws {
        let denied = try jsonResult(["error":["code":"pos_staff_not_allowed","message":"Denied"]],status:403)
        let (client,transport,_,devices,_) = try await setup([denied])
        do { let _: EmptyResponse = try await client.get("orders"); XCTFail() } catch {}
        let token = try await devices.token(scope:scope()); XCTAssertEqual(token,testDeviceToken)
        let requests = await transport.requests; XCTAssertEqual(requests.count,2)
        XCTAssertNotNil(requests.last?.value(forHTTPHeaderField:"X-Resuto-Staff-Authorization"))
    }
    func testStaffLogoutRetainsPairingAcrossStaffSwitch() async throws {
        let (_,_,staff,devices,auth) = try await setup([HTTPResult(data:Data(),status:204)])
        try await auth.signOut(); XCTAssertNil(try staff.read("session"))
        let token = try await devices.token(scope:scope()); XCTAssertEqual(token,testDeviceToken)
    }
    func testStaffReadRefreshPreservesDeviceHeader() async throws {
        let denied = try jsonResult(["error":["code":"unauthorized","message":"Expired"]],status:401)
        let (client,transport,_,_,_) = try await setup([denied,authResponse("new-staff"),jsonResult([:])])
        let _: EmptyResponse = try await client.get("events")
        let requests = await transport.requests
        XCTAssertEqual(requests.count,4)
        XCTAssertEqual(requests.last?.value(forHTTPHeaderField:"X-Resuto-Staff-Authorization"),"Bearer new-staff")
        XCTAssertEqual(requests.last?.value(forHTTPHeaderField:"Authorization"),"Bearer " + testDeviceToken)
    }
    func testMutation401IsNeverAutomaticallyReplayed() async throws {
        let denied = try jsonResult(["error":["code":"unauthorized","message":"Expired"]],status:401)
        let (client,transport,_,_,_) = try await setup([denied])
        do { let _: EmptyResponse = try await client.post("orders",body:["clientOrderId":"id"]); XCTFail() } catch {}
        let count = await transport.requests.count; XCTAssertEqual(count,2)
    }
    func testDraft01MissingStaffWrongTenantAndWrongBranchFailClosed() throws {
        for obj in [sessionJSON(version:"0.1.0"), sessionJSON(staff:false)] {
            let s: POSSession = try parsed(obj); XCTAssertThrowsError(try s.validate(scope:scope(),membership:member()))
        }
        let s: POSSession = try parsed(sessionJSON())
        XCTAssertThrowsError(try s.validate(scope:scope(org:"other"),membership:member()))
        let other = Scope(environment:scope().environment,userId:"user",orgId:"org",branchId:"other")
        XCTAssertThrowsError(try s.validate(scope:other,membership:member()))
    }
    func testEffectivePermissionsAreIntersectionOfStaffDeviceAndServer() throws {
        let kitchen: POSSession = try parsed(sessionJSON(actingRole:"kitchen"))
        XCTAssertFalse(kitchen.can("orders:write",membership:try member()))
        XCTAssertTrue(kitchen.can("kitchen:operate",membership:try member()))
        let host: POSSession = try parsed(sessionJSON(role:"host"))
        XCTAssertFalse(host.can("payments:collect",membership:try member(role:"host")))
    }
    func testPairStorageRejects01OtherBranchAndMalformedToken() async throws {
        let store = DeviceCredentialStore(secrets:MemoryStore())
        for pair in [try pair(version:"0.1.0"),try pair(branch:"other"),try pair(token:"staff-jwt")] {
            do { try await store.save(pair,scope:scope()); XCTFail() } catch {}
        }
    }
    func testPairExchangeHasNoStaffOrOldDeviceCredential() async throws {
        let data = try JSONEncoder().encode(pair()), response = HTTPResult(data:data,status:201)
        let (client,transport,_,_,_) = try await setup([response])
        try await client.pair(code:"abcde-fghjk",appVersion:"test")
        let request = await transport.requests.last
        XCTAssertEqual(request?.url?.path,"/v1/pos/pair"); XCTAssertNil(request?.value(forHTTPHeaderField:"Authorization"))
        XCTAssertNil(request?.value(forHTTPHeaderField:"X-Resuto-Staff-Authorization"))
    }
}
final class POSEventTests: XCTestCase {
    func testWebKDSAndPaymentsInvalidateSameProjectionsAndSurviveRestart() async throws {
        let store = MemoryStore(), refreshes = RefreshRecorder(), journal = try POSEventJournal(scope:scope(),deviceId:"device",storage:store)
        try await journal.resync(from:.init(epoch:"epoch",head:0,oldest:0)) { await refreshes.record($0) }
        try await journal.apply(page([1,2,3],kinds:["order.created","ticket.status_changed","payment.captured"])) { await refreshes.record($0) }
        let restarted = try POSEventJournal(scope:scope(),deviceId:"device",storage:store)
        let position = await restarted.position(); XCTAssertEqual(position?.lastSeq,3)
        let sets = await refreshes.sets; XCTAssertEqual(sets.last,[.orders,.kitchen,.floor])
    }
    func testDuplicateAndUnknownEventsAreSafeWithoutSkippingSequence() async throws {
        let journal = try POSEventJournal(scope:scope(),deviceId:"device",storage:MemoryStore()), refreshes = RefreshRecorder()
        try await journal.resync(from:.init(epoch:"epoch",head:0,oldest:0)) { _ in }
        try await journal.apply(page([1,1,2],kinds:["menu.changed","menu.changed","future.event"])) { await refreshes.record($0) }
        let pos = await journal.position(); XCTAssertEqual(pos?.lastSeq,2)
        let sets = await refreshes.sets; XCTAssertEqual(sets.count,1); XCTAssertEqual(sets.first,[.menu])
    }
    func testGapEpochResetAndCursorJumpNeverAdvanceOrRefresh() async throws {
        let journal = try POSEventJournal(scope:scope(),deviceId:"device",storage:MemoryStore()), refreshes = RefreshRecorder()
        try await journal.resync(from:.init(epoch:"epoch",head:0,oldest:0)) { _ in }
        for p in [try page([2]),try page([1],epoch:"reset"),try page([1],head:2,next:2)] {
            do { try await journal.apply(p) { await refreshes.record($0) }; XCTFail() } catch {}
        }
        let pos = await journal.position(), sets = await refreshes.sets
        XCTAssertEqual(pos?.lastSeq,0); XCTAssertTrue(sets.isEmpty)
    }
    func testFailedProjectionRefreshDoesNotAcknowledgeEvents() async throws {
        let journal = try POSEventJournal(scope:scope(),deviceId:"device",storage:MemoryStore())
        try await journal.resync(from:.init(epoch:"epoch",head:0,oldest:0)) { _ in }
        do { try await journal.apply(page([1])) { _ in throw URLError(.networkConnectionLost) }; XCTFail() } catch {}
        let pos = await journal.position(); XCTAssertEqual(pos?.lastSeq,0)
    }
    func testFeedCheckpointDiskFailureKeepsPriorPosition() async throws {
        let store = MemoryStore(), journal = try POSEventJournal(scope:scope(),deviceId:"device",storage:store)
        try await journal.resync(from:.init(epoch:"epoch",head:0,oldest:0)) { _ in }; store.fail = true
        do { try await journal.apply(page([1])) { _ in }; XCTFail() } catch {}
        let pos = await journal.position(); XCTAssertEqual(pos?.lastSeq,0)
    }
    func testAnotherTenantOrReplacementDeviceCannotReadCheckpoint() async throws {
        let store = MemoryStore(), journal = try POSEventJournal(scope:scope(),deviceId:"device",storage:store)
        try await journal.resync(from:.init(epoch:"epoch",head:0,oldest:0)) { _ in }
        XCTAssertThrowsError(try POSEventJournal(scope:scope(org:"other"),deviceId:"device",storage:store))
        XCTAssertThrowsError(try POSEventJournal(scope:scope(),deviceId:"replacement",storage:store))
    }
}
final class POSQuoteQueueTests: XCTestCase {
    func testQuotedBodyUsesExactServerTotalsAndStableClientID() throws {
        let id = UUID(), body = try POSSubmitBody(id:id,order:payload(),quote:quote())
        XCTAssertEqual(body.clientOrderId,id); XCTAssertEqual(body.expectedTotalMinor,10431)
        XCTAssertEqual(body.lines[0].expectedLineTotalMinor,9150); XCTAssertEqual(body.repricing,"reject")
    }
    func testUnsupportedStaffFieldsAreNotSilentlyDropped() throws {
        let customer = StaffOrder(branchId:branchID,fulfillment:"pickup",lines:payload().lines,customerId:"customer")
        let promotion = StaffOrder(branchId:branchID,fulfillment:"pickup",lines:payload().lines,promotionCode:"promo")
        for p in [customer,promotion] { XCTAssertThrowsError(try POSSubmitBody(id:UUID(),order:p,quote:quote())) }
    }
    func testPermanentPOSIdentitySurvivesLongOfflinePeriodAndRestart() async throws {
        let sender = Submitter(), store = MemoryStore(), queue = try OrderQueue(storage:store,submitter:sender)
        let now = Date(), id = try await queue.save(scope:scope(),payload:payload(),now:now)
        try await queue.approvePOS(id,scope:scope(),quote:quote(),now:now)
        let restarted = try OrderQueue(storage:store,submitter:sender)
        try await restarted.drain(scope:scope(),authorized:true,now:now.addingTimeInterval(30 * 86400))
        let pending = await restarted.list(scope:scope()), calls = await sender.calls
        XCTAssertEqual(pending.first?.state,.accepted); XCTAssertEqual(calls.first?.id,id)
        XCTAssertEqual(calls.first?.posQuote?.totalMinor,10431)
    }
    func testPreviouslyAttemptedLegacyOrderCannotSwitchRouteFamilies() async throws {
        let sender = Submitter(); await sender.fail(1)
        let queue = try OrderQueue(storage:MemoryStore(),submitter:sender), id = try await queue.save(scope:scope(),payload:payload())
        try await queue.approve(id,scope:scope(),menu:decode("menu")); try await queue.drain(scope:scope(),authorized:true)
        do { try await queue.approvePOS(id,scope:scope(),quote:quote()); XCTFail() } catch {}
        let pending = await queue.list(scope:scope()); XCTAssertNil(pending.first?.posQuote)
    }
}

private func submitted(_ id: UUID,branch: String = branchID) throws -> [String:Any] {
    var detail = try JSONSerialization.jsonObject(with:fixture("detail")) as! [String:Any]
    detail["clientOrderId"] = id.uuidString; detail["branchId"] = branch; detail["channel"] = "pos"; detail["open"] = true
    detail["paidMinor"] = 0; detail["refundedMinor"] = 0
    var lines = detail["lines"] as! [[String:Any]]
    lines[0]["productId"] = productID; lines[0]["unitPriceMinor"] = 9150; lines[0]["modifiers"] = []; lines[0]["modifiersTotalMinor"] = 0; lines[0]["station"] = "kitchen"; detail["lines"] = lines
    return ["clientOrderId":id.uuidString,"order":detail,"repriced":NSNull()]
}
final class POSOrderAdapterTests: XCTestCase {
    func testReconciliationRejectsMismatchedOrderNumberWithoutPosting() async throws {
        let id = UUID()
        let (client,transport,_,_,_) = try await setup([jsonResult(sessionJSON()),jsonResult(["state":"accepted","orderId":"order","number":"wrong-number","response":submitted(id)])])
        let sender = CompatibleOrderSubmitter(legacy:Submitter(),pos:client,membership:try member())
        var op = PendingOrder(scope:scope(),payload:payload(),id:id); op.posQuote = try quote(); op.attempts = 2
        do { _ = try await sender.submit(op); XCTFail("Mismatched response must not count as accepted") } catch {}
        let requests = await transport.requests
        XCTAssertFalse(requests.contains { $0.httpMethod == "POST" && $0.url?.path == "/v1/pos/orders" })
    }
    func testSubmissionRejectsDifferentCurrencyEvenWithSameNumericTotal() async throws {
        let id = UUID(); var response = try submitted(id); var order = response["order"] as! [String:Any]
        order["currency"] = "USD"; response["order"] = order
        let (client,_,_,_,_) = try await setup([jsonResult(sessionJSON()),jsonResult(response)])
        let sender = CompatibleOrderSubmitter(legacy:Submitter(),pos:client,membership:try member())
        var op = PendingOrder(scope:scope(),payload:payload(),id:id); op.posQuote = try quote(); op.attempts = 1
        do { _ = try await sender.submit(op); XCTFail("Currency mismatch must require reconciliation") } catch {}
    }
    func testAmbiguousSubmissionReconcilesWithoutSecondPost() async throws {
        let id = UUID(), result = try submitted(id), lookup: [String:Any] = ["state":"accepted","orderId":"order","number":"42","response":result]
        let (client,transport,_,_,_) = try await setup([jsonResult(sessionJSON()),jsonResult(["error":["code":"internal","message":"Temporary"]],status:503),jsonResult(lookup)])
        let legacy = Submitter(), sender = CompatibleOrderSubmitter(legacy:legacy,pos:client,membership:try member())
        var operation = PendingOrder(scope:scope(),payload:payload(),id:id); operation.posQuote = try quote(); operation.attempts = 1
        let accepted = try await sender.submit(operation); XCTAssertEqual(accepted.id,"order")
        let requests = await transport.requests, legacyCalls = await legacy.calls
        XCTAssertEqual(requests.filter { $0.httpMethod == "POST" && $0.url?.path == "/v1/pos/orders" }.count,1)
        XCTAssertEqual(requests.last?.url?.path,"/v1/pos/orders/by-client-id/" + id.uuidString)
        XCTAssertTrue(legacyCalls.isEmpty)
    }
    func testProcessingLookupDoesNotReplayMutationOrFallBackToStaffRoute() async throws {
        let (client,transport,_,_,_) = try await setup([jsonResult(sessionJSON()),jsonResult(["state":"processing"])])
        let legacy = Submitter(), sender = CompatibleOrderSubmitter(legacy:legacy,pos:client,membership:try member())
        var operation = PendingOrder(scope:scope(),payload:payload()); operation.posQuote = try quote(); operation.attempts = 2
        do { _ = try await sender.submit(operation); XCTFail() } catch let e as APIError { XCTAssertEqual(e.code,"pos_operation_processing") }
        let requests = await transport.requests, legacyCalls = await legacy.calls
        XCTAssertFalse(requests.contains { $0.url?.path == "/v1/pos/orders" }); XCTAssertTrue(legacyCalls.isEmpty)
    }
    func testPriceConflictDetailsRemainTypedAndDoNotFallBackOrRetry() async throws {
        let conflict: [String:Any] = ["currency":"EGP","lines":[["index":0,"productId":productID,"expectedLineTotalMinor":9150,"currentLineTotalMinor":9200,"currentUnitPriceMinor":9200,"currentModifiersTotalMinor":0]],"expectedTotalMinor":10431,"currentTotalMinor":10488,"menuCursor":"menu-2"]
        let error = try jsonResult(["error":["code":"pos_price_changed","message":"Changed","requestId":"safe-request-id","details":conflict]],status:409)
        let (client,transport,_,_,_) = try await setup([jsonResult(sessionJSON()),error])
        let legacy = Submitter(), sender = CompatibleOrderSubmitter(legacy:legacy,pos:client,membership:try member())
        var operation = PendingOrder(scope:scope(),payload:payload()); operation.posQuote = try quote(); operation.attempts = 1
        do { _ = try await sender.submit(operation); XCTFail() } catch let e as APIError {
            let values = try XCTUnwrap(e.details).decode(POSPriceConflict.self)
            XCTAssertEqual(values.currentTotalMinor,10488); XCTAssertEqual(values.lines[0].currentLineTotalMinor,9200)
        }
        let requests = await transport.requests, legacyCalls = await legacy.calls
        XCTAssertEqual(requests.count,3); XCTAssertTrue(legacyCalls.isEmpty)
    }
    func testLegacyOperationRetainsExistingSenderAndNoPOSCalls() async throws {
        let (client,transport,_,_,_) = try await setup([]), legacy = Submitter()
        let sender = CompatibleOrderSubmitter(legacy:legacy,pos:client,membership:try member())
        let operation = PendingOrder(scope:scope(),payload:payload()); _ = try await sender.submit(operation)
        let requests = await transport.requests, legacyCalls = await legacy.calls
        XCTAssertEqual(requests.count,1); XCTAssertEqual(legacyCalls.first?.id,operation.id)
    }
    func testUnknownConflictCannotChangeApprovedQuoteOrIdentity() async throws {
        let sender = Submitter(); await sender.fail(1,status:409)
        // A specific non-committing conflict is required; generic 409 cannot unlock a new payload/quote.
        let queue = try OrderQueue(storage:MemoryStore(),submitter:sender), id = try await queue.save(scope:scope(),payload:payload())
        try await queue.approvePOS(id,scope:scope(),quote:quote()); try await queue.drain(scope:scope(),authorized:true)
        do { try await queue.approvePOS(id,scope:scope(),quote:quote()); XCTFail("Unknown conflicts must require reconciliation") } catch {}
        let pending = await queue.list(scope:scope()); XCTAssertEqual(pending.first?.id,id); XCTAssertEqual(pending.first?.state,.attention)
    }
}
final class POSShadowSyncTests: XCTestCase {
    func testPermissionNarrowingDiscardsProtectedSnapshotsWithoutFeedEvent() async throws {
        var restricted = sessionJSON(); restricted["permissions"] = ["orders:read"]
        let empty = try JSONEncoder().encode(page([],head:0,next:0))
        let (client,transport,_,_,_) = try await setup([
            jsonResult(sessionJSON()),jsonResult(["cursor":"menu-1","unchanged":false,"currency":"EGP","categories":[],"stations":[]]),
            jsonResult(["cursor":"floor-1","unchanged":false,"layout":["revision":1],"tables":[]]),
            jsonResult(["cursor":"orders-0","mode":"full","orders":[],"hasMore":false]),HTTPResult(data:empty,status:200),
            jsonResult(restricted),HTTPResult(data:empty,status:200)])
        let journal = try POSEventJournal(scope:scope(),deviceId:"device",storage:MemoryStore())
        let storage = MemoryStore(), shadow = try POSShadowSync(client:client,membership:member(),deviceId:"device",journal:journal,storage:storage)
        try await shadow.poll(wait:0); let first = await shadow.current(); XCTAssertNotNil(first.menu); XCTAssertNotNil(first.floor)
        try await shadow.poll(wait:0); let current = await shadow.current(); XCTAssertNil(current.menu); XCTAssertNil(current.floor)
        let persisted = try JSONDecoder().decode(POSShadowSync.Snapshot.self,from:XCTUnwrap(storage.read()))
        XCTAssertNil(persisted.menu); XCTAssertNil(persisted.floor)
        let requests = await transport.requests
        XCTAssertEqual(requests.filter { $0.url?.path == "/v1/pos/sync/menu" }.count,1)
    }
    func testReadOnlyShadowStartsWithSnapshotsAndReplaysWebEvents() async throws {
        let order = try submitted(UUID())["order"]!, session = sessionJSON()
        let event = try JSONEncoder().encode(page([1],kinds:["order.updated"]))
        let (client,transport,_,_,_) = try await setup([
            jsonResult(session),jsonResult(["cursor":"menu-1","unchanged":false,"currency":"EGP","categories":[],"stations":[]]),
            jsonResult(["cursor":"floor-1","unchanged":false,"layout":["revision":1],"tables":[]]),
            jsonResult(["cursor":"orders-0","mode":"full","orders":[],"hasMore":false]),
            HTTPResult(data:event,status:200),jsonResult(["cursor":"floor-1","unchanged":true]),
            jsonResult(["cursor":"orders-1","mode":"delta","orders":[order],"hasMore":false])])
        let journal = try POSEventJournal(scope:scope(),deviceId:"device",storage:MemoryStore())
        let shadow = try POSShadowSync(client:client,membership:member(),deviceId:"device",journal:journal,storage:MemoryStore())
        try await shadow.poll(wait:0)
        let snapshot = await shadow.current(), position = await journal.position(), requests = await transport.requests
        XCTAssertEqual(snapshot.orders.first?.id,"order"); XCTAssertEqual(position?.lastSeq,1)
        XCTAssertFalse(requests.dropFirst().contains { $0.httpMethod != "GET" },"Shadow mode must be read-only")
    }
    func testLostProjectionFileForcesSnapshotsEvenWithExistingFeedCursor() async throws {
        let journal = try POSEventJournal(scope:scope(),deviceId:"device",storage:MemoryStore())
        try await journal.resync(from:.init(epoch:"epoch",head:7,oldest:0)) { _ in }
        var session = sessionJSON(); session["feed"] = ["epoch":"epoch","head":7,"oldest":0]
        let emptyPage = try JSONEncoder().encode(page([],head:7,next:7))
        let (client,transport,_,_,_) = try await setup([
            jsonResult(session),jsonResult(["cursor":"menu-1","unchanged":false,"currency":"EGP","categories":[],"stations":[]]),
            jsonResult(["cursor":"floor-1","unchanged":false,"layout":["revision":1],"tables":[]]),
            jsonResult(["cursor":"orders-7","mode":"full","orders":[],"hasMore":false]),HTTPResult(data:emptyPage,status:200)])
        let shadow = try POSShadowSync(client:client,membership:member(),deviceId:"device",journal:journal,storage:MemoryStore())
        try await shadow.poll(wait:0)
        let snapshot = await shadow.current(), requests = await transport.requests
        XCTAssertNotNil(snapshot.menu); XCTAssertEqual(requests.filter { $0.url?.path == "/v1/pos/sync/orders" }.count,1)
    }
}
final class FailurePresentationTests: XCTestCase {
    func testBackendMessageCannotLeakIntoLocalizedUIKey() {
        let presentation = FailurePresentation(APIError(status:409,code:"pos_price_changed",message:"Untrusted arbitrary customer data",requestId:"safe-request"))
        XCTAssertEqual(presentation.key,"price_changed"); XCTAssertEqual(presentation.requestId,"safe-request")
        XCTAssertFalse(presentation.key.contains("customer"))
    }
    func testAuthorizationAndDeviceFailuresHaveDistinctRecovery() {
        XCTAssertEqual(FailurePresentation(APIError(status:401,code:"unauthorized",message:"English only")).key,"session_expired")
        XCTAssertEqual(FailurePresentation(APIError(status:401,code:"device_revoked",message:"English only")).key,"pos_pairing_required")
        XCTAssertEqual(FailurePresentation(APIError(status:403,code:"pos_staff_not_allowed",message:"English only")).key,"permission_denied")
    }
    func testTransportAndVersionConflictsUseRecoveryKeys() {
        XCTAssertEqual(FailurePresentation(URLError(.networkConnectionLost)).key,"connection_interrupted")
        XCTAssertEqual(FailurePresentation(APIError(status:409,code:"stale_order",message:"English only")).key,"order_changed")
    }
}
final class BusinessDateTests: XCTestCase {
    func testBranchBusinessDayAndWesternDigitsOverrideRestaurantTimezone() throws {
        let date = try XCTUnwrap(ServerDate.parse("2026-10-24T22:30:00Z"))
        XCTAssertEqual(BusinessDate.day(date,branch:"Africa/Cairo",restaurant:"America/New_York"),"2026-10-25")
        XCTAssertEqual(BusinessDate.day(date,branch:nil,restaurant:"America/New_York"),"2026-10-24")
        XCTAssertEqual(BusinessDate.timezone(branch:"invalid",restaurant:nil),.gmt)
    }
}
final class ApprovedEnvironmentTests: XCTestCase {
    private let api = URL(string:"https://resuto-2-staging-api.onrender.com/v1")!
    private let auth = URL(string:"https://skvnznyfxpxfuzvuipju.supabase.co")!
    func testVerifiedStagingPairIsAccepted() { XCTAssertTrue(ApprovedEnvironment.contains(api:api,auth:auth)) }
    func testArbitraryAPIOrAuthHostCannotReceiveCredentials() {
        XCTAssertFalse(ApprovedEnvironment.contains(api:URL(string:"https://other.example/v1")!,auth:auth))
        XCTAssertFalse(ApprovedEnvironment.contains(api:api,auth:URL(string:"https://other.example")!))
    }
    func testUserInfoQueryFragmentAndUnexpectedPortAreRejected() {
        for url in ["https://user:password@resuto-2-staging-api.onrender.com/v1","https://resuto-2-staging-api.onrender.com/v1?redirect=other","https://resuto-2-staging-api.onrender.com:8443/v1","https://resuto-2-staging-api.onrender.com/v1#other"] {
            XCTAssertFalse(ApprovedEnvironment.contains(api:URL(string:url)!,auth:auth))
        }
    }
}
final class POSImageWindowTests: XCTestCase {
    func testExpiredMenuImageWindowRefreshesWithoutBusinessEvent() async throws {
        let emptyPage = try JSONEncoder().encode(page([],head:0,next:0))
        let (client,transport,_,_,_) = try await setup([
            jsonResult(sessionJSON()),jsonResult(["cursor":"menu-1","unchanged":false,"currency":"EGP","categories":[],"stations":[]]),
            jsonResult(["cursor":"floor-1","unchanged":false,"layout":["revision":1],"tables":[]]),
            jsonResult(["cursor":"orders-0","mode":"full","orders":[],"hasMore":false]),HTTPResult(data:emptyPage,status:200),
            jsonResult(sessionJSON()),jsonResult(["cursor":"menu-2","unchanged":false,"currency":"EGP","categories":[],"stations":[]]),HTTPResult(data:emptyPage,status:200)])
        let journal = try POSEventJournal(scope:scope(),deviceId:"device",storage:MemoryStore()), storage = MemoryStore()
        let first = try POSShadowSync(client:client,membership:member(),deviceId:"device",journal:journal,storage:storage)
        try await first.poll(wait:0)
        var saved = try JSONSerialization.jsonObject(with:XCTUnwrap(storage.read())) as! [String:Any]
        saved["menuRefreshedAt"] = 0 // Expired local timestamp, no new menu.changed event.
        try storage.write(JSONSerialization.data(withJSONObject:saved))
        let restarted = try POSShadowSync(client:client,membership:member(),deviceId:"device",journal:journal,storage:storage)
        try await restarted.poll(wait:0)
        let snapshot = await restarted.current(), requests = await transport.requests
        XCTAssertEqual(snapshot.menu?.cursor,"menu-2")
        XCTAssertEqual(requests.filter { $0.url?.path == "/v1/pos/sync/menu" }.count,2)
        XCTAssertTrue(requests.contains { $0.url?.query == "since=menu-1" })
    }
}
final class StagingReceiptTests: XCTestCase {
    func testUnpaidStagingReceiptIsMarkedTestWithoutClaimingPayment() throws {
        let order: OrderDetail = try decode("detail")
        let receipt = Receipt(order:order,restaurant:"QA",arabic:true,testEnvironment:true)
        XCTAssertTrue(receipt.isTest); XCTAssertEqual(receipt.paymentStatus,"unpaid")
        XCTAssertEqual(receipt.due,order.dueMinor); XCTAssertEqual(receipt.total,order.totalMinor)
    }
}
final class ArabicAmountEntryTests: XCTestCase {
    func testArabicKeyboardDecimalSeparatorUsesExactMinorUnits() {
        XCTAssertEqual(Money.parse("١٠٫٥٠"),1050); XCTAssertEqual(Money.parse("0٫09"),9)
        XCTAssertNil(Money.parse("1٫2٫3")); XCTAssertNil(Money.parse("1٬23"))
    }
}
final class InitialSessionTests: XCTestCase {
    func testEmptyKeychainDoesNotEstablishASessionOrContactServer() async throws {
        let transport = ScriptedTransport([])
        let auth = try AuthService(url:URL(string:"https://auth.example")!,publicKey:"public",transport:transport,secrets:MemoryStore())
        let present = await auth.hasSession(); XCTAssertFalse(present)
        let requests = await transport.requests; XCTAssertTrue(requests.isEmpty)
    }
}
final class POS020ContractTests: XCTestCase {
    func testTopLevelRequireStaffMustMatchRequiredDevicePolicy() throws {
        var object = sessionJSON(); object["requireStaff"] = false
        let session: POSSession = try parsed(object)
        XCTAssertThrowsError(try session.validate(scope:scope(),membership:member()))
    }
    func testImplemented020SessionRequiresTopLevelPolicyField() throws {
        var object = sessionJSON(); object.removeValue(forKey:"requireStaff")
        XCTAssertThrowsError(try parsed(object,POSSession.self))
    }
    func testDeviceBindingMetadataDoesNotExposeToken() async throws {
        let store = DeviceCredentialStore(secrets:MemoryStore()); try await store.save(pair(),scope:scope())
        let binding = try await store.binding(); XCTAssertEqual(binding?.branchId,branchID); XCTAssertEqual(binding?.orgId,"org")
    }
}

final class POSCancellationTests: XCTestCase {
    func testCancelledResyncNeverAcknowledgesFeedWatermark() async throws {
        let storage = MemoryStore()
        let journal = try POSEventJournal(scope:scope(),deviceId:"device",storage:storage)
        let task = Task {
            try await journal.resync(from:try parsed(["epoch":"epoch","head":5,"oldest":0])) { _ in
                withUnsafeCurrentTask { $0?.cancel() }
            }
        }
        do { try await task.value; XCTFail("Cancelled snapshot must not advance cursor") } catch is CancellationError {} catch { XCTFail("Unexpected failure: \(error)") }
        let position = await journal.position()
        XCTAssertNil(position); XCTAssertNil(try storage.read())
    }
    func testExpiredPairingCodeHasSpecificRecoveryInsteadOfStaffLogout() {
        XCTAssertEqual(FailurePresentation(APIError(status:401,code:"pairing_code_invalid",message:"hidden")).key,"pos_pairing_code_invalid")
    }
}

final class OperationalAccessLeaseTests: XCTestCase {
    func testLeaseExpiresWithoutSuccessfulIdentityRegardlessOfNetworkPath() {
        let now = Date(), lease = OperationalAccessLease(scope:scope(),now:now,uptime:100)
        XCTAssertTrue(lease.allows(scope(),now:now.addingTimeInterval(28_799),uptime:28_899))
        XCTAssertFalse(lease.allows(scope(),now:now.addingTimeInterval(28_800),uptime:28_900))
    }
    func testClockRollbackOrRestartCannotExtendAuthorization() {
        let now = Date(), lease = OperationalAccessLease(scope:scope(),now:now,uptime:100)
        XCTAssertFalse(lease.allows(scope(),now:now.addingTimeInterval(-1),uptime:101))
        XCTAssertFalse(lease.allows(scope(),now:now.addingTimeInterval(1),uptime:99))
        XCTAssertFalse(lease.allows(scope(),now:now.addingTimeInterval(1),uptime:29_000))
    }
    func testAnotherTenantCannotReuseLease() {
        let now = Date(), lease = OperationalAccessLease(scope:scope(),now:now,uptime:100)
        XCTAssertFalse(lease.allows(scope(org:"another"),now:now,uptime:100))
    }
}

final class PermissionPerformanceTests: XCTestCase {
    func testRepeatedPermissionHintsUseCachedRoleSets() {
        measure {
            var allowed = 0
            for index in 0..<20_000 {
                if Permissions.can(index.isMultiple(of:2) ? "manager" : "cashier","payments:refund") { allowed += 1 }
            }
            XCTAssertEqual(allowed,10_000)
        }
    }
}

private actor CacheReadGate: HTTPTransport {
    private var gate: CheckedContinuation<HTTPResult,Never>?
    private var waiting: CheckedContinuation<Void,Never>?
    private var reads = 0
    private(set) var requests: [URLRequest] = []
    func send(_ request: URLRequest) async throws -> HTTPResult {
        requests.append(request)
        if request.url?.path == "/auth/v1/token" { return try authResponse() }
        reads += 1
        if reads == 1 { return await withCheckedContinuation { gate = $0; waiting?.resume(); waiting = nil } }
        return HTTPResult(data:Data(),status:304)
    }
    func waitForRead() async { if gate != nil { return }; await withCheckedContinuation { waiting = $0 } }
    func finish() throws { gate?.resume(returning:HTTPResult(data:try fixture("me"),status:200,headers:["etag":"old-scope"])); gate = nil }
}
final class ScopedCacheRaceTests: XCTestCase {
    func testLateReadCannotRestoreCacheAfterScopeInvalidation() async throws {
        let transport = CacheReadGate(), auth = try AuthService(url:URL(string:"https://auth.example")!,publicKey:"public",transport:transport,secrets:MemoryStore())
        try await auth.signIn(email:"synthetic@example.test",password:"synthetic")
        let client = try APIClient(base:URL(string:"https://api.example/v1")!,auth:auth,transport:transport)
        let read = Task { let value: Me = try await client.get("me"); return value }
        await transport.waitForRead(); await client.clearCache(); try await transport.finish()
        do { _ = try await read.value; XCTFail("Late read must not restore another workspace") } catch is CancellationError {} catch { XCTFail("Unexpected error: \(error)") }
        do { let _: Me = try await client.get("me"); XCTFail("No old response may satisfy 304") } catch let error as APIError { XCTAssertEqual(error.status,304) }
        let requests = await transport.requests; XCTAssertNil(requests.last?.value(forHTTPHeaderField:"If-None-Match"))
    }
}

final class OrderDetailRefreshTests: XCTestCase {
    func testLatePollingCannotReopenDismissedDetailsOrRegressVersion() throws {
        let initial: OrderDetail = try decode("detail")
        XCTAssertFalse(OrderLifecycle.acceptsRefresh(current:nil,incoming:initial))
        var value = try JSONSerialization.jsonObject(with:fixture("detail")) as! [String:Any]
        value["version"] = 1; let newer: OrderDetail = try parsed(value)
        XCTAssertTrue(OrderLifecycle.acceptsRefresh(current:initial,incoming:newer))
        XCTAssertFalse(OrderLifecycle.acceptsRefresh(current:newer,incoming:initial))
        value["id"] = "another-order"; let another: OrderDetail = try parsed(value)
        XCTAssertFalse(OrderLifecycle.acceptsRefresh(current:another,incoming:newer))
    }
}
