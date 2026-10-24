import Foundation
import ResutoCore
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

private final class TransientSecrets: SecretStore, @unchecked Sendable {
    private let lock = NSLock(); private var data: Data?
    func read(_ key: String) throws -> Data? { lock.lock(); defer { lock.unlock() }; return data }
    func write(_ value: Data, key: String) throws { lock.lock(); defer { lock.unlock() }; data = value }
    func remove(_ key: String) throws { lock.lock(); defer { lock.unlock() }; data = nil }
}
private final class RefuseRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
private struct Health: Decodable { struct Build: Decodable { let commit: String }; let environment: String; let paymentMode: String; let status: String; let build: Build }
private struct Cash: Encodable, Sendable { let amountMinor: Int64; let method = "cash"; let reference = "Native QA synthetic staging transaction" }
private struct Transition: Encodable, Sendable { let to: String; let version: Int }
private struct Analytics: Decodable, Sendable {
    struct Totals: Decodable, Sendable { let orders: Int; let netMinor: Int64; let paidMinor: Int64 }
    let totals: Totals
}
private struct Evidence: Codable {
    var scope = "Native Swift API client; browser and physical-device verification are separate"
    var observedAt = ISO8601DateFormatter().string(from:Date()); var apiCommit: String?
    var checks: [String] = []; var blocked: [String] = []; var orderId: String?; var operationId: String?; var collectionKey: String?
}
@main enum StagingProbe {
    static func main() async {
        var evidence = Evidence()
        // Never overwrite a prior run: its operation/payment keys may be needed to reconcile ambiguity.
        if let path = ProcessInfo.processInfo.environment["RESUTO_EVIDENCE_PATH"], FileManager.default.fileExists(atPath: path) {
            print("{\"blocked\":[\"evidence_path_already_exists_reconcile_prior_run_first\"]}"); exit(78)
        }
        do {
            let env = ProcessInfo.processInfo.environment
            guard let base = URL(string: env["RESUTO_API_URL"] ?? "https://resuto-2-staging-api.onrender.com/v1") else { throw RuleError.invalid("staging_api_required") }
            guard base.scheme == "https", base.host == "resuto-2-staging-api.onrender.com", base.path == "/v1", base.user == nil, base.password == nil, base.query == nil, base.fragment == nil else { throw RuleError.invalid("staging_api_required") }
            let configuration = URLSessionConfiguration.ephemeral; configuration.urlCache = nil; configuration.httpCookieStorage = nil
            let transport = URLSessionTransport(session: URLSession(configuration: configuration, delegate: RefuseRedirects(), delegateQueue: nil))
            let healthResponse = try await transport.send(URLRequest(url: base.appendingPathComponent("health")))
            let health = try JSONDecoder().decode(Health.self, from: healthResponse.data)
            guard healthResponse.status == 200, health.environment == "staging", health.status == "ok", health.paymentMode == "sandbox" else { throw RuleError.invalid("healthy_sandbox_staging_required") }
            evidence.apiCommit = health.build.commit
            evidence.checks.append("native_URLSession_staging_health")
            let denied = try await transport.send(URLRequest(url: base.appendingPathComponent("me")))
            guard denied.status == 401 else { throw RuleError.invalid("unauthenticated_identity_not_rejected") }
            evidence.checks.append("unauthenticated_identity_401")
            if ProcessInfo.processInfo.arguments.contains("--public-only") { evidence.blocked = ["authenticated_lifecycle_not_requested","browser_dashboard_not_verified","physical_device_not_verified"]; try report(evidence, path: env["RESUTO_EVIDENCE_PATH"]); return }
            let required = ["RESUTO_SUPABASE_URL","RESUTO_PUBLISHABLE_KEY","RESUTO_STAFF_EMAIL","RESUTO_STAFF_PASSWORD","RESUTO_TEST_ORG_ID","RESUTO_TEST_BRANCH_ID"]
            let missing = required.filter { env[$0]?.isEmpty != false }
            guard missing.isEmpty else { evidence.blocked = missing.map { "missing_" + $0 }; try report(evidence, path: env["RESUTO_EVIDENCE_PATH"]); exit(78) }
            guard env["RESUTO_SUPABASE_URL"] == "https://skvnznyfxpxfuzvuipju.supabase.co" else { throw RuleError.invalid("staging_supabase_required") }
            let auth = try AuthService(url: URL(string: env["RESUTO_SUPABASE_URL"]!)!, publicKey: env["RESUTO_PUBLISHABLE_KEY"]!, transport: transport, secrets: TransientSecrets())
            try await auth.signIn(email: env["RESUTO_STAFF_EMAIL"]!, password: env["RESUTO_STAFF_PASSWORD"]!)
            let api = try APIClient(base: base, auth: auth, transport: transport)
            let me: Me = try await api.get("me")
            let org = env["RESUTO_TEST_ORG_ID"]!, branch = env["RESUTO_TEST_BRANCH_ID"]!
            guard let membership = me.memberships.first(where: { $0.orgId == org }), membership.allows(branch: branch) else { throw RuleError.invalid("dedicated_test_membership_required") }
            let restaurant: Restaurant = try await api.get("o/\(org)")
            guard restaurant.name == "Resuto Native QA", restaurant.branches.contains(where: { $0.id == branch && $0.isActive }) else { throw RuleError.invalid("dedicated_native_qa_restaurant_required") }
            evidence.checks.append("real_Supabase_staff_auth_and_branch_context")
            let menu: Menu = try await api.get("o/\(org)/menu")
            let _: FloorLayout = try await api.get("o/\(org)/floor/\(branch)")
            let _: LiveFloor = try await api.get("o/\(org)/floor/\(branch)/live")
            let _: Page<OrderSummary> = try await api.get("o/\(org)/orders", query: ["branchId":branch,"limit":"50"])
            evidence.checks.append("typed_native_catalogue_floor_and_web_orders_read_models")
            guard env["RESUTO_STAGING_WRITE"] == "1" else { evidence.blocked = ["write_lifecycle_not_enabled","browser_dashboard_not_verified","physical_device_not_verified"]; try report(evidence, path: env["RESUTO_EVIDENCE_PATH"]); return }
            guard let evidencePath = env["RESUTO_EVIDENCE_PATH"], !evidencePath.isEmpty else { throw RuleError.invalid("write_lifecycle_requires_durable_evidence_path") }
            guard membership.can("orders:write"), membership.can("kitchen:operate"), membership.can("payments:collect"), membership.can("analytics:read"), let productID = env["RESUTO_TEST_PRODUCT_ID"], let product = menu.products(branch: branch).first(where: { $0.id == productID }) else { throw RuleError.invalid("dedicated_manager_and_test_product_required") }
            let selections = menu.modifierGroups.filter { product.modifierGroupIds.contains($0.id) && $0.isActive }.flatMap { group in group.options.filter(\.isAvailable).prefix(group.minSelect).map { ModifierSelection(groupId: group.id, optionId: $0.id) } }
            let payload = StaffOrder(branchId: branch, fulfillment: "pickup", lines: [CartLine(productId: product.id, quantity: 1, modifiers: selections)], notes: "Native QA synthetic staging lifecycle")
            _ = try CartRules.estimate(payload, menu: menu)
            let formatter = DateFormatter(); formatter.locale = Locale(identifier:"en_US_POSIX"); formatter.timeZone = TimeZone(identifier: restaurant.timezone); formatter.dateFormat = "yyyy-MM-dd"
            let date = formatter.string(from: Date()), period = ["branchId":branch,"from":date,"to":date]
            let before: Analytics = try await api.get("o/\(org)/analytics/summary", query: period)
            let operation = UUID().uuidString
            evidence.operationId = operation
            try checkpoint(evidence,path:evidencePath)
            let accepted: OrderAccepted = try await api.post("o/\(org)/orders", body: payload, key: operation)
            evidence.operationId = operation; evidence.orderId = accepted.id
            try checkpoint(evidence,path:evidencePath)
            let replay: OrderAccepted = try await api.post("o/\(org)/orders", body: payload, key: operation)
            guard replay.id == accepted.id else { throw RuleError.invalid("duplicate_order_detected") }
            evidence.checks.append("native_staff_order_idempotent_replay_same_order")
            let page: Page<OrderSummary> = try await api.get("o/\(org)/orders", query: ["branchId":branch,"q":accepted.number])
            let kitchen: KitchenFeed = try await api.get("o/\(org)/kitchen/\(branch)")
            guard page.items.contains(where: { $0.id == accepted.id }), kitchen.tickets?.filter({ $0.id == accepted.id }).count == 1 else { throw RuleError.invalid("web_orders_or_KDS_missing_or_duplicate") }
            evidence.checks.append("same_order_in_web_orders_API_and_KDS_API")
            var detail: OrderDetail = try await api.get("o/\(org)/orders/\(accepted.id)")
            for next in ["accepted","preparing","ready"] {
                let _: EmptyResponse = try await api.post("o/\(org)/kitchen/orders/\(accepted.id)/bump", body: Transition(to: next, version: detail.version))
                detail = try await api.get("o/\(org)/orders/\(accepted.id)")
                guard detail.status == next else { throw RuleError.invalid("kitchen_to_native_status_not_synchronized") }
            }
            evidence.checks.append("KDS_status_changes_visible_to_native_order_client")
            let collectionKey = UUID().uuidString, cash = Cash(amountMinor: detail.dueMinor)
            evidence.collectionKey = collectionKey; try checkpoint(evidence,path:evidencePath)
            let collected: CollectResult = try await api.post("o/\(org)/orders/\(accepted.id)/collect", body: cash, key: collectionKey)
            let repeated: CollectResult = try await api.post("o/\(org)/orders/\(accepted.id)/collect", body: cash, key: collectionKey)
            detail = try await api.get("o/\(org)/orders/\(accepted.id)")
            guard collected.paymentId == repeated.paymentId, detail.paymentStatus == "paid", detail.dueMinor == 0 else { throw RuleError.invalid("payment_not_reconciled") }
            let _: EmptyResponse = try await api.post("o/\(org)/orders/\(accepted.id)/transition", body: Transition(to:"picked_up",version:detail.version))
            let after: Analytics = try await api.get("o/\(org)/analytics/summary", query: period)
            guard after.totals.orders == before.totals.orders + 1, after.totals.netMinor == before.totals.netMinor + detail.totalMinor, after.totals.paidMinor == before.totals.paidMinor + cash.amountMinor else { throw RuleError.invalid("analytics_order_totals_not_reconciled") }
            evidence.checks += ["server_confirmed_cash_idempotency_and_paid_order","analytics_order_count_and_net_totals_reconciled"]
            evidence.blocked = ["browser_dashboard_UI_requires_authorized_Vercel_session","inventory_effects_require_dedicated_recipe_fixture","physical_iPad_and_printer_not_verified"]
            try report(evidence, path:env["RESUTO_EVIDENCE_PATH"])
        } catch {
            // Never dump request bodies, credential values, tokens or customer information.
            evidence.blocked.append((error as? APIError)?.code ?? (error as? RuleError)?.errorDescription ?? "probe_failed")
            try? report(evidence, path:ProcessInfo.processInfo.environment["RESUTO_EVIDENCE_PATH"]); exit(1)
        }
    }
    private static func checkpoint(_ evidence: Evidence, path: String) throws {
        try JSONEncoder().encode(evidence).write(to:URL(fileURLWithPath:path),options:.atomic)
    }
    private static func report(_ evidence: Evidence, path: String?) throws {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted,.sortedKeys]
        let data = try encoder.encode(evidence)
        if let path { try data.write(to: URL(fileURLWithPath:path), options:.atomic) }
        print(String(decoding:data,as:UTF8.self))
    }
}
