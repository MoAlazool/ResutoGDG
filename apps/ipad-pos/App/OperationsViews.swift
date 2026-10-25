import SwiftUI

struct FloorView: View {
    @EnvironmentObject var m: POSModel
    @EnvironmentObject var l: Language
    let onSelect: () -> Void
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var listMode = false
    @State private var selected: FloorTable?
    var body: some View {
        Group {
            if !m.can("floor:read") { EmptyState(key: "permission_denied", symbol: "lock") }
            else if let layout = m.layout {
                let tables = m.live?.tables ?? layout.tables
                if tables.isEmpty { EmptyState(key: "empty_floor", symbol: "table.furniture") }
                else {
                    VStack(alignment: .leading) {
                        HStack {
                            VStack(alignment: .leading, spacing: 6) {
                                Text(l.text("floor")).font(.title2.bold())
                                Text("\(tables.count) · \(l.text("table"))").font(.subheadline).monospacedDigit()
                            }
                            Spacer()
                            if !typeSize.isAccessibilitySize {
                                Button(l.text(listMode ? "floor_map" : "floor_list"),systemImage:listMode ? "map" : "list.bullet") { listMode.toggle() }
                                    .frame(minHeight:44).accessibilityIdentifier("floor.mode")
                            }
                        }.padding(.horizontal, 20).padding(.top, 16)
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 10) {
                                StatusBadge(text: l.text("available"), symbol: "circle", tone: .positive)
                                StatusBadge(text: l.text("occupied"), symbol: "person.2.fill", tone: .neutral)
                                StatusBadge(text: l.text("cleaning"), symbol: "sparkles", tone: .warning)
                            }.padding(.horizontal, 20).padding(.vertical, 8)
                        }
                        if listMode || typeSize.isAccessibilitySize {
                            List(tables.sorted { $0.label.localizedStandardCompare($1.label) == .orderedAscending }) { table in
                                Button { selected = table } label: {
                                    VStack(alignment:.leading,spacing:8) {
                                        Text(l.text("table") + " " + table.label).font(.headline)
                                        Text("\(l.text(table.visit == nil ? table.status : "occupied")) · \(table.capacity) \(l.text("seats"))").foregroundStyle(.secondary)
                                        if let visit = table.visit { Text(l.text("due") + " " + Money.text(visit.dueMinor,currency:m.restaurant?.currency ?? "")) }
                                    }.frame(maxWidth:.infinity,alignment:.leading).padding(.vertical,8)
                                }.foregroundStyle(.primary).accessibilityIdentifier("table." + table.id)
                                    .accessibilityHint(l.text("table_details_hint"))
                            }.accessibilityIdentifier("floor.list")
                        } else {
                        GeometryReader { geometry in
                            let scale = min(geometry.size.width / max(layout.width, 1), geometry.size.height / max(layout.height, 1))
                            ZStack(alignment: .topLeading) {
                                RoundedRectangle(cornerRadius: 24).fill(Design.surface)
                                FloorBackdrop(background: layout.background)
                                    .frame(width: layout.background.width * scale, height: layout.background.height * scale)
                                    .opacity(layout.background.opacity)
                                    .position(x: (layout.background.x + layout.background.width / 2) * scale, y: (layout.background.y + layout.background.height / 2) * scale)
                                    .allowsHitTesting(false).accessibilityHidden(true)
                                ForEach((layout.zones + layout.objects).filter { $0.hidden != true }) { element in
                                    RoundedRectangle(cornerRadius: element.type == "plant" ? 40 : 5)
                                        .fill(Color(floorHex: element.color).opacity(element.type == "zone" ? 0.12 : 0.25))
                                        .overlay { Text(element.label).font(.caption).lineLimit(1).padding(4) }
                                        .frame(width: max(1, element.width * scale), height: max(1, element.height * scale))
                                        .rotationEffect(.degrees(element.rotation)).position(x: element.x * scale, y: element.y * scale).allowsHitTesting(false).accessibilityHidden(true)
                                }
                                ForEach(tables) { table in
                                    Button { selected = table } label: {
                                        VStack(spacing: 3) { Text(table.label).font(.headline); Text("\(table.capacity)").font(.caption.monospacedDigit()); if table.visit != nil { Image(systemName: "person.2.fill") } }
                                            .frame(width: max(52, table.width * scale), height: max(52, table.height * scale))
                                            .foregroundStyle(Design.accent)
                                            .background(table.visit == nil ? Design.surface : Design.accent.opacity(0.18), in: RoundedRectangle(cornerRadius: table.shape == "round" ? 60 : 12))
                                            .overlay { RoundedRectangle(cornerRadius: 12).stroke(table.status == "cleaning" ? .orange : Design.accent.opacity(0.3), lineWidth: 2) }
                                    }.buttonStyle(.plain).accessibilityIdentifier("table." + table.id).rotationEffect(.degrees(table.rotation)).position(x: table.cx * scale, y: table.cy * scale)
                                        .accessibilityLabel("\(l.text("table")) \(table.label), \(l.text(table.visit == nil ? table.status : "occupied")), \(table.capacity) \(l.text("seats"))").accessibilityHint(l.text("table_details_hint"))
                                }
                            }.environment(\.layoutDirection, .leftToRight)
                        }.padding()
                        }
                    }
                }
            } else { EmptyState(key: "empty_floor", symbol: "table.furniture") }
        }.sheet(item: $selected) { table in
            NavigationStack {
                Form {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("\(l.text("table")) \(table.label)").font(.largeTitle.bold())
                        StatusBadge(text: l.text(table.visit == nil ? table.status : "occupied"), symbol: "table.furniture", tone: table.status == "cleaning" ? .warning : .neutral)
                        Text("\(table.capacity) \(l.text("seats"))").font(.body).monospacedDigit()
                    }.padding(.vertical, 8)
                    if let visit = table.visit { LabeledContent(l.text("due"), value: Money.text(visit.dueMinor, currency: m.restaurant?.currency ?? "")) }
                    if let reservation = table.nextReservation { Section(l.text("reservation")) { Text(reservation.guestName); Text(reservation.startsAt).font(.caption); Text("\(reservation.partySize)").monospacedDigit() } }
                    if m.can("orders:write") {
                        Button(l.text("add_to_order")) { m.selectedTable = table; m.fulfillment = "dine_in"; m.persistDraft(); selected = nil; onSelect() }.buttonStyle(.borderedProminent).controlSize(.large).frame(minHeight: 48).accessibilityIdentifier("floor.order")
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
                                VStack(alignment: .trailing, spacing: 6) { Text(Money.text(order.totalMinor, currency: order.currency)).font(.headline); Text(l.text(order.paymentStatus)).font(.subheadline).foregroundStyle(order.paymentStatus == "paid" ? Design.accent : .primary) }
                            }.padding(.vertical, 12)
                        }.foregroundStyle(.primary).disabled(!m.reachable).accessibilityIdentifier("order." + order.id)
                    }
                    if history && m.nextCursor != nil { Button(l.text("more")) { Task { await m.perform { try await m.moreOrders() } } } }
                }.searchable(text: $query, prompt: l.text("search_orders"))
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
                        ResutoCard {
                            VStack(alignment: .leading, spacing: 16) {
                                HStack(alignment: .top) {
                                    VStack(alignment: .leading, spacing: 6) {
                                        Text("#\(ticket.number)").font(.title.bold()).monospacedDigit()
                                        Label(ticket.tableLabel ?? l.text(ticket.fulfillment), systemImage: ticket.tableLabel == nil ? "bag" : "table.furniture").font(.subheadline)
                                    }
                                    Spacer()
                                    Label("\(max(0,ticket.ageSeconds) / 60) \(l.text("minutes_short"))", systemImage: "clock")
                                        .font(.subheadline.weight(.semibold)).monospacedDigit()
                                        .accessibilityLabel("\(max(0,ticket.ageSeconds) / 60) \(l.text("minutes"))")
                                }
                                StatusBadge(text: l.text(ticket.status), symbol: ticket.status == "ready" ? "checkmark.circle.fill" : "flame", tone: ticket.status == "ready" ? .positive : .neutral)
                                Divider()
                                ForEach(ticket.lines) { line in
                                    VStack(alignment: .leading, spacing: 10) {
                                        Text("\(line.quantity) × \(l.name(line.name, line.nameAr))").font(.headline)
                                        if !line.modifiers.isEmpty { Text(line.modifiers.joined(separator: ", ")).font(.body) }
                                        if let note = line.notes, !note.isEmpty {
                                            Label(note, systemImage: "text.bubble").font(.body.weight(.medium)).padding(12)
                                                .frame(maxWidth: .infinity, alignment: .leading)
                                                .background(Design.mutedSurface, in: RoundedRectangle(cornerRadius: 12))
                                        }
                                        HStack {
                                            Text(l.text(line.kitchenStatus)).font(.subheadline.weight(.medium))
                                            Spacer()
                                            if m.can("kitchen:operate"), ["queued", "preparing"].contains(line.kitchenStatus) {
                                                let next = line.kitchenStatus == "queued" ? "preparing" : "ready"
                                                Button(l.text(next)) { Task { await m.perform { try await m.kitchenLine(line.id, status: next) } } }
                                                    .buttonStyle(.borderedProminent).controlSize(.large).frame(minHeight: 48).disabled(!m.reachable)
                                            }
                                        }
                                    }.padding(.vertical, 4)
                                    Divider()
                                }
                                if let note = ticket.notes, !note.isEmpty {
                                    Label(note, systemImage: "text.bubble").padding(12).frame(maxWidth: .infinity, alignment: .leading)
                                        .background(Design.mutedSurface, in: RoundedRectangle(cornerRadius: 12))
                                }
                                Button { Task { await m.perform { try await m.openOrder(ticket.id) } } } label: {
                                    Label(l.text("orders"), systemImage: "arrow.up.right.square").frame(maxWidth: .infinity, minHeight: 48)
                                }.buttonStyle(.bordered).disabled(!m.reachable).accessibilityIdentifier("kitchen.open." + ticket.id)
                            }
                        }
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
            if !m.pending.isEmpty {
                Section {
                    Label(l.text(m.reachable ? "online" : "offline"), systemImage: m.reachable ? "wifi" : "wifi.slash").font(.headline)
                    Text(l.text("sync_integrity_notice")).font(.body)
                }
            }
            ForEach(m.pending) { operation in
                VStack(alignment: .leading, spacing: 14) {
                    Label(l.text("sync_" + operation.state.rawValue), systemImage: operation.state == .accepted ? "checkmark.circle" : "arrow.triangle.2.circlepath")
                        .font(.headline).foregroundStyle(operation.state == .attention ? .orange : Design.accent).accessibilityIdentifier("sync.state." + operation.state.rawValue)
                    Text(operation.serverNumber.map { "#\($0)" } ?? String(operation.id.uuidString.prefix(8))).font(.subheadline.monospaced())
                    Text(operation.createdAt, style: .date).font(.subheadline)
                    if let issue = operation.issue { Label(l.failureText(FailurePresentation.key(code:issue)), systemImage: "exclamationmark.triangle").font(.body) }
                    HStack {
                        if operation.state == .local {
                            Button(l.text("review_send")) { Task { await m.perform { try await m.prepareReview(operation); reviewing = operation } } }.disabled(!m.reachable)
                            Button(l.text("discard"), role: .destructive) { Task { await m.perform { try await m.discard(operation) } } }
                        } else if operation.state == .queued {
                            Button(l.text("retry")) { Task { await m.perform { try await m.retry(operation) } } }.disabled(!m.reachable)
                        } else if let id = operation.serverOrderId {
                            Button(l.text("orders")) { Task { await m.perform { try await m.openOrder(id) } } }.disabled(!m.reachable)
                        }
                    }.buttonStyle(.bordered).controlSize(.large).frame(minHeight: 48)
                }.padding(.vertical, 14)
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
                    VStack(alignment: .leading, spacing: 16) {
                        HStack(alignment: .top) {
                            VStack(alignment: .leading, spacing: 8) {
                                Text("#\(current.number)").font(.largeTitle.bold()).monospacedDigit()
                                Text(l.text(current.fulfillment)).font(.body)
                            }
                            Spacer()
                            Text(l.text(current.status)).font(.headline).foregroundStyle(Design.accent).accessibilityIdentifier("order.status")
                        }
                        Text(l.text(current.paymentStatus)).font(.headline).accessibilityIdentifier("order.paymentState")
                        Divider()
                        VStack(alignment: .leading, spacing: 6) {
                            Text(l.text(current.dueMinor > 0 ? "due" : "total")).font(.subheadline.weight(.semibold))
                            Text(Money.text(current.dueMinor > 0 ? current.dueMinor : current.totalMinor, currency: current.currency))
                                .font(.largeTitle.bold()).monospacedDigit().foregroundStyle(Design.accent)
                        }
                    }.padding(.vertical, 12)
                }
                if m.can("payments:collect"), current.dueMinor > 0, current.status != "cancelled" {
                    Section(l.text("payment")) {
                        VStack(alignment: .leading, spacing: 12) {
                            Text(l.text("amount")).font(.subheadline.weight(.semibold))
                            TextField(l.text("amount"), text: $amount).keyboardType(.decimalPad)
                                .environment(\.layoutDirection, .leftToRight).accessibilityIdentifier("cashAmount")
                                .font(.title2.weight(.semibold)).padding(14)
                                .background(Design.mutedSurface, in: RoundedRectangle(cornerRadius: 12))
                            Button { confirmCash = true } label: {
                                Label(l.text("record_cash"), systemImage: "banknote").frame(maxWidth: .infinity, minHeight: 48)
                            }.buttonStyle(.borderedProminent).controlSize(.large).accessibilityIdentifier("checkout.reviewCash")
                                .disabled(!m.reachable || (Money.parse(amount) ?? 0) <= 0 || (Money.parse(amount) ?? Int64.max) > current.dueMinor)
                            Text(l.text("payment_notice")).font(.subheadline)
                        }.padding(.vertical, 8)
                        DisclosureGroup(l.text("split_amount")) {
                            Stepper("\(l.text("people")): \(people)", value: $people, in: 2...20).monospacedDigit()
                            if let split = try? Money.split(current.dueMinor, people: people) {
                                ForEach(Array(split.enumerated()), id: \.offset) { index, share in
                                    Button("\(index + 1) · \(Money.text(share, currency: current.currency))") { amount = Money.text(share, currency: "").trimmingCharacters(in: .whitespaces) }.frame(minHeight: 48)
                                }
                            }
                        }
                    }
                }
                Section(l.text("orders")) {
                    ForEach(current.lines) { line in
                        VStack(alignment: .leading, spacing: 8) {
                            HStack(alignment: .firstTextBaseline, spacing: 16) {
                                Text("\(line.quantity) × \(l.name(line.name, line.nameAr))").font(.body.weight(.medium))
                                Spacer()
                                Text(Money.text(line.lineTotalMinor, currency: current.currency)).monospacedDigit()
                            }
                            if let note = line.notes, !note.isEmpty { Label(note, systemImage: "text.bubble").font(.subheadline) }
                        }.padding(.vertical, 6)
                    }
                    DisclosureGroup(l.text("total_breakdown")) {
                        total("subtotal", current.subtotalMinor)
                        total("discount", current.discountMinor)
                        total("tax", current.taxMinor)
                        total("service", current.serviceChargeMinor)
                        total("delivery", current.deliveryFeeMinor)
                        total("total", current.totalMinor)
                        total("due", current.dueMinor)
                    }
                }
                if m.can("orders:status"), OrderLifecycle.next(current.status, fulfillment: current.fulfillment) != nil {
                    Button(l.text("advance")) { Task { await m.perform { try await m.transition(current) } } }
                        .buttonStyle(.bordered).controlSize(.large).frame(minHeight: 48).disabled(!m.reachable).accessibilityIdentifier("order.advance")
                }
                Section(l.text("receipt")) {
                    Button(l.text("queue_receipt")) { Task { await m.perform { try await m.enqueueReceipt(current, arabic: l.arabic) } } }.accessibilityIdentifier("receipt.enqueue")
                    ForEach(current.payments) { payment in
                        VStack(alignment: .leading, spacing: 8) {
                            HStack { Text(l.text(payment.method)); Spacer(); Text(l.text(payment.status)); if payment.isTest { Text(l.text("test")).foregroundStyle(.orange) } }
                            if m.can("payments:refund"), payment.amountMinor > payment.refundedMinor {
                                Button(l.text("request_refund"), role: .destructive) { refundPayment = payment }.disabled(!m.reachable).accessibilityIdentifier("refund.open." + payment.id)
                            }
                        }
                    }
                    if let status = m.refundStatus { Text("\(l.text("refund")): \(l.text(status))").foregroundStyle(.secondary).accessibilityIdentifier("refund.state") }
                }
                if m.can("orders:cancel"), current.status != "cancelled" {
                    Section(l.text("cancel_order")) {
                        TextField(l.text("reason"), text: $reason)
                        Button(l.text("cancel_order"), role: .destructive) { confirmCancel = true }.disabled(!m.reachable || reason.count < 2 || reason.utf16.count > 300)
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
                TextField(l.text("amount"), text: $amount).keyboardType(.decimalPad).environment(\.layoutDirection,.leftToRight).accessibilityIdentifier("refund.amount")
                TextField(l.text("reason"), text: $reason).accessibilityIdentifier("refund.reason")
                Button(l.text("request_refund"), role: .destructive) { confirm = true }.accessibilityIdentifier("refund.review")
                    .disabled(!m.reachable || reason.trimmingCharacters(in: .whitespaces).isEmpty || reason.utf16.count > 300 || (Money.parse(amount) ?? 0) <= 0 || (Money.parse(amount) ?? Int64.max) > payment.amountMinor - payment.refundedMinor)
            }.navigationTitle(l.text("refund")).toolbar { Button(l.text("cancel")) { dismiss() } }
                .confirmationDialog(l.text("request_refund"), isPresented: $confirm) {
                    Button(l.text("request_refund"), role: .destructive) { Task { await m.perform { guard let value = Money.parse(amount) else { return }; try await m.refund(payment: payment, amount: value, reason: reason, orderId: order.id); dismiss() } } }.accessibilityIdentifier("refund.confirm")
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
