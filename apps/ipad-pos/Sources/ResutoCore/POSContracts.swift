import Foundation

// Reviewed draft: Claude 69ec75e, pos.ts / IPAD_INTEGRATION.md contract 0.2.0.
// Production routing is unchanged until 0.2.0 is merged, deployed and shadow-verified.
public enum JSONValue: Codable, Equatable, Sendable {
    case object([String: JSONValue]), array([JSONValue]), string(String), integer(Int64), number(Double), bool(Bool), null
    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Int64.self) { self = .integer(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode([String: JSONValue].self) { self = .object(v) }
        else { self = .array(try c.decode([JSONValue].self)) }
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .object(let v): try c.encode(v); case .array(let v): try c.encode(v); case .string(let v): try c.encode(v)
        case .integer(let v): try c.encode(v); case .number(let v): try c.encode(v); case .bool(let v): try c.encode(v); case .null: try c.encodeNil()
        }
    }
    public func decode<T: Decodable>(_ type: T.Type) throws -> T { try JSONDecoder().decode(type, from: JSONEncoder().encode(self)) }
}
public struct POSDevice: Codable, Sendable {
    public let id: String; public let branchId: String; public let name: String; public let actingRole: String
    public let status: String; public let expired: Bool; public let requireStaff: Bool?
}
public struct POSPairResult: Codable, Sendable {
    public let token: String; public let device: POSDevice; public let orgId: String; public let contractVersion: String
}
public struct POSFeedPosition: Codable, Equatable, Sendable {
    public let epoch: String; public let head: Int64; public let oldest: Int64
    public init(epoch: String, head: Int64, oldest: Int64) { self.epoch = epoch; self.head = head; self.oldest = oldest }
}
public struct POSSession: Codable, Sendable {
    public struct Organization: Codable, Sendable { public let id: String; public let name: String; public let currency: String; public let timezone: String }
    public struct Branch: Codable, Sendable { public let id: String; public let name: String }
    public struct Staff: Codable, Sendable { public let id: String; public let email: String?; public let role: String }
    public let device: POSDevice; public let org: Organization; public let branch: Branch
    public let requireStaff: Bool
    public let staff: Staff?; public let permissions: [String]; public let feed: POSFeedPosition; public let contractVersion: String
    public func validate(scope: Scope, membership: Membership) throws {
        guard contractVersion == "0.2.0", requireStaff, device.requireStaff == true, let staff else { throw RuleError.invalid("pos_staff_contract_required") }
        guard org.id == scope.orgId, membership.orgId == org.id, branch.id == scope.branchId,
              device.branchId == branch.id, staff.id == scope.userId, staff.role == membership.role,
              membership.allows(branch: branch.id), device.status == "active", !device.expired,
              ["waiter","cashier","kitchen"].contains(device.actingRole) else { throw RuleError.invalid("pos_context_mismatch") }
    }
    /// UI hints only; backend guard remains authoritative. Staff-only routes retain staff permissions.
    public func can(_ permission: String, membership: Membership) -> Bool {
        membership.can(permission) && Permissions.can(device.actingRole, permission) && permissions.contains(permission)
    }
}
public struct POSEvent: Codable, Sendable {
    public let seq: Int64; public let kind: String; public let entityType: String; public let entityId: String; public let payload: [String: JSONValue]; public let at: String
}
public struct POSEventPage: Codable, Sendable {
    public let epoch: String; public let head: Int64; public let events: [POSEvent]; public let nextAfter: Int64; public let hasMore: Bool
}
public struct POSResyncDetails: Codable, Sendable { public let reason: String; public let epoch: String; public let head: Int64; public let oldest: Int64 }
public struct POSMenuProduct: Codable, Sendable {
    public struct Group: Codable, Sendable {
        public struct Option: Codable, Sendable { public let id: String; public let name: String; public let nameAr: String?; public let priceDeltaMinor: Int64; public let available: Bool }
        public let id: String; public let name: String; public let nameAr: String?; public let minSelect: Int; public let maxSelect: Int; public let options: [Option]
    }
    public let id: String; public let categoryId: String; public let name: String; public let nameAr: String?
    public let priceMinor: Int64; public let available: Bool; public let unavailableReason: String?; public let stockQty: Double?
    public let station: String; public let imageUrl: String?; public let modifierGroups: [Group]
}
public struct POSMenuSync: Codable, Sendable {
    public struct Category: Codable, Sendable { public let id: String; public let name: String; public let nameAr: String?; public let products: [POSMenuProduct] }
    public let cursor: String; public let unchanged: Bool; public let currency: String?; public let categories: [Category]?; public let stations: [String]?
}
public struct POSFloorSync: Codable, Sendable {
    public let cursor: String; public let unchanged: Bool; public let layout: JSONValue?; public let tables: [JSONValue]?
}
public struct POSQuote: Codable, Equatable, Sendable {
    public struct Line: Codable, Equatable, Sendable {
        public let index: Int; public let productId: String; public let unitPriceMinor: Int64; public let modifiersTotalMinor: Int64; public let lineTotalMinor: Int64
    }
    public let currency: String; public let lines: [Line]; public let subtotalMinor: Int64; public let discountMinor: Int64
    public let serviceChargeMinor: Int64; public let deliveryFeeMinor: Int64; public let taxMinor: Int64; public let taxInclusive: Bool; public let totalMinor: Int64; public let menuCursor: String
}
public struct POSOrder: Codable, Identifiable, Sendable {
    public struct Line: Codable, Identifiable, Sendable {
        public let id: String; public let productId: String?; public let name: String; public let nameAr: String?; public let quantity: Int
        public let unitPriceMinor: Int64; public let modifiers: [JSONValue]; public let modifiersTotalMinor: Int64; public let lineTotalMinor: Int64
        public let station: String; public let kitchenStatus: String; public let notes: String?
    }
    public let id: String; public let clientOrderId: String?; public let number: String; public let branchId: String; public let channel: String
    public let fulfillment: String; public let status: String; public let paymentStatus: String; public let tableId: String?; public let tableLabel: String?; public let visitId: String?
    public let currency: String; public let subtotalMinor: Int64; public let discountMinor: Int64; public let serviceChargeMinor: Int64; public let deliveryFeeMinor: Int64
    public let taxMinor: Int64; public let taxInclusive: Bool; public let totalMinor: Int64; public let paidMinor: Int64; public let refundedMinor: Int64; public let dueMinor: Int64
    public let version: Int; public let open: Bool; public let lines: [Line]
}
public struct POSOrdersSync: Codable, Sendable { public let cursor: String; public let mode: String; public let orders: [POSOrder]; public let hasMore: Bool; public let truncated: Bool? }
public struct POSOrderSubmitted: Codable, Sendable { public let clientOrderId: String; public let order: POSOrder; public let repriced: JSONValue? }
public struct POSReconciliation: Codable, Sendable { public let state: String; public let orderId: String?; public let number: String?; public let response: POSOrderSubmitted? }
public struct POSPriceConflict: Codable, Sendable {
    public struct Line: Codable, Sendable { public let index: Int; public let productId: String; public let expectedLineTotalMinor: Int64?; public let currentLineTotalMinor: Int64; public let currentUnitPriceMinor: Int64; public let currentModifiersTotalMinor: Int64 }
    public let currency: String; public let lines: [Line]; public let expectedTotalMinor: Int64?; public let currentTotalMinor: Int64; public let menuCursor: String
}
public struct POSUnavailable: Codable, Sendable {
    public struct Item: Codable, Sendable { public let index: Int; public let productId: String; public let reason: String; public let availableQty: Double? }
    public let items: [Item]; public let menuCursor: String
}
public struct POSPrintJob: Codable, Sendable {
    public let id: String; public let kind: String; public let status: String; public let orderId: String; public let station: String?
    public let claimedBy: String?; public let claimedAt: String?; public let attempts: Int; public let document: [String: JSONValue]?
}
