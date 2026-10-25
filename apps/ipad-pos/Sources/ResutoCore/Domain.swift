import Foundation

public enum RuleError: Error, LocalizedError, Equatable {
    case invalid(String)
    public var errorDescription: String? { if case .invalid(let text) = self { return text }; return nil }
}
public enum CartRules {
    // Presentation estimate only: server computes tax, promotions, stock, service and authoritative total.
    public static func estimate(_ order: StaffOrder, menu: Menu) throws -> Int64 {
        guard (1...60).contains(order.lines.count), ["pickup", "dine_in", "delivery"].contains(order.fulfillment),
              order.fulfillment != "dine_in" || order.tableId != nil || order.visitId != nil,
              (order.notes?.utf16.count ?? 0) <= 500, (order.promotionCode?.utf16.count ?? 0) <= 40 else { throw RuleError.invalid("invalid_order") }
        if order.fulfillment == "delivery" {
            guard let address = order.deliveryAddress, (3...300).contains(address.line1.trimmingCharacters(in: .whitespaces).utf16.count), (address.area?.utf16.count ?? 0) <= 120, (address.city?.utf16.count ?? 0) <= 80 else { throw RuleError.invalid("delivery_address_required") }
        }
        // Build indexes once per estimate, rather than filtering the complete menu for every cart line.
        let products = Dictionary(menu.products(branch: order.branchId).map { ($0.id, $0) }, uniquingKeysWith: { _, latest in latest })
        let activeGroups = Dictionary(menu.modifierGroups.filter(\.isActive).map { ($0.id, $0) }, uniquingKeysWith: { _, latest in latest })
        var total: Int64 = 0
        for line in order.lines {
            guard (1...99).contains(line.quantity), line.modifiers.count <= 40, Set(line.modifiers).count == line.modifiers.count,
                  (line.notes?.utf16.count ?? 0) <= 200,
                  let product = products[line.productId], product.available(branch: order.branchId) else { throw RuleError.invalid("item_unavailable") }
            var price = product.price(branch: order.branchId)
            let groups = product.modifierGroupIds.compactMap { activeGroups[$0] }
            for selection in line.modifiers {
                guard let group = groups.first(where: { $0.id == selection.groupId }),
                      let option = group.options.first(where: { $0.id == selection.optionId && $0.isAvailable }) else { throw RuleError.invalid("modifier_unavailable") }
                let addition = price.addingReportingOverflow(option.priceDeltaMinor)
                guard !addition.overflow else { throw RuleError.invalid("invalid_price") }
                price = addition.partialValue
            }
            for group in groups {
                let count = line.modifiers.filter { $0.groupId == group.id }.count
                guard count >= group.minSelect && count <= group.maxSelect else { throw RuleError.invalid("modifier_selection") }
            }
            guard price >= 0, price <= 10_000_000_000_000 else { throw RuleError.invalid("invalid_price") }
            let lineTotal = price.multipliedReportingOverflow(by: Int64(line.quantity))
            let sum = total.addingReportingOverflow(lineTotal.partialValue)
            guard !lineTotal.overflow, !sum.overflow, sum.partialValue <= 9_007_199_254_740_991 else { throw RuleError.invalid("invalid_price") }
            total = sum.partialValue
        }
        return total
    }
}
public enum Money {
    public static func text(_ minor: Int64, currency: String) -> String {
        // Currency code kept separate from Western digits; no floating point arithmetic.
        let magnitude = minor.magnitude
        return "\(minor < 0 ? "-" : "")\(magnitude / 100).\(String(format: "%02llu", magnitude % 100)) \(currency)"
    }
    public static func parse(_ value: String) -> Int64? {
        let normalized = western(value).trimmingCharacters(in: .whitespaces)
        guard normalized.range(of: "^[0-9]{1,11}(\\.[0-9]{1,2})?$", options: .regularExpression) != nil else { return nil }
        let parts = normalized.split(separator: ".")
        guard let whole = Int64(parts[0]) else { return nil }
        let cents = parts.count == 2 ? Int64((String(parts[1]) + "00").prefix(2))! : 0
        return whole * 100 + cents
    }
    public static func western(_ value: String) -> String {
        String(value.map { character in
            if let n = character.wholeNumberValue, n < 10 { return Character(String(n)) }; return character
        })
    }
    public static func split(_ amount: Int64, people: Int) throws -> [Int64] {
        guard (2...20).contains(people), amount >= people else { throw RuleError.invalid("invalid_split") }
        return (0..<people).map { amount / Int64(people) + (Int64($0) < amount % Int64(people) ? 1 : 0) }
    }
}
public enum OrderLifecycle {
    public static func next(_ status: String, fulfillment: String) -> String? {
        switch status {
        case "placed": return "accepted"
        case "accepted": return "preparing"
        case "preparing": return "ready"
        case "ready": return ["dine_in": "served", "pickup": "picked_up", "delivery": "delivered"][fulfillment]
        default: return nil
        }
    }
}

public enum ServerDate {
    public static func parse(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }
}

public enum BusinessDate {
    public static func timezone(branch: String?, restaurant: String?) -> TimeZone {
        branch.flatMap(TimeZone.init(identifier:)) ?? restaurant.flatMap(TimeZone.init(identifier:)) ?? .gmt
    }
    public static func day(_ date: Date, branch: String?, restaurant: String?) -> String {
        let formatter = DateFormatter(); formatter.locale = Locale(identifier:"en_US_POSIX")
        formatter.calendar = Calendar(identifier:.gregorian); formatter.timeZone = timezone(branch:branch,restaurant:restaurant)
        formatter.dateFormat = "yyyy-MM-dd"; return formatter.string(from:date)
    }
}
