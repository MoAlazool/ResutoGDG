import Foundation

public enum POSProjection: String, Hashable, Sendable, CaseIterable { case menu, floor, orders, kitchen, printJobs }
/// Invalidations never execute financial operations. Cursor advances only after refreshed projections are durable.
public actor POSEventJournal {
    private struct Record: Codable { let scope: Scope; let deviceId: String; let epoch: String; let lastSeq: Int64 }
    private let scope: Scope; private let deviceId: String; private let storage: any DataStore
    private var record: Record?; private var applying = false
    public init(scope: Scope, deviceId: String, storage: any DataStore) throws {
        self.scope = scope; self.deviceId = deviceId; self.storage = storage
        if let data = try storage.read() {
            let saved = try JSONDecoder().decode(Record.self,from:data)
            guard saved.scope == scope, saved.deviceId == deviceId else { throw RuleError.invalid("pos_context_mismatch") }
            record = saved
        }
    }
    public func position() -> (epoch: String, lastSeq: Int64)? { record.map { ($0.epoch,$0.lastSeq) } }
    public func resync(from position: POSFeedPosition, refresh: @Sendable (Set<POSProjection>) async throws -> Void) async throws {
        guard !applying, position.head >= 0, position.head <= 9_007_199_254_740_991 else { throw RuleError.invalid("resync_required") }
        applying = true; defer { applying = false }
        // Capture the feed watermark BEFORE snapshots: changes during refresh are replayed next time.
        try await refresh(Set(POSProjection.allCases))
        try persist(epoch:position.epoch,lastSeq:position.head)
    }
    public func apply(_ page: POSEventPage, refresh: @Sendable (Set<POSProjection>) async throws -> Void) async throws {
        guard !applying, let record, page.epoch == record.epoch, page.head >= record.lastSeq, page.head <= 9_007_199_254_740_991 else { throw RuleError.invalid("resync_required") }
        applying = true; defer { applying = false }
        var last = record.lastSeq; var previous: Int64?; var invalidations: Set<POSProjection> = []
        for event in page.events {
            guard event.seq >= 1, event.seq <= page.head, previous.map({ event.seq >= $0 }) ?? true else { throw RuleError.invalid("resync_required") }
            previous = event.seq
            if event.seq <= last { continue } // At-least-once duplicates, including unknown kinds.
            guard event.seq == last + 1 else { throw RuleError.invalid("resync_required") }
            last = event.seq
            switch event.kind {
            case "order.created","order.updated","payment.captured","payment.refunded": invalidations.formUnion([.orders,.kitchen,.floor])
            case "ticket.status_changed": invalidations.formUnion([.orders,.kitchen])
            case "menu.changed","availability.changed": invalidations.insert(.menu)
            case "table.changed": invalidations.insert(.floor)
            case "print_job.created": invalidations.insert(.printJobs)
            default: break
            }
        }
        guard page.nextAfter == last, page.nextAfter <= page.head, !page.hasMore || last < page.head,
              page.hasMore || last == page.head else { throw RuleError.invalid("resync_required") }
        if !invalidations.isEmpty { try await refresh(invalidations) }
        try persist(epoch:page.epoch,lastSeq:last)
    }
    private func persist(epoch: String,lastSeq: Int64) throws {
        let next = Record(scope:scope,deviceId:deviceId,epoch:epoch,lastSeq:lastSeq)
        try Task.checkCancellation()
        try storage.write(JSONEncoder().encode(next)); record = next
    }
}
