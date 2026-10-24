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
              (order.notes?.count ?? 0) <= 500, (order.promotionCode?.count ?? 0) <= 40 else { throw RuleError.invalid("invalid_order") }
        if order.fulfillment == "delivery" {
            guard let address = order.deliveryAddress, (3...300).contains(address.line1.trimmingCharacters(in: .whitespaces).count), (address.area?.count ?? 0) <= 120, (address.city?.count ?? 0) <= 80 else { throw RuleError.invalid("delivery_address_required") }
        }
        var total: Int64 = 0
        for line in order.lines {
            guard (1...99).contains(line.quantity), line.modifiers.count <= 40, Set(line.modifiers).count == line.modifiers.count,
                  (line.notes?.count ?? 0) <= 200,
                  let product = menu.products(branch: order.branchId).first(where: { $0.id == line.productId }), product.available(branch: order.branchId) else { throw RuleError.invalid("item_unavailable") }
            var price = product.price(branch: order.branchId)
            let groups = menu.modifierGroups.filter { product.modifierGroupIds.contains($0.id) && $0.isActive }
            for selection in line.modifiers {
                guard let group = groups.first(where: { $0.id == selection.groupId }),
                      let option = group.options.first(where: { $0.id == selection.optionId && $0.isAvailable }) else { throw RuleError.invalid("modifier_unavailable") }
                price += option.priceDeltaMinor
            }
            for group in groups {
                let count = line.modifiers.filter { $0.groupId == group.id }.count
                guard count >= group.minSelect && count <= group.maxSelect else { throw RuleError.invalid("modifier_selection") }
            }
            guard price >= 0, price <= 10_000_000_000_000 else { throw RuleError.invalid("invalid_price") }
            total += price * Int64(line.quantity)
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
