import SwiftUI

struct MenuView: View {
    @EnvironmentObject var m: POSModel
    @EnvironmentObject var l: Language
    @Environment(\.dynamicTypeSize) private var textSize
    @State private var search = ""
    @State private var category: String?
    @State private var product: Product?
    @State private var cartOpen = false
    var chooseTable: () -> Void = {}
    var body: some View {
        Group {
            if !m.can("menu:read") { EmptyState(key: "permission_denied", symbol: "lock") }
            else if let menu = m.menu {
                GeometryReader { geometry in
                    if geometry.size.width >= 760 && geometry.size.width > geometry.size.height && !textSize.isAccessibilitySize {
                        HStack(spacing: 0) { catalogue(menu); Divider(); CartView(chooseTable: chooseTable).frame(width: 350) }
                    } else {
                        catalogue(menu).safeAreaInset(edge: .bottom, spacing: 0) {
                            Button { cartOpen = true } label: {
                                HStack { Label(l.text("cart"), systemImage: "basket"); Text("\(m.cart.reduce(0) { $0 + $1.quantity })").monospacedDigit(); Spacer(); Image(systemName: "chevron.up") }
                            }.buttonStyle(PrimaryActionStyle()).padding(16).modifier(ActionChrome()).accessibilityIdentifier("cart.open")
                        }
                    }
                }
            } else { EmptyState(key: "empty_menu", symbol: "menucard") }
        }.background(Design.canvas).sheet(item: $product) { ProductView(product: $0) }
            .sheet(isPresented: $cartOpen) {
                ResutoNavigationStack { CartView(chooseTable: { cartOpen = false; chooseTable() }).navigationTitle(l.text("cart")).toolbar { Button(l.text("done")) { cartOpen = false } } }
            }
    }
    private func catalogue(_ menu: Menu) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 12) {
                Image(systemName: "magnifyingglass").foregroundStyle(Design.accent)
                TextField(l.text("search_menu"), text: $search).accessibilityIdentifier("menuSearch")
                if !search.isEmpty { Button { search = "" } label: { Image(systemName: "xmark.circle.fill").frame(minWidth: 44, minHeight: 44) }.accessibilityLabel(l.text("clear_search")) }
            }.padding(.horizontal, 16).frame(minHeight: 52).background(Design.surface, in: RoundedRectangle(cornerRadius: 16)).overlay { RoundedRectangle(cornerRadius: 16).strokeBorder(Design.border) }.padding(20)
            ScrollView(.horizontal) {
                HStack(spacing: 10) {
                    categoryButton(l.text("all"), id: nil)
                    ForEach(menu.categories(branch: m.branch?.id ?? "")) { item in categoryButton(l.name(item.name, item.nameAr), id: item.id) }
                }.padding(.horizontal, 20).padding(.bottom, 16)
            }.scrollIndicators(.hidden)
            let products = menu.products(branch: m.branch?.id ?? "").filter { item in
                item.isActive && (category == nil || item.categoryId == category) && (search.isEmpty || item.name.localizedCaseInsensitiveContains(search) || (item.nameAr?.localizedCaseInsensitiveContains(search) ?? false))
            }
            if products.isEmpty { EmptyState(key: "empty_menu", symbol: "magnifyingglass") }
            ScrollView {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: textSize.isAccessibilitySize ? 260 : 172, maximum: 320), spacing: 16)], spacing: 16) {
                    ForEach(products) { item in
                        Button { product = item } label: {
                            VStack(alignment: .leading, spacing: 12) {
                                AsyncImage(url: item.imageUrl.flatMap(URL.init(string:))) { image in image.resizable().scaledToFill() } placeholder: {
                                    ZStack { Design.accent.opacity(0.07); Image(systemName: "fork.knife").font(.system(size: 32, weight: .light)).foregroundStyle(Design.accent) }
                                }.frame(height: 112).frame(maxWidth: .infinity).clipped().clipShape(RoundedRectangle(cornerRadius: 14)).accessibilityHidden(true)
                                Text(l.name(item.name, item.nameAr)).font(.headline).foregroundStyle(.primary).lineLimit(2).frame(maxWidth: .infinity, minHeight: 44, alignment: .topLeading)
                                HStack(alignment: .firstTextBaseline) {
                                    Text(item.available(branch: m.branch?.id ?? "") ? Money.text(item.price(branch: m.branch?.id ?? ""), currency: menu.currency) : l.text("sold_out")).font(.body.weight(.semibold).monospacedDigit()).foregroundStyle(Design.accent)
                                    Spacer(minLength: 0)
                                    Image(systemName: "plus.circle.fill").foregroundStyle(Design.accent).accessibilityHidden(true)
                                }
                            }.padding(14).background(Design.surface, in: RoundedRectangle(cornerRadius: 22)).overlay { RoundedRectangle(cornerRadius: 22).strokeBorder(Design.border) }.contentShape(RoundedRectangle(cornerRadius: 22))
                        }.buttonStyle(.plain).accessibilityIdentifier("product." + item.id).disabled(!item.available(branch: m.branch?.id ?? "") || !m.can("orders:write"))
                    }
                }.padding(.horizontal, 20).padding(.bottom, 24)
            }
        }
    }
    private func categoryButton(_ title: String, id: String?) -> some View {
        Button { category = id } label: {
            Text(title).font(.body.weight(category == id ? .semibold : .medium)).padding(.horizontal, 18).frame(minHeight: 48)
                .foregroundStyle(category == id ? Color(uiColor: .systemBackground) : .primary)
                .background(category == id ? Design.accent : Design.surface, in: Capsule())
                .overlay { Capsule().strokeBorder(category == id ? Color.clear : Design.border) }
        }.buttonStyle(.plain).accessibilityAddTraits(category == id ? .isSelected : [])
    }
}
