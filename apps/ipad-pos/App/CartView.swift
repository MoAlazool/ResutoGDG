import SwiftUI

private struct CartEdit: Identifiable { let id: Int; let product: Product }
struct CartView: View {
    @EnvironmentObject var m: POSModel
    @EnvironmentObject var l: Language
    @Environment(\.dynamicTypeSize) private var textSize
    @State private var editing: CartEdit?
    @State private var customer = false
    @State private var review = false
    var chooseTable: () -> Void = {}
    var body: some View {
        ScrollView {
        VStack(alignment: .leading, spacing: 16) {
            HStack { Text(l.text("cart")).font(.title2.bold()); Spacer(); Text("\(m.cart.reduce(0) { $0 + $1.quantity })").font(.headline.monospacedDigit()).padding(10).background(Design.accent.opacity(0.08), in: Circle()) }
            Picker(l.text("orders"), selection: $m.fulfillment) {
                if m.branch?.acceptsPickup == true { Text(l.text("pickup")).tag("pickup") }
                if m.branch?.acceptsDineIn == true { Text(l.text("dine_in")).tag("dine_in") }
                if m.branch?.acceptsDelivery == true { Text(l.text("delivery")).tag("delivery") }
            }.pickerStyle(.segmented).onChange(of: m.fulfillment) { _, _ in m.persistDraft() }
            if m.fulfillment == "dine_in" { Button(action: chooseTable) { Label(m.selectedTable?.label ?? l.text("select_table"), systemImage: "table.furniture").frame(minHeight: 48) }.accessibilityIdentifier("cart.chooseTable") }
            if m.fulfillment == "delivery" {
                TextField(l.text("delivery_address"), text: $m.deliveryLine).textFieldStyle(.roundedBorder).onChange(of: m.deliveryLine) { _, _ in m.persistDraft() }
                TextField(l.text("area"), text: $m.deliveryArea).textFieldStyle(.roundedBorder).onChange(of: m.deliveryArea) { _, _ in m.persistDraft() }
                TextField(l.text("city"), text: $m.deliveryCity).textFieldStyle(.roundedBorder).onChange(of: m.deliveryCity) { _, _ in m.persistDraft() }
            }
            if m.can("customers:read") {
                HStack {
                    Button { customer = true } label: { Label(m.customerName ?? l.text("customer"), systemImage: "person.crop.circle") }.disabled(!m.reachable)
                    if m.customerId != nil { Button(l.text("remove")) { m.customerId = nil; m.customerName = nil; m.persistDraft() } }
                }
            }
            if m.cart.isEmpty { EmptyState(key: "empty_cart", symbol: "basket").frame(minHeight: 120) }
            VStack {
                VStack(spacing: 16) {
                    ForEach(Array(m.cart.enumerated()), id: \.offset) { index, line in
                        HStack(alignment: .top) {
                            VStack(alignment: .leading) {
                                let item = m.menu?.products.first { $0.id == line.productId }
                                Button { if let item { editing = CartEdit(id: index, product: item) } } label: { Text(l.name(item?.name ?? "", item?.nameAr)).font(.headline).frame(minHeight: 44) }.buttonStyle(.plain)
                                ForEach(line.modifiers, id: \.self) { selection in
                                    if let option = m.menu?.modifierGroups.first(where: { $0.id == selection.groupId })?.options.first(where: { $0.id == selection.optionId }) { Text(l.name(option.name, option.nameAr)).font(.subheadline).foregroundStyle(.primary) }
                                }
                                if let notes = line.notes, !notes.isEmpty { Text(notes).font(.subheadline).foregroundStyle(.primary) }
                                Stepper("\(line.quantity)", value: Binding(get: { m.cart.indices.contains(index) ? m.cart[index].quantity : 1 }, set: { if m.cart.indices.contains(index) { m.cart[index].quantity = $0; m.persistDraft() } }), in: 1...99).monospacedDigit()
                            }
                            Button(role: .destructive) { m.cart.remove(at: index); m.persistDraft() } label: { Image(systemName: "trash").frame(minWidth: 44, minHeight: 44) }.accessibilityLabel(l.text("remove"))
                        }.padding(14).background(Design.canvas, in: RoundedRectangle(cornerRadius: 16))
                    }
                }
            }
            DisclosureGroup(l.text("order_details")) {
                VStack(spacing: 12) {
                    TextField(l.text("notes"), text: $m.notes).textFieldStyle(.roundedBorder).onChange(of: m.notes) { _, _ in m.persistDraft() }
                    TextField(l.text("promotion"), text: $m.promotion).textFieldStyle(.roundedBorder).onChange(of: m.promotion) { _, _ in m.persistDraft() }
                }.padding(.vertical, 12)
            }.font(.body).frame(minHeight: 44)
            if textSize.isAccessibilitySize { actions }
        }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
        }.background(Design.surface).safeAreaInset(edge: .bottom, spacing: 0) { if !textSize.isAccessibilitySize { actions } }
            .sheet(item: $editing) { value in ProductView(product: value.product, editingIndex: value.id) }
            .sheet(isPresented: $customer) { CustomerPicker() }
            .sheet(isPresented: $review) {
                NavigationStack {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 20) {
                            ResutoCard {
                                VStack(alignment: .leading, spacing: 16) {
                                    Label(l.text(m.fulfillment), systemImage: m.fulfillment == "dine_in" ? "table.furniture" : "bag").font(.headline)
                                    if let table = m.selectedTable, m.fulfillment == "dine_in" { Text(table.label).font(.title3.bold()) }
                                    ForEach(Array(m.cart.enumerated()), id: \.offset) { _, line in
                                        let item = m.menu?.products.first { $0.id == line.productId }
                                        HStack { Text("\(line.quantity) ×").monospacedDigit(); Text(l.name(item?.name ?? "", item?.nameAr)); Spacer() }
                                    }
                                    Divider()
                                    if let estimate = m.estimate { HStack { Text(l.text("item_estimate")); Spacer(); Text(Money.text(estimate, currency: m.menu?.currency ?? "")).font(.title2.bold().monospacedDigit()) } }
                                }
                            }
                            Label(l.text("server_total_notice"), systemImage: "checkmark.shield").font(.body)
                        }.padding(24)
                    }.background(Design.canvas).safeAreaInset(edge: .bottom) {
                        Button(l.text("confirm_send")) { Task { await m.perform { try await m.sendCurrentDraft(); review = false } } }.buttonStyle(PrimaryActionStyle()).disabled(!m.reachable || m.estimate == nil).accessibilityIdentifier("cart.confirm").padding(20).modifier(ActionChrome())
                    }.navigationTitle(l.text("review_send")).toolbar { Button(l.text("cancel")) { review = false } }
                }
            }
    }
    private var actions: some View {
        VStack(alignment: .leading, spacing: 12) {
            let estimate = m.estimate
            HStack(alignment: .firstTextBaseline) {
                Text(l.text("item_estimate")).font(.headline)
                Spacer()
                if let estimate { Text(Money.text(estimate, currency: m.menu?.currency ?? "")).font(.title2.bold()).monospacedDigit() }
            }
            Text(l.text("estimate")).font(.subheadline).foregroundStyle(.primary).fixedSize(horizontal: false, vertical: true)
            if !m.reachable { StatusBadge(text: l.text("offline_draft_notice"), symbol: "wifi.slash", tone: .warning) }
            if m.reachable {
                Button(l.text("review_send")) { Task { await m.perform { try await m.prepareCurrentDraft(); review = true } } }.buttonStyle(PrimaryActionStyle()).disabled(estimate == nil || !m.can("orders:write")).accessibilityIdentifier("cart.review")
            }
            Button { Task { await m.perform { _ = try await m.saveOrder() } } } label: {
                Label(l.text("save_order"), systemImage: "square.and.arrow.down").font(.body.weight(.semibold)).frame(maxWidth: .infinity, minHeight: 48)
            }.accessibilityIdentifier("cart.save").buttonStyle(.bordered).disabled(estimate == nil || !m.can("orders:write"))
        }.padding(20).modifier(ActionChrome())
    }

}
