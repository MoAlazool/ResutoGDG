#if DEBUG && targetEnvironment(simulator)
import Foundation

/// A simulator-only contract test double. Never compiled into Release or device builds.
/// Fixtures arrive from the XCTest process, not from production application resources.
struct UITestBootstrap {
    let transport: any HTTPTransport
    let reset: Bool
    let configuration: Configuration
    static func load() -> UITestBootstrap? {
        let process = ProcessInfo.processInfo
        guard process.arguments.contains("--resuto-ui-testing"),
              let raw = process.environment["RESUTO_UI_FIXTURES"],
              let data = raw.data(using: .utf8),
              let fixtures = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              fixtures["menu"] != nil else { return nil }
        return UITestBootstrap(transport: ScenarioTransport(fixtures: fixtures, role: process.environment["RESUTO_UI_ROLE"] ?? "manager"), reset: process.arguments.contains("--resuto-ui-reset"), configuration: Configuration(apiURL: URL(string: "https://api.uitest.invalid/v1")!, supabaseURL: URL(string: "https://auth.uitest.invalid")!, publicKey: "sb_publishable_ui_test_only"))
    }
}
actor ScenarioTransport: HTTPTransport {
    private let fixtures: [String: Any]
    private let role: String
    private var soldOut = false
    private var order: [String: Any]?
    private var acceptedByKey: [String: [String: Any]] = [:]
    private let branchID = "22222222-2222-4222-8222-222222222222"
    init(fixtures: [String: Any], role: String) { self.fixtures = fixtures; self.role = role }
    func send(_ request: URLRequest) async throws -> HTTPResult {
        let path = request.url!.path
        let body = request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        if path == "/auth/v1/token" {
            return try response(["access_token":"ui-contract-token", "refresh_token":"ui-contract-refresh", "expires_in":3600])
        }
        if path == "/auth/v1/logout" { return HTTPResult(data: Data(), status: 204) }
        guard request.value(forHTTPHeaderField: "Authorization") == "Bearer ui-contract-token" else { return try failure(401, "unauthorized") }
        if path == "/v1/me" {
            var me = fixtures["me"] as! [String: Any]
            var members = me["memberships"] as! [[String: Any]]; members[0]["role"] = role; me["memberships"] = members
            return try response(me)
        }
        if path == "/v1/o/org" {
            return try response(["id":"org", "name":"UI Test Restaurant", "currency":"EGP", "timezone":"Africa/Cairo", "branches":[["id":branchID,"name":"UI Test Branch","nameAr":"فرع الاختبار","isActive":true,"acceptsDineIn":true,"acceptsPickup":true,"acceptsDelivery":true]]])
        }
        if path == "/v1/o/org/menu" {
            var menu = fixtures["menu"] as! [String:Any], products = (fixtures["menu"] as! [String:Any])["products"] as! [[String:Any]]
            var settings = products[0]["branchSettings"] as! [[String:Any]]; settings[0]["soldOut"] = soldOut; products[0]["branchSettings"] = settings; menu["products"] = products
            return try response(menu)
        }
        if path.hasSuffix("/availability"), request.httpMethod == "POST" {
            guard Permissions.can(role,"menu:availability"), body["branchId"] as? String == branchID else { return try failure(403,"forbidden") }
            soldOut = body["available"] as? Bool != true; return try response(["available":!soldOut])
        }
        if path == "/v1/o/org/floor/\(branchID)" { return try response(fixtures["floor"]!) }
        if path == "/v1/o/org/floor/\(branchID)/live" { return try response(["revision":1,"tables":(fixtures["floor"] as! [String: Any])["tables"]!]) }
        if path == "/v1/o/org/orders", request.httpMethod == "POST" {
            guard Permissions.can(role, "orders:write"), let key = request.value(forHTTPHeaderField: "Idempotency-Key") else { return try failure(403, "forbidden") }
            if let existing = acceptedByKey[key] { return try response(existing, status: 201) }
            guard body["branchId"] as? String == branchID, body["channel"] as? String == "staff" else { return try failure(400, "validation_failed") }
            order = fixtures["detail"] as? [String: Any]
            order!["id"] = "33333333-3333-4333-8333-333333333333"
            order!["fulfillment"] = body["fulfillment"]
            order!["tableLabel"] = body["tableId"] == nil ? NSNull() : "T1" as Any
            let result = fixtures["accepted"] as! [String: Any]; acceptedByKey[key] = result
            return try response(result, status: 201)
        }
        if path == "/v1/o/org/orders" {
            var summaries: [[String: Any]] = []
            if let order {
                var summary = (fixtures["orders"] as! [String: Any])["items"] as! [[String: Any]]
                for key in ["id","status","paymentStatus","dueMinor","version","fulfillment","tableLabel"] { summary[0][key] = order[key] }
                summaries = summary
            }
            return try response(["items":summaries,"nextCursor":NSNull()])
        }
        if path == "/v1/o/org/kitchen/\(branchID)" {
            var tickets: [[String: Any]] = []
            if let order {
                var ticket = order
                ticket["ageSeconds"] = 2; ticket["tableLabel"] = order["tableLabel"] ?? NSNull(); ticket["notes"] = NSNull()
                var lines = order["lines"] as! [[String: Any]]
                lines[0]["modifiers"] = ["Regular"]; ticket["lines"] = lines
                tickets = [ticket]
            }
            return try response(["cursor":"ui-1", "stations":["kitchen"],"tickets":tickets])
        }
        if path.hasSuffix("/transition"), var current = order {
            guard body["version"] as? Int == current["version"] as? Int else { return try failure(409, "version_conflict") }
            current["status"] = body["to"]; current["version"] = (current["version"] as! Int) + 1; order = current
            return try response(["changed":true])
        }
        if path.hasSuffix("/collect"), var current = order {
            guard let key = request.value(forHTTPHeaderField: "Idempotency-Key") else { return try failure(400,"idempotency_key_required") }
            if let replay = acceptedByKey[key] { return try response(replay) }
            let amount = body["amountMinor"] as! Int; let due = current["dueMinor"] as! Int
            guard amount > 0 && amount <= due else { return try failure(409,"nothing_due") }
            current["dueMinor"] = due - amount; current["paymentStatus"] = due == amount ? "paid" : "partially_paid"
            current["payments"] = [["id":"payment", "method":"cash", "status":"succeeded", "amountMinor":amount,"refundedMinor":0,"isTest":true]]; order = current
            let result: [String: Any] = ["paymentId":"payment","amountMinor":amount,"paymentStatus":current["paymentStatus"]!,"dueMinor":due-amount]
            acceptedByKey[key] = result; return try response(result)
        }
        if path.hasPrefix("/v1/o/org/orders/"), let order { return try response(order) }
        if path == "/v1/o/org/reservations" { return try response(["date":"2026-10-24","items":[]]) }
        return try failure(404,"not_found")
    }
    private func response(_ object: Any, status: Int = 200) throws -> HTTPResult { HTTPResult(data: try JSONSerialization.data(withJSONObject: object), status: status) }
    private func failure(_ status: Int, _ code: String) throws -> HTTPResult { try response(["error":["code":code,"message":code]], status: status) }
}
#endif
