import SwiftUI

struct ProductView: View {
    let product: Product
    var editingIndex: Int? = nil
    @EnvironmentObject var m: POSModel
    @EnvironmentObject var l: Language
    @Environment(\.dismiss) var dismiss
    @State private var quantity = 1
    @State private var selections: Set<ModifierSelection> = []
    @State private var notes = ""
    private var groups: [ModifierGroup] { m.menu?.modifierGroups.filter { product.modifierGroupIds.contains($0.id) && $0.isActive } ?? [] }
    private var valid: Bool {
        groups.allSatisfy { group in let count = selections.filter { $0.groupId == group.id }.count; return count >= group.minSelect && count <= group.maxSelect } && notes.utf16.count <= 200
    }
    private var line: CartLine { CartLine(productId: product.id, quantity: quantity, modifiers: selections.sorted { $0.optionId < $1.optionId }, notes: notes) }
    private var estimate: Int64? {
        guard let menu = m.menu, let branch = m.branch else { return nil }
        // A line estimate only, never a tax-inclusive or authoritative checkout quote.
        return try? CartRules.estimate(StaffOrder(branchId: branch.id, fulfillment: "pickup", lines: [line]), menu: menu)
    }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    ResutoCard {
                        VStack(alignment: .leading, spacing: 12) {
                            Text(l.name(product.name, product.nameAr)).font(.title2.bold())
                            Text(Money.text(product.price(branch: m.branch?.id ?? ""), currency: product.currency)).font(.title3.weight(.semibold).monospacedDigit()).foregroundStyle(Design.accent)
                            if let description = l.arabic ? product.descriptionAr ?? product.description : product.description { Text(description).font(.body).fixedSize(horizontal: false, vertical: true) }
                            if !product.allergens.isEmpty { Label(l.text("allergens") + ": " + product.allergens.joined(separator: ", "), systemImage: "exclamationmark.circle").font(.subheadline).foregroundStyle(.primary) }
                        }
                    }
                    ResutoCard { Stepper("\(l.text("quantity")): \(quantity)", value: $quantity, in: 1...99).font(.headline).monospacedDigit().frame(minHeight: 48) }
                    ForEach(groups) { group in
                        ResutoCard {
                            VStack(alignment: .leading, spacing: 12) {
                                HStack(alignment: .top) {
                                    VStack(alignment: .leading, spacing: 6) {
                                        Text(l.name(group.name, group.nameAr)).font(.headline)
                                        Text(l.text("choose_options") + " \(group.minSelect)–\(group.maxSelect)").font(.subheadline)
                                    }
                                    Spacer()
                                    StatusBadge(text: l.text(group.minSelect > 0 ? "required" : "optional"), symbol: group.minSelect > 0 ? "checklist" : "plus.circle")
                                }
                                ForEach(group.options.filter(\.isAvailable)) { option in
                                    let selection = ModifierSelection(groupId: group.id, optionId: option.id)
                                    Toggle(isOn: Binding(get: { selections.contains(selection) }, set: { chosen in
                                        if !chosen { selections.remove(selection) }
                                        else if group.maxSelect == 1 { selections = selections.filter { $0.groupId != group.id }; selections.insert(selection) }
                                        else if selections.filter({ $0.groupId == group.id }).count < group.maxSelect { selections.insert(selection) }
                                    })) {
                                        VStack(alignment: .leading, spacing: 5) {
                                            Text(l.name(option.name, option.nameAr)).font(.body.weight(.medium))
                                            Text(Money.text(option.priceDeltaMinor, currency: product.currency)).font(.subheadline.monospacedDigit()).foregroundStyle(Design.accent)
                                        }
                                    }.padding(14).frame(minHeight: 60).background(selections.contains(selection) ? Design.accent.opacity(0.07) : Design.canvas, in: RoundedRectangle(cornerRadius: 14))
                                }
                            }
                        }
                    }
                    ResutoCard {
                        VStack(alignment: .leading, spacing: 12) {
                            Label(l.text("notes"), systemImage: "text.alignleading").font(.headline)
                            TextField(l.text("notes"), text: $notes, axis: .vertical).lineLimit(2...4).textFieldStyle(.roundedBorder)
                            Text("\(notes.utf16.count)/200").font(.subheadline.monospacedDigit()).foregroundStyle(notes.utf16.count > 200 ? Color.red : .secondary)
                        }
                    }
                }.padding(24)
            }.background(Design.canvas).safeAreaInset(edge: .bottom, spacing: 0) {
                VStack(spacing: 12) {
                    if let estimate { HStack { Text(l.text("item_estimate")).font(.subheadline); Spacer(); Text(Money.text(estimate, currency: product.currency)).font(.title3.bold().monospacedDigit()) } }
                    Button(l.text("add_to_order")) {
                        if let index = editingIndex, m.cart.indices.contains(index) { m.cart[index] = line; m.persistDraft() } else { m.add(line) }; dismiss()
                    }.buttonStyle(PrimaryActionStyle()).disabled(!valid).accessibilityIdentifier("product.add")
                }.padding(20).modifier(ActionChrome())
            }.navigationTitle(l.text("customize")).navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button(l.text("cancel")) { dismiss() } } }
        }.onAppear {
            if let index = editingIndex, m.cart.indices.contains(index) { let line = m.cart[index]; selections = Set(line.modifiers); notes = line.notes ?? ""; quantity = line.quantity; return }
            selections = Set(groups.flatMap { group in group.options.filter { $0.isDefault && $0.isAvailable }.prefix(group.maxSelect).map { ModifierSelection(groupId: group.id, optionId: $0.id) } })
        }
    }
}
