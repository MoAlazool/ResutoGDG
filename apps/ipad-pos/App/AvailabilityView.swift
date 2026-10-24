import SwiftUI

struct AvailabilityView: View {
    @EnvironmentObject var m: POSModel
    @EnvironmentObject var l: Language
    var body: some View {
        Group {
            if !m.can("menu:availability") { EmptyState(key:"permission_denied",symbol:"lock") }
            else if let branch = m.branch, let menu = m.menu {
                List {
                    Text(l.text("availability_notice")).font(.subheadline).foregroundStyle(.secondary)
                    ForEach(menu.products(branch:branch.id).filter { $0.branchSettings.first(where: { $0.branchId == branch.id })?.isAvailable != false }) { product in
                        Toggle(isOn:Binding(get:{ product.branchSettings.first(where: { $0.branchId == branch.id })?.soldOut == true },set:{ soldOut in
                            Task { await m.perform { try await m.setAvailability(product:product.id,available:!soldOut) } }
                        })) {
                            VStack(alignment:.leading,spacing:5) {
                                Text(l.name(product.name,product.nameAr)).font(.headline)
                                Text(l.text("temporarily_sold_out")).font(.subheadline).foregroundStyle(.secondary)
                            }.padding(.vertical,8)
                        }.disabled(!m.reachable || m.busy).accessibilityIdentifier("availability." + product.id)
                    }
                }
            } else { EmptyState(key:"empty_menu",symbol:"menucard") }
        }
    }
}
