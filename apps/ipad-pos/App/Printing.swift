import UIKit
import SwiftUI
import Network

@MainActor enum ReceiptRenderer {
    static func image(_ receipt: Receipt, width: Int, arabic: Bool) -> UIImage {
        let money = { (amount: Int64) in Money.text(amount, currency: receipt.currency) }
        let l = Language(); l.arabic = arabic
        let rows = [arabic ? "ملخص الطلب" : "ORDER SUMMARY", receipt.restaurant, "#\(receipt.number)"] + receipt.lines + [
            "\(l.text("subtotal")): \(money(receipt.subtotal))", "\(l.text("discount")): \(money(receipt.discount))",
            "\(l.text("tax")): \(money(receipt.tax))", "\(l.text("service")): \(money(receipt.service))", "\(l.text("delivery")): \(money(receipt.delivery))",
            "\(l.text("total")): \(money(receipt.total))", "\(l.text("due")): \(money(receipt.due))", l.text(receipt.paymentStatus)
        ] + (receipt.isTest ? [l.text("test")] : [])
        let paragraph = NSMutableParagraphStyle(); paragraph.alignment = arabic ? .right : .left; paragraph.baseWritingDirection = arabic ? .rightToLeft : .leftToRight; paragraph.lineSpacing = 8
        let text = NSAttributedString(string: rows.joined(separator: "\n"), attributes: [.font: UIFont.systemFont(ofSize: 24, weight: .medium), .foregroundColor: UIColor.black, .paragraphStyle: paragraph])
        let contentWidth = CGFloat(width - 32)
        let bounds = text.boundingRect(with: CGSize(width: contentWidth, height: 20000), options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil)
        let format = UIGraphicsImageRendererFormat(); format.scale = 1; format.opaque = true
        return UIGraphicsImageRenderer(size: CGSize(width: CGFloat(width), height: ceil(bounds.height) + 48), format: format).image { context in
            UIColor.white.setFill(); context.fill(CGRect(x: 0, y: 0, width: CGFloat(width), height: ceil(bounds.height) + 48))
            text.draw(in: CGRect(x: 16, y: 24, width: contentWidth, height: bounds.height))
        }
    }
    static func escpos(_ image: UIImage) throws -> Data {
        guard let cg = image.cgImage else { throw RuleError.invalid("invalid_receipt") }
        let width = cg.width, height = cg.height, stride = (width + 7) / 8
        guard height < 65536 else { throw RuleError.invalid("receipt_too_long") }
        var pixels = [UInt8](repeating: 255, count: width * height)
        let rendered = pixels.withUnsafeMutableBytes { bytes -> Bool in
            guard let context = CGContext(data: bytes.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return false }
            context.draw(cg, in: CGRect(x: 0, y: 0, width: CGFloat(width), height: CGFloat(height))); return true
        }
        guard rendered else { throw RuleError.invalid("invalid_receipt") }
        var data = Data([0x1b, 0x40, 0x1d, 0x76, 0x30, 0, UInt8(stride & 255), UInt8(stride >> 8), UInt8(height & 255), UInt8(height >> 8)])
        var raster = [UInt8](repeating: 0, count: stride * height)
        for y in 0..<height { for x in 0..<width where pixels[y * width + x] < 160 { raster[y * stride + x / 8] |= UInt8(0x80 >> (x % 8)) } }
        data.append(contentsOf: raster); data.append(contentsOf: [10, 10, 10])
        // No cutter or cash-drawer command without a verified model-specific capability profile.
        return data
    }
}
struct AirPrintAdapter: ReceiptPrinter {
    let arabic: Bool
    func printReceipt(_ receipt: Receipt) async throws {
        try await present(receipt)
    }
    @MainActor private func present(_ receipt: Receipt) async throws {
        guard UIPrintInteractionController.isPrintingAvailable,
              let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first(where: { $0.activationState == .foregroundActive }),
              let view = scene.windows.first(where: \.isKeyWindow)?.rootViewController?.view else { throw RuleError.invalid("printer_unavailable") }
        let controller = UIPrintInteractionController.shared
        let info = UIPrintInfo(dictionary: nil); info.jobName = "Resuto #\(receipt.number)"; info.outputType = .general
        controller.printInfo = info; controller.printingItem = ReceiptRenderer.image(receipt, width: 576, arabic: arabic)
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            controller.present(from: CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1), in: view, animated: true) { _, completed, error in
                if let error { continuation.resume(throwing: error) }
                else if !completed { continuation.resume(throwing: CancellationError()) }
                else { continuation.resume() }
            }
        }
    }
}
struct NetworkRasterPrinter: ReceiptPrinter {
    let host: String; let width: Int; let arabic: Bool
    func printReceipt(_ receipt: Receipt) async throws {
        let parts = host.split(separator: ".").compactMap { Int($0) }
        let local = parts.count == 4 && (parts[0] == 10 || (parts[0] == 172 && (16...31).contains(parts[1])) || (parts[0] == 192 && parts[1] == 168) || (parts[0] == 169 && parts[1] == 254))
        guard local, IPv4Address(host) != nil, [384, 576].contains(width) else { throw RuleError.invalid("invalid_printer") }
        let data = try await MainActor.run { try ReceiptRenderer.escpos(ReceiptRenderer.image(receipt, width: width, arabic: arabic)) }
        let connection = NWConnection(host: NWEndpoint.Host(host), port: 9100, using: .tcp)
        let queue = DispatchQueue(label: "resuto.printer")
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let completion = PrinterCompletion(continuation: continuation, connection: connection)
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready: connection.send(content: data, completion: .contentProcessed { error in completion.finish(error) })
                case .failed(let error): completion.finish(error)
                case .cancelled: completion.finish(CancellationError())
                default: break
                }
            }
            queue.asyncAfter(deadline: .now() + 15) { completion.finish(URLError(.timedOut)) }
            connection.start(queue: queue)
        }
    }
}
private final class PrinterCompletion: @unchecked Sendable {
    private let lock = NSLock(); private var continuation: CheckedContinuation<Void, Error>?
    private let connection: NWConnection
    init(continuation: CheckedContinuation<Void, Error>, connection: NWConnection) { self.continuation = continuation; self.connection = connection }
    func finish(_ error: Error?) {
        lock.lock(); let pending = continuation; continuation = nil; lock.unlock()
        guard let pending else { return }; connection.stateUpdateHandler = nil; connection.cancel()
        if let error { pending.resume(throwing: error) } else { pending.resume() }
    }
}
