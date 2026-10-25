import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var m: POSModel
    @EnvironmentObject var l: Language
    @AppStorage("printerType") private var type = "airprint"
    @AppStorage("printerHost") private var host = ""
    @AppStorage("printerWidth") private var width = 576
    @State private var confirm: PrintJob?
    @State private var financialRecovery = false
    var body: some View {
        Form {
            Section(l.text("staff")) {
                Label(m.me?.user.fullName ?? m.me?.user.email ?? "", systemImage: "person.crop.circle").font(.headline)
                Text(l.text("role_" + (m.membership?.role ?? ""))).foregroundStyle(.secondary)
                Toggle("العربية / English", isOn: $l.arabic)
                Button(l.text("change_workspace")) { Task { await m.perform { try await m.changeWorkspace() } } }.disabled(!m.reachable)
                Button(l.text("sign_out"), role: .destructive) { Task { await m.signOut() } }
            }
            Section(l.text("environment")) {
                Text(m.configuration?.apiURL.absoluteString ?? "").font(.subheadline.monospaced()).textSelection(.enabled)
                Text(m.restaurant?.name ?? ""); Text(m.branch?.name ?? "")
            }
            DeviceSettingsView(integration:m.deviceIntegration)
            if let intent = m.financial {
                Section(l.text("payment_reconciliation_required")) {
                    Text(intent.kind == "cash" ? l.text("cash") : l.text("refund"))
                    Text(Money.text(intent.amountMinor, currency: m.restaurant?.currency ?? ""))
                    Text(intent.orderId).font(.subheadline.monospaced()).textSelection(.enabled)
                    Text(intent.createdAt, style: .date)
                    Button(l.text("retry_same_financial")) { financialRecovery = true }.accessibilityIdentifier("financial.retry").disabled(!m.reachable)
                }
            }
            Section(l.text("printer")) {
                Picker(l.text("printer"), selection: $type) { Text(l.text("airprint")).tag("airprint"); Text(l.text("network_printer")).tag("network") }
                if type == "network" {
                    TextField(l.text("printer_host"), text: $host).keyboardType(.decimalPad).environment(\.layoutDirection, .leftToRight)
                    Picker(l.text("printer_width"), selection: $width) { Text("384").tag(384); Text("576").tag(576) }
                }
                Text(l.text("hardware_notice")).font(.body).foregroundStyle(.primary)
            }
            Section(l.text("receipt")) {
                ForEach(m.printJobs) { job in
                    VStack(alignment: .leading, spacing: 10) {
                        Text("#\(job.receipt.number)").font(.headline)
                        StatusBadge(text:l.text(job.state.rawValue),symbol:job.state == .waiting ? "printer" : "exclamationmark.circle")
                        if let issue = job.issue { Text(l.text(issue)).foregroundStyle(.orange) }
                        Button(l.text(job.state == .waiting ? "print" : "reprint")) {
                            if job.state == .waiting { printNow(job, reprint: false) } else { confirm = job }
                        }.disabled(job.state == .sending)
                    }.padding(.vertical, 8)
                }
            }
        }.accessibilityIdentifier("settings.form").confirmationDialog(l.text("financial_retry_notice"), isPresented: $financialRecovery, titleVisibility: .visible) {
            Button(l.text("retry_same_financial")) { Task { await m.perform { try await m.recoverFinancial() } } }.accessibilityIdentifier("financial.confirmRetry")
        }.confirmationDialog(l.text("print_confirmation"), isPresented: Binding(get: { confirm != nil }, set: { if !$0 { confirm = nil } }), titleVisibility: .visible) {
            if let job = confirm { Button(l.text("reprint")) { printNow(job, reprint: true); confirm = nil } }
        }
    }
    private func printNow(_ job: PrintJob, reprint: Bool) {
        let printer: any ReceiptPrinter = type == "network" ? NetworkRasterPrinter(host: host, width: width, arabic: l.arabic) : AirPrintAdapter(arabic: l.arabic)
        Task { await m.perform { try await m.printJob(job, printer: printer, reprint: reprint) } }
    }
}
