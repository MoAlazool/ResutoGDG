import Foundation

public struct POSSubmitBody: Codable, Sendable {
    public struct Line: Codable, Sendable {
        public let productId: String; public let quantity: Int; public let modifiers: [ModifierSelection]; public let notes: String?; public let expectedLineTotalMinor: Int64
    }
    public let clientOrderId: UUID; public let fulfillment: String; public let tableId: String?; public let visitId: String?
    public let lines: [Line]; public let expectedTotalMinor: Int64; public let repricing: String; public let notes: String?
    public init(id: UUID, order: StaffOrder, quote: POSQuote) throws {
        // Draft POS routes have no promotion/customer-ID/delivery-address input. Never silently discard these.
        guard ["pickup","dine_in"].contains(order.fulfillment), order.deliveryAddress == nil, order.customerId == nil,
              order.promotionCode?.isEmpty != false, quote.lines.count == order.lines.count, (1...60).contains(order.lines.count),
              (0...10_000_000_000_000).contains(quote.totalMinor), !quote.currency.isEmpty,
              order.fulfillment != "dine_in" || order.tableId != nil || order.visitId != nil else { throw RuleError.invalid("pos_order_not_supported") }
        var result: [Line] = []
        for (index,line) in order.lines.enumerated() {
            let price = quote.lines[index]
            guard price.index == index, price.productId == line.productId, (1...99).contains(line.quantity), line.modifiers.count <= 40,
                  Set(line.modifiers).count == line.modifiers.count, (line.notes?.utf16.count ?? 0) <= 200,
                  (0...10_000_000_000_000).contains(price.lineTotalMinor) else { throw RuleError.invalid("pos_quote_mismatch") }
            result.append(Line(productId:line.productId,quantity:line.quantity,modifiers:line.modifiers,notes:line.notes,expectedLineTotalMinor:price.lineTotalMinor))
        }
        guard (order.notes?.utf16.count ?? 0) <= 500 else { throw RuleError.invalid("invalid_order") }
        clientOrderId = id; fulfillment = order.fulfillment; tableId = order.tableId; visitId = order.visitId
        lines = result; expectedTotalMinor = quote.totalMinor; repricing = "reject"; notes = order.notes
    }
}
/// Selects the device route only for a never-sent draft explicitly approved with a server quote.
/// Legacy in-flight requests always retain their original staff endpoint/key/retention semantics.
public struct CompatibleOrderSubmitter: OrderSubmitting {
    private let legacy: any OrderSubmitting; private let pos: POSClient; private let membership: Membership
    public init(legacy: any OrderSubmitting, pos: POSClient, membership: Membership) { self.legacy = legacy; self.pos = pos; self.membership = membership }
    public func quote(_ order: StaffOrder) async throws -> POSQuote {
        let session = try await pos.session(membership:membership)
        guard session.can("orders:write",membership:membership), order.branchId == pos.scope.branchId else { throw RuleError.invalid("permission_denied") }
        struct Request: Encodable, Sendable { let fulfillment: String; let lines: [CartLine] }
        return try await pos.post("orders/quote",body:Request(fulfillment:order.fulfillment,lines:order.lines))
    }
    public func submit(_ operation: PendingOrder) async throws -> OrderAccepted {
        guard let quote = operation.posQuote else { return try await legacy.submit(operation) }
        guard operation.scope == pos.scope else { throw RuleError.invalid("pos_context_mismatch") }
        let session = try await pos.session(membership:membership)
        guard session.can("orders:write",membership:membership) else { throw APIError(status:403,code:"pos_staff_not_allowed",message:"permission_denied") }
        let body = try POSSubmitBody(id:operation.id,order:operation.payload,quote:quote)
        // Reconcile every subsequent attempt before resending. Permanent clientOrderId uniqueness is 0.2.0-only.
        if operation.attempts > 1, let accepted = try await reconcile(operation) { return accepted }
        do {
            let response: POSOrderSubmitted = try await pos.post("orders",body:body)
            return try accepted(response,operation:operation)
        } catch {
            let original = error
            if let api = error as? APIError, api.status < 500 { throw original }
            // A lost response may follow a commit. Lookup is read-only; no mutation is automatically retried here.
            if let found = try? await reconcile(operation) { return found }
            throw original
        }
    }
    private func reconcile(_ operation: PendingOrder) async throws -> OrderAccepted? {
        do {
            let result: POSReconciliation = try await pos.get("orders/by-client-id/" + operation.id.uuidString)
            switch result.state {
            case "accepted":
                guard let response = result.response, result.orderId == response.order.id, result.number == response.order.number else { throw RuleError.invalid("invalid_response") }
                return try accepted(response,operation:operation)
            case "processing": throw APIError(status:503,code:"pos_operation_processing",message:"reconciliation_required")
            default: throw RuleError.invalid("invalid_response")
            }
        } catch let error as APIError where error.status == 404 && error.code == "not_found" { return nil }
    }
    private func accepted(_ response: POSOrderSubmitted, operation: PendingOrder) throws -> OrderAccepted {
        guard response.clientOrderId.lowercased() == operation.id.uuidString.lowercased(), response.order.clientOrderId?.lowercased() == response.clientOrderId.lowercased(),
              response.order.branchId == operation.scope.branchId, response.order.totalMinor == operation.posQuote?.totalMinor, response.order.currency == operation.posQuote?.currency,
              response.repriced == nil else { throw RuleError.invalid("pos_response_mismatch") }
        return OrderAccepted(id:response.order.id,number:response.order.number,status:response.order.status,totalMinor:response.order.totalMinor,currency:response.order.currency)
    }
}
