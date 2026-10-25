import Foundation

/// Read-only migration stage 1. These are disposable projections of the same Resuto backend, never a local ledger.
public actor POSShadowSync {
    public struct Snapshot: Codable, Sendable {
        public let scope: Scope; public let deviceId: String
        public var menuRefreshedAt: Date?
        public var menu: POSMenuSync?; public var floor: POSFloorSync?; public var orders: [POSOrder] = []
        public var ordersCursor: String?; public var ordersTruncated = false
    }
    private let client: POSClient; private let membership: Membership; private let deviceId: String
    private let journal: POSEventJournal; private let storage: any DataStore
    private var snapshot: Snapshot; private var running = false
    public init(client: POSClient, membership: Membership, deviceId: String, journal: POSEventJournal, storage: any DataStore) throws {
        self.client = client; self.membership = membership; self.deviceId = deviceId; self.journal = journal; self.storage = storage
        if let data = try storage.read() {
            snapshot = try JSONDecoder().decode(Snapshot.self,from:data)
            guard snapshot.scope == client.scope, snapshot.deviceId == deviceId else { throw RuleError.invalid("pos_context_mismatch") }
        } else { snapshot = Snapshot(scope:client.scope,deviceId:deviceId) }
    }
    public func current() -> Snapshot { snapshot }
    /// The app owns foreground lifetime and retry pacing; this method never submits orders/payments or prints.
    public func poll(wait: Int = 25) async throws {
        guard !running, (0...25).contains(wait) else { throw RuleError.invalid("invalid_operation") }
        running = true; defer { running = false }
        let session = try await client.session(membership:membership)
        guard session.device.id == deviceId, session.can("orders:read",membership:membership) else { throw RuleError.invalid("pos_context_mismatch") }
        if await journal.position() == nil || snapshot.ordersCursor == nil ||
            (session.can("menu:read",membership:membership) && snapshot.menu == nil) ||
            (session.can("floor:read",membership:membership) && snapshot.floor == nil) { try await reset(position:session.feed,session:session) }
        if session.can("menu:read",membership:membership), snapshot.menu != nil,
           snapshot.menuRefreshedAt.map({ Date().timeIntervalSince($0) < 0 || Date().timeIntervalSince($0) >= 1800 }) ?? true {
            // Signed image URLs expire even if no menu event occurs. Revalidate the windowed cursor periodically.
            try await refresh([.menu],session:session,full:false)
        }
        guard let position = await journal.position() else { throw RuleError.invalid("resync_required") }
        do {
            let page: POSEventPage = try await client.get("events",query:["after":String(position.lastSeq),"epoch":position.epoch,"wait":String(wait)])
            do { try await journal.apply(page) { [self] values in try await refresh(values,session:session,full:false) } }
            catch let error as RuleError where error == .invalid("resync_required") {
                // Never skip to a suspicious page's head. Obtain a fresh authorized watermark first.
                let fresh = try await client.session(membership:membership); try await reset(position:fresh.feed,session:fresh)
            }
        } catch let error as APIError where error.status == 409 && error.code == "resync_required" {
            let fresh = try await client.session(membership:membership); try await reset(position:fresh.feed,session:fresh)
        }
    }
    private func reset(position: POSFeedPosition, session: POSSession) async throws {
        guard session.device.id == deviceId else { throw RuleError.invalid("pos_context_mismatch") }
        try await journal.resync(from:position) { [self] values in try await refresh(values,session:session,full:true) }
    }
    private func refresh(_ values: Set<POSProjection>, session: POSSession, full: Bool) async throws {
        var updated = snapshot
        if full { updated.menu = nil; updated.floor = nil; updated.orders = []; updated.ordersCursor = nil; updated.ordersTruncated = false }
        if values.contains(.menu), session.can("menu:read",membership:membership) {
            let response: POSMenuSync = try await client.get("sync/menu",query:updated.menu.map { ["since":$0.cursor] } ?? [:])
            if !response.unchanged {
                guard response.categories != nil, response.currency != nil else { throw RuleError.invalid("invalid_response") }; updated.menu = response
            } else if updated.menu == nil { throw RuleError.invalid("resync_required") }
            updated.menuRefreshedAt = Date()
        }
        if values.contains(.floor), session.can("floor:read",membership:membership) {
            let response: POSFloorSync = try await client.get("sync/floor",query:updated.floor.map { ["since":$0.cursor] } ?? [:])
            if !response.unchanged {
                guard response.layout != nil, response.tables != nil else { throw RuleError.invalid("invalid_response") }; updated.floor = response
            } else if updated.floor == nil { throw RuleError.invalid("resync_required") }
        }
        if values.contains(.orders), session.can("orders:read",membership:membership) {
            var more = true; var pages = 0
            while more {
                try Task.checkCancellation(); pages += 1
                guard pages <= 100 else { throw RuleError.invalid("resync_required") }
                let response: POSOrdersSync = try await client.get("sync/orders",query:updated.ordersCursor.map { ["cursor":$0] } ?? [:])
                guard ["full","delta"].contains(response.mode), response.orders.allSatisfy({ $0.branchId == client.scope.branchId }),
                      !response.hasMore || response.cursor != updated.ordersCursor else { throw RuleError.invalid("resync_required") }
                if response.mode == "full" { updated.orders = []; updated.ordersTruncated = response.truncated == true }
                var index = Dictionary(updated.orders.map { ($0.id,$0) },uniquingKeysWith:{ _,latest in latest })
                for order in response.orders {
                    if let current = index[order.id], current.version > order.version { continue }
                    if order.open { index[order.id] = order } else { index.removeValue(forKey:order.id) }
                }
                updated.orders = index.values.sorted { $0.id < $1.id }; updated.ordersCursor = response.cursor; more = response.hasMore
            }
        }
        // Stage 1 shadows menu/floor/orders only. Existing staff KDS and local print queues keep their own reads.
        try storage.write(JSONEncoder().encode(updated)); snapshot = updated
    }
}
