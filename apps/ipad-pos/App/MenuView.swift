import SwiftUI

struct MenuView: View {
    @EnvironmentObject var m: POSModel
    @EnvironmentObject var l: Language
    @Environment(\.horizontalSizeClass) var size
    @State private var search = ""
    @State private var category: String?
    @State private var product: Product?
    var body: some View {
        Group {
            if !m.can("menu:read") { EmptyState(key: "permission_denied", symbol: "lock") }
            else if let menu = m.menu {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 0) { catalogue(menu).frame(minWidth: 360); Divider(); CartView().frame(width: 340) }
                    VStack(spacing: 0) { catalogue(menu); Divider(); CartView().frame(maxHeight: 370) }
                }
            } else { EmptyState(key: "empty_menu", symbol: "menucard") }
        }.sheet(item: $product) { ProductView(product: $0) }
    }
    private func catalogue(_ menu: Menu) -> some View {
        VStack(spacing: 0) {
            TextField(l.text("search_menu"), text: $search).textFieldStyle(.roundedBorder).padding().accessibilityIdentifier("menuSearch")
            ScrollView(.horizontal) {
                HStack { Button(l.text("all")) { category = nil }.buttonStyle(.bordered)
                    ForEach(menu.categories.filter(\.isActive)) { item in
                        Button(l.name(item.name, item.nameAr)) { category = item.id }.buttonStyle(.bordered).tint(category == item.id ? Design.accent : .secondary)
                    }
                }.padding(.horizontal).padding(.bottom, 12)
            }
            let products = menu.products.filter { item in
                item.isActive && (category == nil || item.categoryId == category) && (search.isEmpty || item.name.localizedCaseInsensitiveContains(search) || (item.nameAr?.localizedCaseInsensitiveContains(search) ?? false))
            }
            if products.isEmpty { EmptyState(key: "empty_menu", symbol: "magnifyingglass") }
            ScrollView {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 156, maximum: 240), spacing: 16)], spacing: 16) {
                    ForEach(products) { item in
                        Button { product = item } label: {
                            VStack(alignment: .leading, spacing: 10) {
                                AsyncImage(url: item.imageUrl.flatMap(URL.init(string:))) { image in image.resizable().scaledToFill() } placeholder: {
                                    ZStack { Design.accent.opacity(0.08); Image(systemName: "fork.knife").font(.largeTitle).foregroundStyle(Design.accent) }
                                }.frame(height: 120).frame(maxWidth: .infinity).clipped().accessibilityHidden(true)
                                Text(l.name(item.name, item.nameAr)).font(.headline).lineLimit(2)
                                Text(item.available(branch: m.branch!.id) ? Money.text(item.price(branch: m.branch!.id), currency: menu.currency) : l.text("sold_out")).font(.subheadline.monospacedDigit()).foregroundStyle(.secondary)
                            }.padding(12).background(Design.surface, in: RoundedRectangle(cornerRadius: 18)).contentShape(Rectangle())
                        }.buttonStyle(.plain).disabled(!item.available(branch: m.branch!.id) || !m.can("orders:write"))
                    }
                }.padding(16)
            }
        }
    }
}
struct ProductView: View {
    let product: Product
    @EnvironmentObject var m: POSModel
    @EnvironmentObject var l: Language
    @Environment(\.dismiss) var dismiss
    @State private var quantity = 1
    @State private var selections: Set<ModifierSelection> = []
    @State private var notes = ""
    private var groups: [ModifierGroup] { m.menu?.modifierGroups.filter { product.modifierGroupIds.contains($0.id) && $0.isActive } ?? [] }
    private var valid: Bool {
        groups.allSatisfy { group in let count = selections.filter { $0.groupId == group.id }.count; return count >= group.minSelect && count <= group.maxSelect } && notes.count <= 200
    }
    var body: some View {
        NavigationStack {
            Form {
                if let description = l.arabic ? product.descriptionAr ?? product.description : product.description { Text(description) }
                if !product.allergens.isEmpty { Section(l.text("allergens")) { Text(product.allergens.joined(separator: ", ")) } }
                Stepper("\(l.text("quantity")): \(quantity)", value: $quantity, in: 1...99).monospacedDigit()
                ForEach(groups) { group in
                    Section("\(l.name(group.name, group.nameAr)) · \(group.minSelect)–\(group.maxSelect)") {
                        ForEach(group.options.filter(\.isAvailable)) { option in
                            let selection = ModifierSelection(groupId: group.id, optionId: option.id)
                            Toggle(isOn: Binding(get: { selections.contains(selection) }, set: { chosen in
                                if !chosen { selections.remove(selection) }
                                else if group.maxSelect == 1 { selections = selections.filter { $0.groupId != group.id }; selections.insert(selection) }
                                else if selections.filter({ $0.groupId == group.id }).count < group.maxSelect { selections.insert(selection) }
                            })) { HStack { Text(l.name(option.name, option.nameAr)); Spacer(); Text(Money.text(option.priceDeltaMinor, currency: product.currency)).foregroundStyle(.secondary) } }
                        }
                    }
                }
                TextField(l.text("notes"), text: $notes, axis: .vertical).lineLimit(2...4)
            }.navigationTitle(l.name(product.name, product.nameAr)).navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button(l.text("cancel")) { dismiss() } }; ToolbarItem(placement: .confirmationAction) {
                    Button(l.text("add_to_order")) { m.add(CartLine(productId: product.id, quantity: quantity, modifiers: selections.sorted { $0.optionId < $1.optionId }, notes: notes)); dismiss() }.disabled(!valid)
                } }
        }.onAppear { selections = Set(groups.flatMap { group in group.options.filter { $0.isDefault && $0.isAvailable }.prefix(group.maxSelect).map { ModifierSelection(groupId: group.id, optionId: $0.id) } }) }
    }
}
struct CartView: View {
    @EnvironmentObject var m: POSModel
    @EnvironmentObject var l: Language
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack { Text(l.text("cart")).font(.title2.bold()); Spacer(); Text("\(m.cart.reduce(0) { $0 + $1.quantity })").monospacedDigit().foregroundStyle(.secondary) }
            Picker(l.text("orders"), selection: $m.fulfillment) { Text(l.text("pickup")).tag("pickup"); Text(l.text("dine_in")).tag("dine_in") }.pickerStyle(.segmented).onChange(of: m.fulfillment) { _, _ in m.persistDraft() }
            if m.fulfillment == "dine_in" { Label(m.selectedTable?.label ?? l.text("select_table"), systemImage: "table.furniture").foregroundStyle(.secondary) }
            if m.cart.isEmpty { EmptyState(key: "empty_cart", symbol: "basket") }
            ScrollView {
                VStack(spacing: 16) {
                    ForEach(Array(m.cart.enumerated()), id: \.offset) { index, line in
                        HStack(alignment: .top) {
                            VStack(alignment: .leading) {
                                let item = m.menu?.products.first { $0.id == line.productId }
                                Text(l.name(item?.name ?? "", item?.nameAr)).font(.headline)
                                if let notes = line.notes, !notes.isEmpty { Text(notes).font(.caption).foregroundStyle(.secondary) }
                                Stepper("\(line.quantity)", value: Binding(get: { m.cart.indices.contains(index) ? m.cart[index].quantity : 1 }, set: { if m.cart.indices.contains(index) { m.cart[index].quantity = $0; m.persistDraft() } }), in: 1...99).monospacedDigit()
                            }
                            Button(role: .destructive) { m.cart.remove(at: index); m.persistDraft() } label: { Image(systemName: "trash").frame(minWidth: 44, minHeight: 44) }.accessibilityLabel(l.text("remove"))
                        }
                    }
                }
            }
            TextField(l.text("notes"), text: $m.notes).textFieldStyle(.roundedBorder).onChange(of: m.notes) { _, _ in m.persistDraft() }
            TextField(l.text("promotion"), text: $m.promotion).textFieldStyle(.roundedBorder).onChange(of: m.promotion) { _, _ in m.persistDraft() }
            Divider()
            if let estimate = m.estimate { Text(Money.text(estimate, currency: m.menu?.currency ?? "")).font(.title2.bold()).monospacedDigit() }
            Text(l.text("estimate")).font(.caption).foregroundStyle(.secondary)
            Button(l.text("save_order")) { Task { await m.perform { try await m.saveOrder() } } }.buttonStyle(.borderedProminent).controlSize(.large).disabled(m.estimate == nil || !m.can("orders:write")).frame(maxWidth: .infinity)
        }.padding(20).background(Design.surface)
    }
}
