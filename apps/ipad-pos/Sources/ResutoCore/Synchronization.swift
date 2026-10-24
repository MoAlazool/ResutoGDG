import Foundation

public struct Scope: Codable, Equatable, Sendable {
    public let environment: String; public let userId: String; public let orgId: String; public let branchId: String
    public init(environment: String, userId: String, orgId: String, branchId: String) { self.environment = environment; self.userId = userId; self.orgId = orgId; self.branchId = branchId }
}
public enum SyncState: String, Codable, Sendable {
    case local, queued, submitting, accepted, attention
}
public struct PendingOrder: Codable, Identifiable, Sendable {
    public let id: UUID; public let scope: Scope; public let payload: StaffOrder; public let createdAt: Date
    public var state: SyncState; public var firstAttemptAt: Date?; public var attempts: Int; public var nextAttemptAt: Date
    public var serverOrderId: String?; public var serverNumber: String?; public var issue: String?
    public init(scope: Scope, payload: StaffOrder, now: Date = Date()) {
        id = UUID(); self.scope = scope; self.payload = payload; createdAt = now; state = .local; attempts = 0; nextAttemptAt = now
    }
}
public protocol DataStore: Sendable {
    func read() throws -> Data?
    func write(_ data: Data) throws
}
public protocol OrderSubmitting: Sendable {
    func submit(_ operation: PendingOrder) async throws -> OrderAccepted
}
public struct RemoteOrderSubmitter: OrderSubmitting {
    public let api: APIClient
    public init(api: APIClient) { self.api = api }
    public func submit(_ operation: PendingOrder) async throws -> OrderAccepted {
        try await api.post("o/\(operation.scope.orgId)/orders", body: operation.payload, key: operation.id.uuidString)
    }
}
public actor OrderQueue {
    private let storage: any DataStore; private let submitter: any OrderSubmitting
    private var operations: [PendingOrder]; private var running = false
    public init(storage: any DataStore, submitter: any OrderSubmitting) throws {
        self.storage = storage; self.submitter = submitter
        operations = try storage.read().map { try JSONDecoder().decode([PendingOrder].self, from: $0) } ?? []
        // An interrupted request may have committed. Preserve identity and immutable payload for reconciliation.
        for index in operations.indices where operations[index].state == .submitting { operations[index].state = .queued }
    }
    public func list(scope: Scope) -> [PendingOrder] { operations.filter { $0.scope == scope }.sorted { $0.createdAt > $1.createdAt } }
    public func save(scope: Scope, payload: StaffOrder, now: Date = Date()) throws -> UUID {
        guard payload.branchId == scope.branchId else { throw RuleError.invalid("branch_mismatch") }
        let operation = PendingOrder(scope: scope, payload: payload, now: now)
        var copy = operations; copy.append(operation); try persist(copy); return operation.id
    }
    public func approve(_ id: UUID, scope: Scope, menu: Menu, now: Date = Date()) throws {
        guard let index = operations.firstIndex(where: { $0.id == id && $0.scope == scope }), operations[index].state == .local else { throw RuleError.invalid("invalid_operation") }
        // Operator must review a freshly fetched menu before approving. Financial amounts are never queued.
        _ = try CartRules.estimate(operations[index].payload, menu: menu)
        var copy = operations; copy[index].state = .queued; copy[index].nextAttemptAt = now; try persist(copy)
    }
    public func retry(_ id: UUID, scope: Scope, now: Date = Date()) throws {
        guard let index = operations.firstIndex(where: { $0.id == id && $0.scope == scope }), operations[index].state == .queued else { throw RuleError.invalid("review_required") }
        var copy = operations; copy[index].nextAttemptAt = now; try persist(copy)
    }
    public func discardLocal(_ id: UUID, scope: Scope) throws {
        guard let op = operations.first(where: { $0.id == id && $0.scope == scope }), op.firstAttemptAt == nil, op.state == .local else { throw RuleError.invalid("reconciliation_required") }
        try persist(operations.filter { $0.id != id })
    }
    public func drain(scope: Scope, authorized: Bool, now: Date = Date()) async throws {
        guard authorized, !running else { return }; running = true; defer { running = false }
        let ids = operations.filter { $0.scope == scope && $0.state == .queued && $0.nextAttemptAt <= now }.map(\.id)
        for id in ids {
            try Task.checkCancellation()
            guard let index = operations.firstIndex(where: { $0.id == id }) else { continue }
            var operation = operations[index]
            if now.timeIntervalSince(operation.firstAttemptAt ?? operation.createdAt) > 6 * 24 * 3600 {
                operation.state = .attention; operation.issue = "retry_window_expired"; try replace(operation); continue
            }
            operation.firstAttemptAt = operation.firstAttemptAt ?? now
            operation.attempts += 1; operation.state = .submitting
            try replace(operation) // Durable before network: crash cannot lose the key.
            do {
                let accepted = try await submitter.submit(operation)
                operation.serverOrderId = accepted.id; operation.serverNumber = accepted.number
                operation.state = .accepted; operation.issue = nil; try replace(operation)
            } catch {
                let api = error as? APIError
                let transient = api == nil || api!.status == 429 || api!.status >= 500
                operation.state = transient ? .queued : .attention
                operation.issue = api?.code ?? "connection_interrupted"
                let backoff = min(300, pow(2, Double(min(operation.attempts, 8))))
                operation.nextAttemptAt = now.addingTimeInterval(max(backoff + Double.random(in: 0...1), api?.retryAfter ?? 0))
                try replace(operation)
                if api?.status == 401 || api?.status == 403 || transient { break }
            }
        }
    }
    private func replace(_ operation: PendingOrder) throws {
        var copy = operations
        guard let index = copy.firstIndex(where: { $0.id == operation.id }) else { throw RuleError.invalid("missing_operation") }
        copy[index] = operation; try persist(copy)
    }
    private func persist(_ value: [PendingOrder]) throws { try storage.write(JSONEncoder().encode(value)); operations = value }
}

public struct CachedWorkspace: Codable, Sendable {
    public let scope: Scope; public let savedAt: Date; public let menu: Menu?; public let floor: FloorLayout?
    public init(scope: Scope, savedAt: Date = Date(), menu: Menu?, floor: FloorLayout?) { self.scope = scope; self.savedAt = savedAt; self.menu = menu; self.floor = floor }
}
