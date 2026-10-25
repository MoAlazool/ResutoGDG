import SwiftUI

struct DeviceSettingsView: View {
    @ObservedObject var integration: DeviceIntegration
    @EnvironmentObject var m: POSModel
    @EnvironmentObject var l: Language
    @State private var code = ""
    @State private var forget = false
    var body: some View {
        Section(l.text("authorized_device")) {
            Text(l.text("device_shadow_notice")).font(.subheadline).foregroundStyle(.secondary)
            if integration.connecting { ProgressView(l.text("loading")) }
            if let issue = integration.issue { Text(l.failureText(issue)).foregroundStyle(.orange) }
            if let session = integration.session, let membership = m.membership {
                Label(l.text("device_connected"),systemImage:"checkmark.shield").accessibilityIdentifier("device.state.active")
                Text(session.device.name); Text(session.branch.name)
                Text(l.text("role_" + session.device.actingRole))
                Label(l.text(session.can("orders:write",membership:membership) ? "device_ordering_allowed" : "device_ordering_denied"),systemImage:session.can("orders:write",membership:membership) ? "checkmark" : "lock")
                if let snapshot = integration.snapshot {
                    let products = snapshot.menu?.categories?.reduce(0) { $0 + $1.products.count } ?? 0
                    Text("\(products) · \(l.text("menu")) / \(snapshot.orders.count) · \(l.text("orders"))").monospacedDigit().accessibilityIdentifier("device.shadow.ready")
                    if snapshot.ordersTruncated { Text(l.text("device_orders_truncated")).foregroundStyle(.orange) }
                }
                Button(l.text("refresh")) { integration.pause(); integration.resume() }.disabled(!m.reachable)
            } else if integration.binding == nil {
                Text(l.text("pair_this_ipad")).font(.headline).accessibilityIdentifier("device.state.none")
                TextField(l.text("pairing_code"),text:$code).textInputAutocapitalization(.characters).autocorrectionDisabled()
                    .textContentType(.oneTimeCode).environment(\.layoutDirection,.leftToRight).accessibilityIdentifier("pairing.code")
                Button(l.text("pair_and_compare")) { Task { await m.perform { await integration.pair(code:code); if integration.session != nil { code = "" } } } }
                    .disabled(!m.reachable || code.filter { !$0.isWhitespace && $0 != "-" }.count != 10).accessibilityIdentifier("pairing.submit")
            }
            if integration.binding != nil && integration.session == nil {
                Button(l.text("refresh")) { integration.pause(); integration.resume() }.disabled(!m.reachable)
            }
            if integration.binding != nil, ["owner","admin","manager"].contains(m.membership?.role ?? "") {
                Button(l.text("forget_pairing"),role:.destructive) { forget = true }.accessibilityIdentifier("device.forget")
            }
        }.confirmationDialog(l.text("forget_pairing_notice"),isPresented:$forget,titleVisibility:.visible) {
            Button(l.text("forget_pairing"),role:.destructive) { Task { await m.perform { await integration.forget() } } }.accessibilityIdentifier("device.confirmForget")
        }
    }
}
