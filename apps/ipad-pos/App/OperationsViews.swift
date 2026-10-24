import SwiftUI

struct FloorView: View {
    @EnvironmentObject var m: POSModel
    @EnvironmentObject var l: Language
    let onSelect: () -> Void
    @State private var selected: FloorTable?
    var body: some View {
        Group {
            if !m.can("floor:read") { EmptyState(key: "permission_denied", symbol: "lock") }
            else if let layout = m.layout {
                let tables = m.live?.tables ?? layout.tables
                if tables.isEmpty { EmptyState(key: "empty_floor", symbol: "table.furniture") }
                else {
                    VStack(alignment: .leading) {
                        HStack { Label(l.text("available"), systemImage: "circle"); Label(l.text("occupied"), systemImage: "circle.fill"); Spacer(); Text("\(tables.count) · \(l.text("table"))").monospacedDigit() }.font(.subheadline).foregroundStyle(.secondary).padding()
                        GeometryReader { geometry in
                            let scale = min(geometry.size.width / max(layout.width, 1), geometry.size.height / max(layout.height, 1))
                            ZStack(alignment: .topLeading) {
                                RoundedRectangle(cornerRadius: 24).fill(Design.surface)
                                FloorBackdrop(background: layout.background)
                                    .frame(width: layout.background.width * scale, height: layout.background.height * scale)
                                    .opacity(layout.background.opacity)
                                    .position(x: (layout.background.x + layout.background.width / 2) * scale, y: (layout.background.y + layout.background.height / 2) * scale)
                                    .allowsHitTesting(false)
                                ForEach((layout.zones + layout.objects).filter { $0.hidden != true }) { element in
                                    RoundedRectangle(cornerRadius: element.type == "plant" ? 40 : 5)
                                        .fill(Color(floorHex: element.color).opacity(element.type == "zone" ? 0.12 : 0.25))
                                        .overlay { Text(element.label).font(.caption).lineLimit(1).padding(4) }
                                        .frame(width: max(1, element.width * scale), height: max(1, element.height * scale))
                                        .rotationEffect(.degrees(element.rotation)).position(x: element.x * scale, y: element.y * scale).allowsHitTesting(false)
                                }
                                ForEach(tables) { table in
                                    Button { selected = table } label: {
                                        VStack(spacing: 3) { Text(table.label).font(.headline); Text("\(table.capacity)").font(.caption.monospacedDigit()); if table.visit != nil { Image(systemName: "person.2.fill") } }
                                            .frame(width: max(52, table.width * scale), height: max(52, table.height * scale))
                                            .background(table.visit == nil ? Design.accent.opacity(0.10) : Design.accent.opacity(0.28), in: RoundedRectangle(cornerRadius: table.shape == "round" ? 60 : 12))
                                            .overlay { RoundedRectangle(cornerRadius: 12).stroke(table.status == "cleaning" ? .orange : Design.accent.opacity(0.3), lineWidth: 2) }
                                    }.buttonStyle(.plain).accessibilityIdentifier("table." + table.id).rotationEffect(.degrees(table.rotation)).position(x: table.cx * scale, y: table.cy * scale)
                                        .accessibilityLabel("\(l.text("table")) \(table.label), \(l.text(table.visit == nil ? table.status : "occupied")), \(table.capacity)")
                                }
                            }.environment(\.layoutDirection, .leftToRight)
                        }.padding()
                    }
                }
            } else { EmptyState(key: "empty_floor", symbol: "table.furniture") }
        }.sheet(item: $selected) { table in
            NavigationStack {
                Form {
                    Text("\(l.text("table")) \(table.label)").font(.title)
                    Label(l.text(table.visit == nil ? table.status : "occupied"), systemImage: "circle.fill")
                    if let visit = table.visit { LabeledContent(l.text("due"), value: Money.text(visit.dueMinor, currency: m.restaurant?.currency ?? "")) }
                    if let reservation = table.nextReservation { Section(l.text("reservation")) { Text(reservation.guestName); Text(reservation.startsAt).font(.caption); Text("\(reservation.partySize)").monospacedDigit() } }
                    if m.can("orders:write") {
                        Button(l.text("add_to_order")) { m.selectedTable = table; m.fulfillment = "dine_in"; m.persistDraft(); selected = nil; onSelect() }.frame(minHeight: 44).accessibilityIdentifier("floor.order")
                    }
                    if m.can("floor:seat") {
                        if table.visit == nil { Button(l.text(table.status == "cleaning" ? "mark_clean" : "seat")) { action(table, table.status == "cleaning" ? "clean" : "seat") }.disabled(!m.reachable) }
                        else { Button(l.text("close_visit")) { action(table, "close") }.disabled(!m.reachable) }
                    }
                }.toolbar { Button(l.text("done")) { selected = nil } }
            }.presentationDetents([.medium, .large])
        }
    }
    private func action(_ table: FloorTable, _ action: String) { Task { await m.perform { try await m.tableAction(table, action: action); selected = nil } } }
}
struct OrdersView: View {
    @EnvironmentObject var m: POSModel
    @EnvironmentObject var l: Language
    let history: Bool
    @State private var query = ""
    var body: some View {
        let final: Set<String> = ["served", "picked_up", "delivered", "cancelled"]
        let orders = (history ? m.historyOrders : m.orders).filter { (history || !final.contains($0.status)) && (query.isEmpty || $0.number.localizedCaseInsensitiveContains(query)) }
        Group {
            if !m.can("orders:read") { EmptyState(key: "permission_denied", symbol: "lock") }
            else {
                List {
                    if orders.isEmpty { EmptyState(key: "empty_orders", symbol: "tray") }
                    ForEach(orders) { order in
                        Button { Task { await m.perform { try await m.openOrder(order.id) } } } label: {
                            HStack(spacing: 20) {
                                Text("#\(order.number)").font(.title3.bold()).monospacedDigit().frame(minWidth: 70)
                                VStack(alignment: .leading, spacing: 6) { Text(order.tableLabel ?? l.text(order.fulfillment)); Text(l.text(order.status)).foregroundStyle(Design.accent) }
                                Spacer()
                                VStack(alignment: .trailing, spacing: 6) { Text(Money.text(order.totalMinor, currency: order.currency)).font(.headline); Text(l.text(order.paymentStatus)).font(.caption).foregroundStyle(.secondary) }
                            }.padding(.vertical, 12)
                        }.foregroundStyle(.primary).disabled(!m.reachable).accessibilityIdentifier("order." + order.id)
                    }
                    if history && m.nextCursor != nil { Button(l.text("more")) { Task { await m.perform { try await m.moreOrders() } } } }
                }.searchable(text: $query, prompt: l.text("search_menu"))
                    .task { if history { await m.perform { try await m.loadHistory(reset: true) } } }
            }
        }
    }
}
struct KitchenView: View {
    @EnvironmentObject var m: POSModel
    @EnvironmentObject var l: Language
    var body: some View {
        if !m.can("kitchen:operate") { EmptyState(key: "permission_denied", symbol: "lock") }
        else if m.tickets.isEmpty { EmptyState(key: "empty_kitchen", symbol: "flame") }
        else {
            ScrollView {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 280, maximum: 400))], spacing: 20) {
                    ForEach(m.tickets) { ticket in
                        VStack(alignment: .leading, spacing: 14) {
                            HStack { Text("#\(ticket.number)").font(.title2.bold()); Spacer(); Text("\(ticket.ageSeconds / 60)m").monospacedDigit() }
                            Text(ticket.tableLabel ?? l.text(ticket.fulfillment)).foregroundStyle(.secondary)
                            Text(l.text(ticket.status)).font(.headline).foregroundStyle(Design.accent)
                            Divider()
                            ForEach(ticket.lines) { line in
                                VStack(alignment: .leading, spacing: 4) { Text("\(line.quantity) × \(l.name(line.name, line.nameAr))").font(.headline); Text(line.modifiers.joined(separator: ", ")).font(.subheadline); if let note = line.notes { Text(note).foregroundStyle(.orange) }; Text(l.text(line.kitchenStatus)).font(.caption).foregroundStyle(.secondary)
                                    if m.can("kitchen:operate"), ["queued", "preparing"].contains(line.kitchenStatus) {
                                        let next = line.kitchenStatus == "queued" ? "preparing" : "ready"
                                        Button(l.text(next)) { Task { await m.perform { try await m.kitchenLine(line.id, status: next) } } }.buttonStyle(.bordered).disabled(!m.reachable)
                                    }
                                }
                            }
                            if let note = ticket.notes { Text(note).padding(10).background(.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 8)) }
                            Button(l.text("orders")) { Task { await m.perform { try await m.openOrder(ticket.id) } } }.buttonStyle(.bordered).disabled(!m.reachable).accessibilityIdentifier("kitchen.open." + ticket.id)
                        }.padding(20).frame(maxWidth: .infinity, alignment: .leading).background(Design.surface, in: RoundedRectangle(cornerRadius: 20))
                    }
                }.padding(20)
            }
        }
    }
}
struct SyncView: View {
    @EnvironmentObject var m: POSModel
    @EnvironmentObject var l: Language
    @State private var reviewing: PendingOrder?
    var body: some View {
        List {
            if m.pending.isEmpty { EmptyState(key: "no_pending", symbol: "checkmark.icloud") }
            ForEach(m.pending) { operation in
                VStack(alignment: .leading, spacing: 12) {
                    Label(l.text("sync_" + operation.state.rawValue), systemImage: operation.state == .accepted ? "checkmark.circle" : "arrow.triangle.2.circlepath")
                        .font(.headline).foregroundStyle(operation.state == .attention ? .orange : Design.accent)
                    Text(operation.serverNumber.map { "#\($0)" } ?? String(operation.id.uuidString.prefix(8))).font(.subheadline.monospaced())
                    Text(operation.createdAt, style: .date).font(.caption)
                    if let issue = operation.issue { Text(l.text(issue)).foregroundStyle(.secondary) }
                    HStack {
                        if operation.state == .local {
                            Button(l.text("review_send")) { Task { await m.perform { try await m.prepareReview(operation); reviewing = operation } } }.disabled(!m.reachable)
                            Button(l.text("discard"), role: .destructive) { Task { await m.perform { try await m.discard(operation) } } }
                        } else if operation.state == .queued {
                            Button(l.text("retry")) { Task { await m.perform { try await m.retry(operation) } } }.disabled(!m.reachable)
                        } else if let id = operation.serverOrderId {
                            Button(l.text("orders")) { Task { await m.perform { try await m.openOrder(id) } } }.disabled(!m.reachable)
                        }
                    }.buttonStyle(.bordered)
                }.padding(.vertical, 10)
            }
        }.sheet(item: $reviewing) { operation in
            NavigationStack {
                Form {
                    Section(l.text("price_review")) {
                        ForEach(Array(operation.payload.lines.enumerated()), id: \.offset) { _, line in
                            let item = m.menu?.products.first { $0.id == line.productId }
                            Text("\(line.quantity) × \(l.name(item?.name ?? line.productId, item?.nameAr))")
                        }
                        if let menu = m.menu, let estimate = try? CartRules.estimate(operation.payload, menu: menu) {
                            Text(Money.text(estimate, currency: menu.currency)).font(.title2.bold())
                        }
                        Text(l.text("server_total_notice")).foregroundStyle(.secondary)
                    }
                    Button(l.text("confirm_send")) { Task { await m.perform { try await m.approve(operation); reviewing = nil } } }.disabled(!m.reachable || !m.can("orders:write"))
                }.navigationTitle(l.text("review_send")).toolbar { Button(l.text("cancel")) { reviewing = nil } }
            }
        }
    }
}
struct OrderView: View {
    let order: OrderDetail
    @EnvironmentObject var m: POSModel
    @EnvironmentObject var l: Language
    @Environment(\.dismiss) var dismiss
    @State private var amount = ""
    @State private var people = 2
    @State private var reason = ""
    @State private var confirmCash = false
    @State private var confirmCancel = false
    @State private var refundPayment: OrderDetail.Payment?
    private var current: OrderDetail { m.detail ?? order }
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack { Text("#\(current.number)").font(.largeTitle.bold()); Spacer(); Text(l.text(current.status)).foregroundStyle(Design.accent) }
                    Text(l.text(current.paymentStatus)).font(.headline)
                    ForEach(current.lines) { line in HStack { Text("\(line.quantity) × \(l.name(line.name, line.nameAr))"); Spacer(); Text(Money.text(line.lineTotalMinor, currency: current.currency)).monospacedDigit() } }
                }
                Section(l.text("total")) {
                    total("subtotal", current.subtotalMinor); total("discount", current.discountMinor); total("tax", current.taxMinor); total("service", current.serviceChargeMinor); total("delivery", current.deliveryFeeMinor); total("total", current.totalMinor); total("due", current.dueMinor)
                }
                if m.can("orders:status"), OrderLifecycle.next(current.status, fulfillment: current.fulfillment) != nil {
                    Button(l.text("advance")) { Task { await m.perform { try await m.transition(current) } } }.disabled(!m.reachable).accessibilityIdentifier("order.advance")
                }
                if m.can("payments:collect"), current.dueMinor > 0, current.status != "cancelled" {
                    Section(l.text("payment")) {
                        Text(l.text("payment_notice")).font(.subheadline).foregroundStyle(.secondary)
                        TextField(l.text("amount"), text: $amount).keyboardType(.decimalPad).environment(\.layoutDirection, .leftToRight).accessibilityIdentifier("cashAmount")
                        DisclosureGroup(l.text("split_amount")) {
                            Stepper("\(l.text("people")): \(people)", value: $people, in: 2...20)
                            if let split = try? Money.split(current.dueMinor, people: people) {
                                ForEach(Array(split.enumerated()), id: \.offset) { index, share in
                                    Button("\(index + 1) · \(Money.text(share, currency: current.currency))") { amount = Money.text(share, currency: "").trimmingCharacters(in: .whitespaces) }
                                }
                            }
                        }
                        Button(l.text("record_cash")) { confirmCash = true }.accessibilityIdentifier("checkout.reviewCash").disabled(!m.reachable || (Money.parse(amount) ?? 0) <= 0 || (Money.parse(amount) ?? Int64.max) > current.dueMinor)
                    }
                }
                Section(l.text("receipt")) {
                    Button(l.text("queue_receipt")) { Task { await m.perform { try await m.enqueueReceipt(current, arabic: l.arabic) } } }.accessibilityIdentifier("receipt.enqueue")
                    ForEach(current.payments) { payment in
                        VStack(alignment: .leading, spacing: 8) {
                            HStack { Text(l.text(payment.method)); Spacer(); Text(l.text(payment.status)); if payment.isTest { Text(l.text("test")).foregroundStyle(.orange) } }
                            if m.can("payments:refund"), payment.amountMinor > payment.refundedMinor {
                                Button(l.text("request_refund"), role: .destructive) { refundPayment = payment }.disabled(!m.reachable)
                            }
                        }
                    }
                    if let status = m.refundStatus { Text("\(l.text("refund")): \(l.text(status))").foregroundStyle(.secondary) }
                }
                if m.can("orders:cancel"), current.status != "cancelled" {
                    Section(l.text("cancel_order")) {
                        TextField(l.text("reason"), text: $reason)
                        Button(l.text("cancel_order"), role: .destructive) { confirmCancel = true }.disabled(!m.reachable || reason.count < 2 || reason.count > 300)
                    }
                }
            }.navigationTitle(l.text("orders")).toolbar { Button(l.text("done")) { m.detail = nil; dismiss() }.accessibilityIdentifier("order.done") }
                .confirmationDialog(l.text("payment_notice"), isPresented: $confirmCash, titleVisibility: .visible) {
                    Button(l.text("record_cash")) { Task { await m.perform { guard let value = Money.parse(amount) else { return }; try await m.collect(current, amount: value); amount = "" } } }.accessibilityIdentifier("checkout.confirmCash")
                }
                .confirmationDialog(l.text("cancel_order"), isPresented: $confirmCancel, titleVisibility: .visible) {
                    Button(l.text("cancel_order"), role: .destructive) { Task { await m.perform { try await m.cancel(current, reason: reason) } } }
                }
        }.onAppear { amount = Money.text(current.dueMinor, currency: "").trimmingCharacters(in: .whitespaces) }
            .sheet(item: $refundPayment) { payment in RefundView(payment: payment, order: current) }
    }
    private func total(_ key: String, _ minor: Int64) -> some View { LabeledContent(l.text(key), value: Money.text(minor, currency: current.currency)).monospacedDigit() }
}

struct RefundView: View {
    let payment: OrderDetail.Payment
    let order: OrderDetail
    @EnvironmentObject var m: POSModel
    @EnvironmentObject var l: Language
    @Environment(\.dismiss) var dismiss
    @State private var amount = ""
    @State private var reason = ""
    @State private var confirm = false
    var body: some View {
        NavigationStack {
            Form {
                Text(l.text("refund_notice"))
                TextField(l.text("amount"), text: $amount).keyboardType(.decimalPad)
                TextField(l.text("reason"), text: $reason)
                Button(l.text("request_refund"), role: .destructive) { confirm = true }
                    .disabled(!m.reachable || reason.trimmingCharacters(in: .whitespaces).isEmpty || reason.count > 300 || (Money.parse(amount) ?? 0) <= 0 || (Money.parse(amount) ?? Int64.max) > payment.amountMinor - payment.refundedMinor)
            }.navigationTitle(l.text("refund")).toolbar { Button(l.text("cancel")) { dismiss() } }
                .confirmationDialog(l.text("request_refund"), isPresented: $confirm) {
                    Button(l.text("request_refund"), role: .destructive) { Task { await m.perform { guard let value = Money.parse(amount) else { return }; try await m.refund(payment: payment, amount: value, reason: reason, orderId: order.id); dismiss() } } }
                }
        }
    }
}

private extension Color {
    init(floorHex: String?) {
        let number = floorHex.flatMap { UInt64($0.replacingOccurrences(of: "#", with: ""), radix: 16) } ?? 0x6b8178
        self.init(red: Double((number >> 16) & 255) / 255, green: Double((number >> 8) & 255) / 255, blue: Double(number & 255) / 255)
    }
}

private struct FloorBackdrop: View {
    let background: FloorBackground
    var body: some View {
        if let image = background.image, image.hasPrefix("data:image/"), image.count <= 1_000_000,
           let comma = image.firstIndex(of: ","), let data = Data(base64Encoded: String(image[image.index(after: comma)...])), let decoded = UIImage(data: data) {
            Image(uiImage: decoded).resizable().scaledToFit().accessibilityHidden(true)
        } else if let image = background.image, let url = URL(string: image), url.scheme == "https" {
            AsyncImage(url: url) { image in image.resizable().scaledToFit() } placeholder: { Color.clear }.accessibilityHidden(true)
        }
    }
}
