import Foundation

/// In-memory permission lease renewed only by a successful scoped identity check.
/// Network reachability is not proof of authorization. Relaunch requires online revalidation.
public struct OperationalAccessLease: Sendable {
    private let scope: Scope
    private let verifiedAt: Date
    private let uptime: TimeInterval
    public init(scope: Scope, now: Date = Date(), uptime: TimeInterval = ProcessInfo.processInfo.systemUptime) {
        self.scope = scope; verifiedAt = now; self.uptime = uptime
    }
    public func allows(_ scope: Scope, now: Date = Date(), uptime: TimeInterval = ProcessInfo.processInfo.systemUptime) -> Bool {
        let wallElapsed = now.timeIntervalSince(verifiedAt), elapsed = uptime - self.uptime
        return scope == self.scope && (0..<(8 * 3600)).contains(wallElapsed) && (0..<(8 * 3600)).contains(elapsed)
    }
}
