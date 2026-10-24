import Foundation
public struct Receipt: Codable, Sendable {
    public let orderId: String; public let number: String; public let restaurant: String; public let currency: String
    public let lines: [String]; public let subtotal: Int64; public let discount: Int64; public let tax: Int64; public let service: Int64; public let delivery: Int64
    public let total: Int64; public let due: Int64; public let paymentStatus: String; public let isTest: Bool
    public init(order: OrderDetail, restaurant: String, arabic: Bool) {
        orderId = order.id; number = order.number; self.restaurant = restaurant; currency = order.currency
        lines = order.lines.map { "\($0.quantity) × \(arabic ? ($0.nameAr ?? $0.name) : $0.name) — \(Money.text($0.lineTotalMinor, currency: order.currency))" }
        subtotal = order.subtotalMinor; discount = order.discountMinor; tax = order.taxMinor; service = order.serviceChargeMinor; delivery = order.deliveryFeeMinor
        total = order.totalMinor; due = order.dueMinor; paymentStatus = order.paymentStatus; isTest = order.payments.contains { $0.isTest }
    }
}
public enum PrintState: String, Codable, Sendable { case waiting, sending, handedToPrinter, uncertain, failed }
public struct PrintJob: Codable, Identifiable, Sendable {
    public let id: UUID; public let receipt: Receipt; public var state: PrintState; public var issue: String?
    public init(receipt: Receipt) { id = UUID(); self.receipt = receipt; state = .waiting }
}
public protocol ReceiptPrinter: Sendable { func printReceipt(_ receipt: Receipt) async throws }
public actor PrintQueue {
    private let storage: any DataStore
    private var jobs: [PrintJob]
    public init(storage: any DataStore) throws {
        self.storage = storage; jobs = try storage.read().map { try JSONDecoder().decode([PrintJob].self, from: $0) } ?? []
        for index in jobs.indices where jobs[index].state == .sending { jobs[index].state = .uncertain }
    }
    public func list() -> [PrintJob] { jobs }
    public func enqueue(_ receipt: Receipt) throws -> UUID {
        let job = PrintJob(receipt: receipt); var copy = jobs; copy.append(job); try persist(copy); return job.id
    }
    // Physical exactly-once printing cannot be guaranteed. Uncertain jobs require staff confirmation to reprint.
    public func send(_ id: UUID, printer: any ReceiptPrinter, confirmReprint: Bool = false) async throws {
        guard let index = jobs.firstIndex(where: { $0.id == id }), jobs[index].state != .sending else { return }
        guard jobs[index].state == .waiting || confirmReprint else { throw RuleError.invalid("confirm_reprint") }
        var copy = jobs; copy[index].state = .sending; try persist(copy)
        do { try await printer.printReceipt(jobs[index].receipt); copy = jobs; copy[index].state = .handedToPrinter; copy[index].issue = nil; try persist(copy) }
        catch { copy = jobs; copy[index].state = .uncertain; copy[index].issue = "check_printer_before_retry"; try persist(copy); throw error }
    }
    private func persist(_ value: [PrintJob]) throws { try storage.write(JSONEncoder().encode(value)); jobs = value }
}
