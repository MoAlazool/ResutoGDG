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
                        let soldOut = product.branchSettings.first(where: { $0.branchId == branch.id })?.soldOut == true
                        HStack(spacing:20) {
                            VStack(alignment:.leading,spacing:5) {
                                Text(l.name(product.name,product.nameAr)).font(.headline)
                                Text(l.text(soldOut ? "temporarily_sold_out" : "available")).font(.subheadline).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button(l.text(soldOut ? "restore_availability" : "mark_sold_out")) {
                                Task { await m.perform { try await m.setAvailability(product:product.id,available:soldOut) } }
                            }.buttonStyle(.bordered).frame(minHeight:44).disabled(!m.reachable || m.busy)
                                .accessibilityIdentifier("availability." + product.id)
                        }.padding(.vertical,8)
                    }
                }
            } else { EmptyState(key:"empty_menu",symbol:"menucard") }
        }
    }
}
