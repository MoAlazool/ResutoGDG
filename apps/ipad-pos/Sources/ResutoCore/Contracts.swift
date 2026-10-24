import Foundation

// Reviewed against packages/contracts at 1746b4f; ordersContractsVersion = 2.
public struct Membership: Codable, Identifiable, Equatable, Sendable {
    public var id: String { orgId }
    public let orgId: String
    public let orgSlug: String
    public let orgName: String
    public let role: String
    public let branchIds: [String]?
    public func allows(branch: String) -> Bool { branchIds == nil || branchIds!.contains(branch) }
    public func can(_ permission: String) -> Bool { Permissions.can(role, permission) }
}
public struct Me: Codable, Sendable {
    public struct User: Codable, Sendable { public let id: String; public let email: String?; public let fullName: String?; public let locale: String }
    public let user: User
    public let memberships: [Membership]
}
public struct Branch: Codable, Identifiable, Sendable {
    public let id: String; public let name: String; public let nameAr: String?; public let isActive: Bool
    public let acceptsDineIn: Bool; public let acceptsPickup: Bool; public let acceptsDelivery: Bool
}
public struct Restaurant: Codable, Sendable {
    public let id: String; public let name: String; public let currency: String; public let timezone: String; public let branches: [Branch]
}
public struct CatalogueMenu: Codable, Identifiable, Sendable {
    public let id: String; public let branchId: String?; public let isActive: Bool
}
public struct Menu: Codable, Sendable {
    public let menus: [CatalogueMenu]
    public func categories(branch: String) -> [Category] {
        let ids = Set(menus.filter { $0.isActive && ($0.branchId == nil || $0.branchId == branch) }.map(\.id))
        return categories.filter { $0.isActive && ids.contains($0.menuId) }
    }
    public func products(branch: String) -> [Product] {
        let ids = Set(categories(branch: branch).map(\.id))
        return products.filter { $0.isActive && ids.contains($0.categoryId) }
    }
    public let categories: [Category]; public let products: [Product]; public let modifierGroups: [ModifierGroup]; public let currency: String
}
public struct Category: Codable, Identifiable, Sendable {
    public let menuId: String
    public let id: String; public let name: String; public let nameAr: String?; public let isActive: Bool
}
public struct Product: Codable, Identifiable, Sendable {
    public let id: String; public let categoryId: String; public let name: String; public let nameAr: String?
    public let description: String?; public let descriptionAr: String?; public let priceMinor: Int64; public let currency: String
    public let imageUrl: String?; public let isActive: Bool; public let trackStock: Bool; public let version: Int
    public let branchSettings: [BranchSetting]; public let modifierGroupIds: [String]; public let allergens: [String]
    public func price(branch: String) -> Int64 { branchSettings.first { $0.branchId == branch }?.priceOverrideMinor ?? priceMinor }
    public func available(branch: String) -> Bool {
        guard isActive else { return false }
        guard let setting = branchSettings.first(where: { $0.branchId == branch }) else { return true }
        return setting.isAvailable && setting.soldOut != true && (!trackStock || (setting.stockQty ?? 1) > 0)
    }
}
public struct BranchSetting: Codable, Sendable {
    public let branchId: String; public let isAvailable: Bool; public let priceOverrideMinor: Int64?; public let stockQty: Double?; public let soldOut: Bool?
}
public struct ModifierGroup: Codable, Identifiable, Sendable {
    public let id: String; public let name: String; public let nameAr: String?; public let minSelect: Int; public let maxSelect: Int; public let isActive: Bool
    public let options: [ModifierOption]
}
public struct ModifierOption: Codable, Identifiable, Sendable {
    public let id: String; public let groupId: String; public let name: String; public let nameAr: String?; public let priceDeltaMinor: Int64
    public let isDefault: Bool; public let isAvailable: Bool
}
public struct ModifierSelection: Codable, Hashable, Sendable {
    public let groupId: String; public let optionId: String
    public init(groupId: String, optionId: String) { self.groupId = groupId; self.optionId = optionId }
}
public struct CartLine: Codable, Equatable, Sendable {
    public let productId: String; public var quantity: Int; public let modifiers: [ModifierSelection]; public let notes: String?
    public init(productId: String, quantity: Int, modifiers: [ModifierSelection] = [], notes: String? = nil) {
        self.productId = productId; self.quantity = quantity; self.modifiers = modifiers; self.notes = notes
    }
}
public struct StaffOrder: Codable, Equatable, Sendable {
    public let branchId: String; public let fulfillment: String; public let tableId: String?; public let visitId: String?
    public let lines: [CartLine]; public let notes: String?; public let promotionCode: String?; public let channel: String
    public let customerId: String?; public let deliveryAddress: DeliveryAddress?
    public init(branchId: String, fulfillment: String, tableId: String? = nil, visitId: String? = nil, lines: [CartLine], notes: String? = nil, promotionCode: String? = nil, customerId: String? = nil, deliveryAddress: DeliveryAddress? = nil) {
        self.branchId = branchId; self.fulfillment = fulfillment; self.tableId = tableId; self.visitId = visitId
        self.lines = lines; self.notes = notes; self.promotionCode = promotionCode; self.channel = "staff"
        self.customerId = customerId; self.deliveryAddress = deliveryAddress
    }
}
public struct OrderAccepted: Codable, Sendable {
    public let id: String; public let number: String; public let status: String; public let totalMinor: Int64; public let currency: String
}
public struct Page<T: Codable & Sendable>: Codable, Sendable { public let items: [T]; public let nextCursor: String? }
public struct OrderSummary: Codable, Identifiable, Sendable {
    public let id: String; public let number: String; public let branchId: String; public let fulfillment: String; public let status: String
    public let paymentStatus: String; public let tableLabel: String?; public let visitId: String?; public let currency: String
    public let totalMinor: Int64; public let paidMinor: Int64; public let refundedMinor: Int64; public let dueMinor: Int64; public let placedAt: String; public let version: Int
}
public struct OrderDetail: Codable, Identifiable, Sendable {
    public let id: String; public let number: String; public let branchId: String; public let status: String; public let fulfillment: String
    public let paymentStatus: String; public let currency: String; public let totalMinor: Int64; public let dueMinor: Int64
    public let subtotalMinor: Int64; public let discountMinor: Int64; public let serviceChargeMinor: Int64; public let taxMinor: Int64
    public let deliveryFeeMinor: Int64; public let taxInclusive: Bool; public let version: Int; public let lines: [OrderLine]; public let payments: [Payment]
    public struct Payment: Codable, Identifiable, Sendable {
        public let id: String; public let method: String; public let status: String; public let amountMinor: Int64; public let refundedMinor: Int64; public let isTest: Bool
    }
}
public struct OrderLine: Codable, Identifiable, Sendable {
    public let id: String; public let name: String; public let nameAr: String?; public let quantity: Int; public let lineTotalMinor: Int64
    public let kitchenStatus: String; public let notes: String?
}
public struct FloorLayout: Codable, Sendable {
    public let branchId: String; public let revision: Int; public let width: Double; public let height: Double; public let tables: [FloorTable]
    public let zones: [FloorElement]; public let objects: [FloorElement]; public let background: FloorBackground
}
public struct LiveFloor: Codable, Sendable { public let revision: Int; public let tables: [FloorTable] }
public struct FloorTable: Codable, Identifiable, Sendable {
    public let id: String; public let label: String; public let capacity: Int; public let zone: String?; public let shape: String
    public let cx: Double; public let cy: Double; public let width: Double; public let height: Double; public let rotation: Double
    public let status: String; public let version: Int; public let visit: Visit?; public let nextReservation: Reservation?
    public struct Visit: Codable, Sendable { public let id: String; public let dueMinor: Int64; public let orderCount: Int; public let billingLocked: Bool? }
    public struct Reservation: Codable, Sendable { public let id: String; public let startsAt: String; public let guestName: String; public let partySize: Int }
}
public struct KitchenFeed: Codable, Sendable {
    public let cursor: String; public let unchanged: Bool?; public let tickets: [KitchenTicket]?; public let stations: [String]?
}
public struct KitchenTicket: Codable, Identifiable, Sendable {
    public let id: String; public let number: String; public let status: String; public let fulfillment: String; public let tableLabel: String?
    public let ageSeconds: Int; public let version: Int; public let notes: String?; public let lines: [Line]
    public struct Line: Codable, Identifiable, Sendable { public let id: String; public let name: String; public let nameAr: String?; public let quantity: Int; public let kitchenStatus: String; public let notes: String?; public let modifiers: [String] }
}
public struct EmptyResponse: Codable, Sendable {}
public struct CollectResult: Codable, Sendable { public let paymentId: String; public let amountMinor: Int64; public let paymentStatus: String; public let dueMinor: Int64 }
public struct APIErrorEnvelope: Decodable, Sendable { public let error: APIErrorBody }
public struct APIErrorBody: Decodable, Sendable { public let code: String; public let message: String; public let requestId: String? }
public struct APIError: Error, LocalizedError, Sendable {
    public let status: Int; public let code: String; public let message: String; public let requestId: String?; public let retryAfter: TimeInterval?
    public init(status: Int, code: String, message: String, requestId: String? = nil, retryAfter: TimeInterval? = nil) {
        self.status = status; self.code = code; self.message = message; self.requestId = requestId; self.retryAfter = retryAfter
    }
    public var errorDescription: String? { message + (requestId.map { " [\($0)]" } ?? "") }
}

public struct DeliveryAddress: Codable, Equatable, Sendable {
    public let line1: String; public let area: String?; public let city: String?
    public init(line1: String, area: String? = nil, city: String? = nil) { self.line1 = line1; self.area = area; self.city = city }
}
public struct Customer: Codable, Identifiable, Sendable {
    public let id: String; public let displayName: String?; public let phone: String?; public let email: String?
}
public struct ReservationDay: Codable, Sendable { public let date: String; public let items: [ReservationRecord] }
public struct ReservationRecord: Codable, Identifiable, Sendable {
    public let id: String; public let code: String; public let branchId: String; public let tableId: String?; public let tableLabel: String?
    public let status: String; public let guestName: String; public let partySize: Int; public let startsAt: String; public let endsAt: String
    public let depositMinor: Int64; public let depositStatus: String; public let currency: String
}

public struct FloorElement: Codable, Identifiable, Sendable {
    public let id: String; public let type: String; public let label: String; public let x: Double; public let y: Double
    public let width: Double; public let height: Double; public let rotation: Double; public let color: String?; public let hidden: Bool?
}
public struct FloorBackground: Codable, Sendable {
    public let image: String?; public let opacity: Double; public let x: Double; public let y: Double; public let width: Double; public let height: Double
}
