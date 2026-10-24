import SwiftUI
import Network
import CryptoKit

@MainActor final class POSModel: ObservableObject {
    @Published var me: Me?
    @Published var membership: Membership?
    @Published var restaurant: Restaurant?
    @Published var branch: Branch?
    @Published var menu: Menu?
    @Published var layout: FloorLayout?
    @Published var live: LiveFloor?
    @Published var orders: [OrderSummary] = []
    @Published var historyOrders: [OrderSummary] = []
    @Published var tickets: [KitchenTicket] = []
    @Published var pending: [PendingOrder] = []
    @Published var printJobs: [PrintJob] = []
    @Published var cart: [CartLine] = []
    @Published var fulfillment = "pickup"
    @Published var selectedTable: FloorTable?
    @Published var notes = ""
    @Published var customerId: String?
    @Published var customerName: String?
    @Published var deliveryLine = ""
    @Published var deliveryArea = ""
    @Published var deliveryCity = ""
    @Published var reservations: [ReservationRecord] = []
    @Published var promotion = ""
    @Published var error: String?
    @Published var notice: String?
    @Published var busy = false
    @Published var reachable = true
    @Published var lastRefresh: Date?
    @Published var cacheDate: Date?
    @Published var nextCursor: String?
    @Published var detail: OrderDetail?
    @Published var configuration = Configuration.saved
    @Published var locked = false
    @Published var refundStatus: String?
    private var auth: AuthService?
    private var api: APIClient?
    private var queue: OrderQueue?
    private var prints: PrintQueue?
    private var cache: EncryptedStore?
    private var draft: EncryptedStore?
    private var financialStore: EncryptedStore?
    @Published private(set) var financial: FinancialIntent?
    private let monitor = NWPathMonitor()
    private var generation = UUID()
    private var draftID = UUID()
    private var refreshing = false
    var scope: Scope? {
        guard let configuration, let me, let membership, let branch else { return nil }
        return Scope(environment: configuration.apiURL.absoluteString, userId: me.user.id, orgId: membership.orgId, branchId: branch.id)
    }
    var draftOrder: StaffOrder? {
        guard let branch else { return nil }
        return StaffOrder(branchId: branch.id, fulfillment: fulfillment, tableId: selectedTable?.id, visitId: selectedTable?.visit?.id, lines: cart, notes: notes, promotionCode: promotion.isEmpty ? nil : promotion, customerId: customerId, deliveryAddress: fulfillment == "delivery" ? DeliveryAddress(line1: deliveryLine, area: deliveryArea, city: deliveryCity) : nil)
    }
    var estimate: Int64? { guard let menu, let order = draftOrder else { return nil }; return try? CartRules.estimate(order, menu: menu) }
    func can(_ permission: String) -> Bool {
        let offlineAccess = reachable || (lastRefresh.map { Date().timeIntervalSince($0) < 8 * 3600 } ?? false)
        return membership?.can(permission) == true && !locked && offlineAccess
    }
    init() {
        monitor.pathUpdateHandler = { [weak self] path in Task { @MainActor in self?.reachable = path.status == .satisfied } }
        monitor.start(queue: DispatchQueue(label: "resuto.connectivity"))
    }
    func perform(_ operation: @MainActor () async throws -> Void) async {
        guard !busy else { return }; busy = true; error = nil; defer { busy = false }
        do { try await operation() } catch { handle(error) }
    }
    func handle(_ failure: Error) {
        error = (failure as? LocalizedError)?.errorDescription ?? failure.localizedDescription
        if let api = failure as? APIError, [401, 403].contains(api.status) {
            // No continuing access to stale tenant data after revocation or membership removal.
            locked = true; menu = nil; layout = nil; live = nil; orders = []; tickets = []; detail = nil
        }
    }
    func configure(_ value: Configuration) throws { try value.save(); configuration = value; auth = nil; api = nil }
    private func connect() throws {
        guard let configuration else { throw RuleError.invalid("configuration_required") }; try configuration.validate()
        if api != nil { return }
        let transport = RejectRedirects.transport()
        let auth = try AuthService(url: configuration.supabaseURL, publicKey: configuration.publicKey, transport: transport, secrets: KeychainStore(namespace: configuration.namespace))
        self.auth = auth; api = try APIClient(base: configuration.apiURL, auth: auth, transport: transport)
    }
    func restore() async { guard configuration != nil else { return }; await perform { try connect(); try await loadIdentity() } }
    func signIn(email: String, password: String) async throws { try connect(); try await auth!.signIn(email: email, password: password); try await loadIdentity() }
    func loadIdentity() async throws {
        let identity: Me = try await api!.get("me"); me = identity; locked = false
    }
    func choose(_ membership: Membership) async throws {
        generation = UUID(); clearWorkspace(); await api?.clearCache()
        guard me?.memberships.contains(membership) == true else { throw RuleError.invalid("forbidden") }
        let value: Restaurant = try await api!.get("o/\(membership.orgId)")
        self.membership = membership; restaurant = value
    }
    func choose(_ branch: Branch) async throws {
        guard let membership, membership.allows(branch: branch.id), restaurant?.branches.contains(where: { $0.id == branch.id && $0.isActive }) == true else { throw RuleError.invalid("forbidden") }
        generation = UUID(); draftID = UUID(); self.branch = branch; fulfillment = branch.acceptsPickup ? "pickup" : (branch.acceptsDineIn ? "dine_in" : "delivery"); customerId = nil; customerName = nil; reservations = []; deliveryLine = ""; deliveryArea = ""; deliveryCity = ""; cart = []; notes = ""; promotion = ""; selectedTable = nil; detail = nil
        menu = nil; layout = nil; live = nil; orders = []; historyOrders = []; nextCursor = nil; tickets = []; pending = []; financial = nil; lastRefresh = nil
        guard let scope, let configuration, let api else { return }
        let hash = SHA256.hash(data: try JSONEncoder().encode(scope)).map { String(format: "%02x", $0) }.joined()
        let namespace = configuration.namespace + "." + hash
        cache = try EncryptedStore(name: "workspace", namespace: namespace)
        draft = try EncryptedStore(name: "draft", namespace: namespace)
        financialStore = try EncryptedStore(name: "financial-intent", namespace: namespace)
        financial = try financialStore!.read().flatMap { try JSONDecoder().decode(FinancialIntent?.self, from: $0) }
        queue = try OrderQueue(storage: EncryptedStore(name: "outbox", namespace: namespace), submitter: RemoteOrderSubmitter(api: api))
        prints = try PrintQueue(storage: EncryptedStore(name: "prints", namespace: namespace))
        if let data = try cache?.read() {
            let cached = try JSONDecoder().decode(CachedWorkspace.self, from: data)
            if cached.scope == scope, Date().timeIntervalSince(cached.savedAt) < 24 * 3600 { menu = cached.menu; layout = cached.floor; cacheDate = cached.savedAt }
        }
        let capturedIDs = Set(await queue!.list(scope: scope).map(\.id))
        if let data = try draft?.read(), let saved = try JSONDecoder().decode(DraftSnapshot?.self, from: data), saved.scope == scope,
           saved.id.map({ !capturedIDs.contains($0) }) ?? true {
            draftID = saved.id ?? UUID()
            customerId = saved.order.customerId; deliveryLine = saved.order.deliveryAddress?.line1 ?? ""; deliveryArea = saved.order.deliveryAddress?.area ?? ""; deliveryCity = saved.order.deliveryAddress?.city ?? ""
            cart = saved.order.lines; fulfillment = saved.order.fulfillment; notes = saved.order.notes ?? ""; promotion = saved.order.promotionCode ?? ""
            selectedTable = layout?.tables.first { $0.id == saved.order.tableId }
        }
        pending = await queue!.list(scope: scope); printJobs = await prints!.list()
        try await refresh()
    }
    func persistDraft() {
        guard let draft, let scope, let order = draftOrder else { return }
        do { try draft.write(JSONEncoder().encode(DraftSnapshot(scope: scope, order: order, id: draftID))) } catch { handle(error) }
    }
    func add(_ line: CartLine) { cart.append(line); persistDraft() }
    func refresh() async throws {
        guard reachable, !locked, !refreshing, let scope, let api else { return }
        refreshing = true; defer { refreshing = false }
        let snapshot = generation
        // Revalidate role and branch restrictions before queue replay, not merely a cached permission hint.
        let identity: Me = try await api.get("me")
        guard snapshot == generation else { return }
        guard let current = identity.memberships.first(where: { $0.orgId == scope.orgId }), current.allows(branch: scope.branchId) else { throw APIError(status: 403, code: "forbidden", message: "permission_denied") }
        if let previous = membership, previous.role != current.role || previous.branchIds != current.branchIds {
            throw APIError(status: 403, code: "permissions_changed", message: "session_expired")
        }
        membership = current; me = identity
        if can("menu:read") {
            let value: Menu = try await api.get("o/\(scope.orgId)/menu"); guard snapshot == generation else { return }; menu = value
        }
        if can("floor:read") {
            let floor: FloorLayout = try await api.get("o/\(scope.orgId)/floor/\(scope.branchId)")
            let status: LiveFloor = try await api.get("o/\(scope.orgId)/floor/\(scope.branchId)/live")
            guard snapshot == generation else { return }; layout = floor; live = status
        }
        if can("orders:read") {
            let page: Page<OrderSummary> = try await api.get("o/\(scope.orgId)/orders", query: ["branchId": scope.branchId, "status": "awaiting_payment,placed,accepted,preparing,ready", "limit": "200"])
            guard snapshot == generation else { return }; orders = page.items
            if let visible = detail {
                let fresh: OrderDetail = try await api.get("o/\(scope.orgId)/orders/\(visible.id)")
                guard snapshot == generation, fresh.branchId == scope.branchId else { return }; detail = fresh
            }
        }
        if can("kitchen:operate") {
            let feed: KitchenFeed = try await api.get("o/\(scope.orgId)/kitchen/\(scope.branchId)")
            guard snapshot == generation else { return }; if feed.unchanged != true { tickets = feed.tickets ?? [] }
        }
        try cache?.write(JSONEncoder().encode(CachedWorkspace(scope: scope, menu: menu, floor: layout)))
        lastRefresh = Date(); cacheDate = lastRefresh
        try await queue?.drain(scope: scope, authorized: can("orders:write"))
        guard snapshot == generation else { return }; pending = await queue?.list(scope: scope) ?? []
    }
    func kitchenLine(_ id: String, status: String) async throws {
        guard reachable, can("kitchen:operate"), let scope, let api, ["queued", "preparing", "ready"].contains(status) else { throw RuleError.invalid("permission_denied") }
        let _: EmptyResponse = try await api.post("o/\(scope.orgId)/kitchen/lines/\(id)", body: ["status": status])
        try await refresh()
    }
    func customers(query: String) async throws -> [Customer] {
        guard reachable, can("customers:read"), let scope, let api else { throw RuleError.invalid("permission_denied") }
        let page: Page<Customer> = try await api.get("o/\(scope.orgId)/customers", query: ["q": String(query.prefix(120)), "branchId": scope.branchId, "limit": "50"])
        return page.items
    }
    func loadReservations(date: Date) async throws {
        guard reachable, can("reservations:read"), let scope, let api else { throw RuleError.invalid("online_required") }
        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.timeZone = TimeZone(identifier: restaurant?.timezone ?? "UTC"); formatter.dateFormat = "yyyy-MM-dd"
        let day: ReservationDay = try await api.get("o/\(scope.orgId)/reservations", query: ["branchId": scope.branchId, "date": formatter.string(from: date)])
        reservations = day.items.filter { $0.branchId == scope.branchId }
    }
    func reservationCheckIn(_ reservation: ReservationRecord, tableId: String) async throws {
        guard reachable, can("reservations:write"), let scope, let api else { throw RuleError.invalid("permission_denied") }
        let _: EmptyResponse = try await api.post("o/\(scope.orgId)/reservations/\(reservation.id)/check-in", body: ["tableId": tableId])
        try await refresh()
    }
    func loadHistory(reset: Bool) async throws {
        guard let scope, let api, can("orders:read"), reachable else { throw RuleError.invalid("online_required") }
        let snapshot = generation
        var query = ["branchId": scope.branchId, "limit": "50"]
        if !reset { guard let nextCursor else { return }; query["cursor"] = nextCursor }
        let page: Page<OrderSummary> = try await api.get("o/\(scope.orgId)/orders", query: query)
        guard snapshot == generation else { return }
        if reset { historyOrders = page.items }
        else { historyOrders += page.items.filter { item in !historyOrders.contains { $0.id == item.id } } }
        nextCursor = page.nextCursor
    }
    func moreOrders() async throws { try await loadHistory(reset: false) }
    @discardableResult func saveOrder() async throws -> UUID {
        guard can("orders:write"), let order = draftOrder, let menu, let scope, let queue else { throw RuleError.invalid("permission_denied") }
        _ = try CartRules.estimate(order, menu: menu)
        let id = try await queue.save(scope: scope, payload: order, id: draftID)
        draftID = UUID()
        cart = []; notes = ""; promotion = ""; customerId = nil; customerName = nil; deliveryLine = ""; deliveryArea = ""; deliveryCity = ""; persistDraft(); pending = await queue.list(scope: scope); return id
    }
    func prepareCurrentDraft() async throws {
        guard reachable, can("orders:write"), let scope, let api, let order = draftOrder else { throw RuleError.invalid("online_required") }
        let fresh: Menu = try await api.get("o/\(scope.orgId)/menu"); menu = fresh
        _ = try CartRules.estimate(order, menu: fresh)
    }
    func sendCurrentDraft() async throws {
        let id = try await saveOrder()
        guard let operation = pending.first(where: { $0.id == id }) else { throw RuleError.invalid("missing_operation") }
        try await approve(operation)
        if let accepted = pending.first(where: { $0.id == id }), accepted.state == .accepted {
            notice = "#\(accepted.serverNumber ?? "") · accepted"
        }
    }
    func prepareReview(_ operation: PendingOrder) async throws {
        guard reachable, let scope, let api, operation.scope == scope else { throw RuleError.invalid("online_required") }
        let fresh: Menu = try await api.get("o/\(scope.orgId)/menu")
        _ = try CartRules.estimate(operation.payload, menu: fresh); menu = fresh
    }
    func approve(_ operation: PendingOrder) async throws {
        guard reachable, can("orders:write"), let api, let scope, let queue else { throw RuleError.invalid("online_required") }
        let fresh: Menu = try await api.get("o/\(scope.orgId)/menu")
        guard let reviewed = menu, try CartRules.estimate(operation.payload, menu: reviewed) == CartRules.estimate(operation.payload, menu: fresh) else {
            menu = fresh; throw RuleError.invalid("price_changed")
        }
        menu = fresh
        try await queue.approve(operation.id, scope: scope, menu: fresh)
        pending = await queue.list(scope: scope)
        try await refresh()
    }
    func retry(_ operation: PendingOrder) async throws {
        guard let queue, let scope else { return }; try await queue.retry(operation.id, scope: scope); try await refresh()
    }
    func discard(_ operation: PendingOrder) async throws {
        guard let queue, let scope else { return }; try await queue.discardLocal(operation.id, scope: scope); pending = await queue.list(scope: scope)
    }
    func openOrder(_ id: String) async throws {
        guard reachable, let scope, let api else { throw RuleError.invalid("online_required") }
        let value: OrderDetail = try await api.get("o/\(scope.orgId)/orders/\(id)")
        guard value.branchId == scope.branchId else { throw RuleError.invalid("branch_mismatch") }; detail = value
    }
    func transition(_ order: OrderDetail) async throws {
        guard can("orders:status"), reachable, let next = OrderLifecycle.next(order.status, fulfillment: order.fulfillment), let scope, let api else { throw RuleError.invalid("permission_denied") }
        let _: EmptyResponse = try await api.post("o/\(scope.orgId)/orders/\(order.id)/transition", body: Transition(to: next, version: order.version))
        try await openOrder(order.id); try await refresh()
    }
    func cancel(_ order: OrderDetail, reason: String) async throws {
        guard can("orders:cancel"), reachable, reason.trimmingCharacters(in: .whitespaces).count >= 2, let scope, let api else { throw RuleError.invalid("permission_denied") }
        let _: EmptyResponse = try await api.post("o/\(scope.orgId)/orders/\(order.id)/cancel", body: Cancellation(reason: reason, version: order.version))
        try await openOrder(order.id); try await refresh()
    }
    func tableAction(_ table: FloorTable, action: String) async throws {
        guard reachable, can("floor:seat"), let scope, let api else { throw RuleError.invalid("online_required") }
        let path: String; let body: [String: String]
        switch action {
        case "seat": path = "visits"; body = ["tableId": table.id]
        case "clean": path = "tables/\(table.id)/clean"; body = [:]
        case "close": guard let visit = table.visit else { return }; path = "visits/\(visit.id)/close"; body = [:]
        default: return
        }
        let _: EmptyResponse = try await api.post("o/\(scope.orgId)/\(path)", body: body)
        try await refresh()
    }
    func collect(_ order: OrderDetail, amount: Int64) async throws {
        guard reachable, can("payments:collect"), let scope, let api, amount > 0, amount <= order.dueMinor else { throw RuleError.invalid("online_required") }
        if let intent = financial {
            guard intent.kind == "cash", intent.orderId == order.id, intent.amountMinor == amount else { throw RuleError.invalid("payment_reconciliation_required") }
        } else {
            let intent = FinancialIntent(orderId: order.id, amountMinor: amount, key: UUID().uuidString, createdAt: Date(), kind: "cash", reason: nil)
            try financialStore!.write(JSONEncoder().encode(intent)); financial = intent
        }
        let intent = financial!
        guard Date().timeIntervalSince(intent.createdAt) < 6 * 86400 else { throw RuleError.invalid("payment_reconciliation_required") }
        // Manual cash only. No offline capture and no automatic financial replay.
        let _: CollectResult = try await api.post("o/\(scope.orgId)/orders/\(order.id)/collect", body: CashCollection(amountMinor: amount, method: "cash"), key: intent.key)
        try financialStore!.write(JSONEncoder().encode(Optional<FinancialIntent>.none)); financial = nil
        detail = nil // Never keep an actionable checkout with stale due after an acknowledged collection.
        try await openOrder(order.id); try await refresh()
    }
    func recoverFinancial() async throws {
        guard reachable, let intent = financial, let scope, let api, Date().timeIntervalSince(intent.createdAt) < 6 * 86400 else { throw RuleError.invalid("payment_reconciliation_required") }
        if intent.kind == "cash" {
            guard can("payments:collect") else { throw RuleError.invalid("permission_denied") }
            let _: CollectResult = try await api.post("o/\(scope.orgId)/orders/\(intent.orderId)/collect", body: CashCollection(amountMinor: intent.amountMinor, method: "cash"), key: intent.key)
        } else {
            guard can("payments:refund"), let reason = intent.reason else { throw RuleError.invalid("permission_denied") }
            let result: RefundResult = try await api.post("o/\(scope.orgId)/payments/\(intent.orderId)/refunds", body: RefundRequest(amountMinor: intent.amountMinor, reason: reason, key: intent.key))
            refundStatus = result.status
        }
        try financialStore!.write(JSONEncoder().encode(Optional<FinancialIntent>.none)); financial = nil
        try await refresh()
    }
    func refund(payment: OrderDetail.Payment, amount: Int64, reason: String, orderId: String) async throws {
        guard reachable, can("payments:refund"), let scope, let api, amount > 0, amount <= payment.amountMinor - payment.refundedMinor,
              reason.trimmingCharacters(in: .whitespaces).count >= 1, reason.count <= 300 else { throw RuleError.invalid("permission_denied") }
        if let intent = financial {
            guard intent.kind == "refund", intent.orderId == payment.id, intent.amountMinor == amount, intent.reason == reason else { throw RuleError.invalid("payment_reconciliation_required") }
        } else {
            let intent = FinancialIntent(orderId: payment.id, amountMinor: amount, key: UUID().uuidString, createdAt: Date(), kind: "refund", reason: reason)
            try financialStore!.write(JSONEncoder().encode(intent)); financial = intent
        }
        guard let intent = financial, Date().timeIntervalSince(intent.createdAt) < 6 * 86400 else { throw RuleError.invalid("payment_reconciliation_required") }
        let result: RefundResult = try await api.post("o/\(scope.orgId)/payments/\(payment.id)/refunds", body: RefundRequest(amountMinor: amount, reason: reason, key: intent.key))
        try financialStore!.write(JSONEncoder().encode(Optional<FinancialIntent>.none)); financial = nil
        refundStatus = result.status // pending/manual_required/unknown are never presented as succeeded.
        try await openOrder(orderId)
    }
    func enqueueReceipt(_ order: OrderDetail, arabic: Bool) async throws {
        guard let prints else { return }
        _ = try await prints.enqueue(Receipt(order: order, restaurant: restaurant?.name ?? "Resuto", arabic: arabic)); printJobs = await prints.list()
    }
    func printJob(_ job: PrintJob, printer: any ReceiptPrinter, reprint: Bool) async throws {
        guard let prints else { return }
        do { try await prints.send(job.id, printer: printer, confirmReprint: reprint); printJobs = await prints.list() }
        catch { printJobs = await prints.list(); throw error }
    }
    func changeWorkspace() async throws {
        guard reachable else { throw RuleError.invalid("online_required") }
        persistDraft(); generation = UUID(); clearWorkspace(); membership = nil; restaurant = nil
        await api?.clearCache(); try await loadIdentity()
    }
    func signOut() async {
        generation = UUID(); try? await auth?.signOut(); await api?.clearCache(); me = nil; membership = nil; restaurant = nil; clearWorkspace()
    }
    private func clearWorkspace() {
        customerId = nil; customerName = nil; deliveryLine = ""; deliveryArea = ""; deliveryCity = ""; reservations = []
        branch = nil; menu = nil; layout = nil; live = nil; orders = []; historyOrders = []; nextCursor = nil; tickets = []; pending = []; cart = []; printJobs = []; detail = nil
        selectedTable = nil; notes = ""; promotion = ""; queue = nil; prints = nil; cache = nil; draft = nil; financialStore = nil; financial = nil; lastRefresh = nil; cacheDate = nil
    }
}
private struct DraftSnapshot: Codable { let scope: Scope; let order: StaffOrder; let id: UUID? }
struct FinancialIntent: Codable { let orderId: String; let amountMinor: Int64; let key: String; let createdAt: Date; let kind: String; let reason: String? }
private struct RefundRequest: Encodable, Sendable { let amountMinor: Int64; let reason: String; let key: String }
private struct RefundResult: Decodable, Sendable { let id: String; let status: String }
private struct Transition: Encodable, Sendable { let to: String; let version: Int }
private struct Cancellation: Encodable, Sendable { let reason: String; let version: Int }
private struct CashCollection: Encodable, Sendable { let amountMinor: Int64; let method: String }
