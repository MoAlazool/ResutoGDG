import SwiftUI

@main struct ResutoPOSApp: App {
    @StateObject private var model = POSModel()
    @StateObject private var language = Language()
    @Environment(\.scenePhase) private var phase
    var body: some Scene {
        WindowGroup {
            RootView().environmentObject(model).environmentObject(language)
                .environment(\.layoutDirection, language.arabic ? .rightToLeft : .leftToRight)
                .environment(\.locale, Locale(identifier: language.arabic ? "ar-u-nu-latn" : "en"))
                .tint(Design.accent)
                .overlay {
                    if phase != .active { ZStack { Design.canvas.ignoresSafeArea(); Image(systemName: "lock.shield.fill").font(.largeTitle).foregroundStyle(Design.accent) }.accessibilityHidden(true) }
                }
                .task { await model.restore() }
                .task(id: phase) {
                    guard phase == .active else { return }
                    while !Task.isCancelled {
                        if model.branch != nil && !model.busy && !model.locked {
                            do { try await model.refresh() } catch { model.handle(error) }
                        }
                        try? await Task.sleep(for: .seconds(5))
                    }
                }
                .onChange(of: phase) { _, value in if value != .active { model.persistDraft() } }
        }
    }
}
enum Design {
    static let accent = Color(uiColor: UIColor { trait in
        trait.userInterfaceStyle == .dark ? UIColor(red: 0.65, green: 0.84, blue: 0.73, alpha: 1) : UIColor(red: 0.086, green: 0.239, blue: 0.204, alpha: 1)
    })
    static let surface = Color(uiColor: .secondarySystemGroupedBackground)
    static let canvas = Color(uiColor: .systemGroupedBackground)
}
struct EmptyState: View {
    @EnvironmentObject var l: Language
    let key: String; let symbol: String
    var body: some View { ContentUnavailableView(l.text(key), systemImage: symbol).frame(maxWidth: .infinity, maxHeight: .infinity).accessibilityIdentifier(key) }
}
struct RootView: View {
    @EnvironmentObject var m: POSModel
    @EnvironmentObject var l: Language
    var body: some View {
        VStack(spacing: 0) {
            if let error = m.error {
                HStack { Image(systemName: "exclamationmark.triangle.fill"); Text(l.text(error)).textSelection(.enabled); Spacer(); Button { m.error = nil } label: { Image(systemName: "xmark") }.accessibilityLabel(l.text("close")) }
                    .padding().foregroundStyle(.primary).background(.orange.opacity(0.18)).accessibilityIdentifier("errorBanner")
            }
            if let notice = m.notice {
                HStack { Image(systemName: "checkmark.circle.fill"); Text(notice.replacingOccurrences(of: "accepted", with: l.text("accepted"))); Spacer(); Button { m.notice = nil } label: { Image(systemName: "xmark") }.accessibilityLabel(l.text("close")) }.padding().foregroundStyle(Design.accent).background(Design.accent.opacity(0.1))
            }
            if m.me == nil { SignInView() }
            else if m.locked {
                EmptyState(key: "session_expired", symbol: "lock.shield")
                Button(l.text("sign_out")) { Task { await m.signOut() } }.buttonStyle(.borderedProminent).padding()
            } else if m.branch == nil { WorkspaceSelection() }
            else { WorkspaceView() }
        }.background(Design.canvas)
            .overlay { if m.busy { ProgressView(l.text("loading")).padding(24).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16)).allowsHitTesting(true) } }
    }
}
struct SignInView: View {
    @EnvironmentObject var m: POSModel
    @EnvironmentObject var l: Language
    @State private var email = ""
    @State private var password = ""
    @State private var configuration = false
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Image(systemName: "fork.knife.circle.fill").font(.system(size: 64)).foregroundStyle(Design.accent)
                Text(l.text("welcome")).font(.largeTitle.bold())
                Text(l.text("welcome_detail")).font(.title3).foregroundStyle(.secondary)
                VStack(spacing: 16) {
                    TextField(l.text("email"), text: $email).textContentType(.username).keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled().accessibilityIdentifier("email")
                    SecureField(l.text("password"), text: $password).textContentType(.password).accessibilityIdentifier("password")
                }.textFieldStyle(.roundedBorder).controlSize(.large)
                Button(l.text("sign_in")) {
                    let credential = password; password = ""
                    Task { await m.perform { try await m.signIn(email: email.trimmingCharacters(in: .whitespaces), password: credential) } }
                }.buttonStyle(.borderedProminent).controlSize(.large).disabled(email.isEmpty || password.isEmpty || m.configuration == nil).keyboardShortcut(.defaultAction).accessibilityIdentifier("signIn")
                Button(l.text("configure")) { configuration = true }.frame(minHeight: 44)
                Toggle("العربية", isOn: $l.arabic)
            }.padding(36).frame(maxWidth: 520).background(Design.surface, in: RoundedRectangle(cornerRadius: 28)).padding(36).frame(maxWidth: .infinity)
        }.sheet(isPresented: $configuration) { ConfigurationView() }
    }
}
struct ConfigurationView: View {
    @EnvironmentObject var m: POSModel
    @EnvironmentObject var l: Language
    @Environment(\.dismiss) var dismiss
    @State private var api = "https://resuto-2-staging-api.onrender.com/v1"
    @State private var supabase = ""
    @State private var key = ""
    var body: some View {
        NavigationStack {
            Form {
                Text(l.text("configuration_required"))
                TextField(l.text("api_url"), text: $api).accessibilityIdentifier("apiURL")
                TextField(l.text("supabase_url"), text: $supabase)
                TextField(l.text("public_key"), text: $key)
            }.textInputAutocapitalization(.never).autocorrectionDisabled()
                .navigationTitle(l.text("configuration"))
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button(l.text("cancel")) { dismiss() } }; ToolbarItem(placement: .confirmationAction) {
                    Button(l.text("save")) {
                        do { guard let apiURL = URL(string: api), let authURL = URL(string: supabase) else { throw RuleError.invalid("invalid_configuration") }; try m.configure(Configuration(apiURL: apiURL, supabaseURL: authURL, publicKey: key)); dismiss() } catch { m.handle(error) }
                    }
                } }
        }.onAppear { if let config = m.configuration { api = config.apiURL.absoluteString; supabase = config.supabaseURL.absoluteString; key = config.publicKey } }
    }
}
struct WorkspaceSelection: View {
    @EnvironmentObject var m: POSModel
    @EnvironmentObject var l: Language
    var body: some View {
        NavigationStack {
            List {
                Section(l.text("choose_restaurant")) {
                    ForEach(m.me?.memberships ?? []) { member in
                        Button { Task { await m.perform { try await m.choose(member) } } } label: {
                            HStack { Label(member.orgName, systemImage: "building.2"); Spacer(); Text(member.role).foregroundStyle(.secondary); if member.id == m.membership?.id { Image(systemName: "checkmark.circle.fill") } }.frame(minHeight: 48)
                        }
                    }
                }
                if let restaurant = m.restaurant {
                    Section(l.text("choose_branch")) {
                        ForEach(restaurant.branches.filter { $0.isActive && m.membership?.allows(branch: $0.id) == true }) { branch in
                            Button(l.name(branch.name, branch.nameAr)) { Task { await m.perform { try await m.choose(branch) } } }.frame(minHeight: 48)
                        }
                    }
                }
            }.navigationTitle(l.text("app"))
                .toolbar { Button(l.text("sign_out")) { Task { await m.signOut() } }; Button("العربية / English") { l.arabic.toggle() } }
        }
    }
}
enum Destination: String, CaseIterable, Identifiable {
    case pos, floor, orders, kitchen, reservations, history, sync, settings
    var id: String { rawValue }
    var symbol: String { switch self { case .pos: "square.grid.2x2"; case .floor: "square.split.2x2"; case .orders: "list.bullet.rectangle"; case .kitchen: "flame"; case .reservations: "calendar"; case .history: "clock"; case .sync: "arrow.triangle.2.circlepath"; case .settings: "gearshape" } }
    var permission: String? { switch self { case .pos: "menu:read"; case .floor: "floor:read"; case .orders, .history: "orders:read"; case .kitchen: "kitchen:operate"; case .reservations: "reservations:read"; default: nil } }
}
struct WorkspaceView: View {
    @EnvironmentObject var m: POSModel
    @EnvironmentObject var l: Language
    @State private var selected: Destination? = .pos
    var body: some View {
        NavigationSplitView {
            List(selection: $selected) {
                Section {
                    Text(m.restaurant?.name ?? "Resuto").font(.title2.bold())
                    Text(l.name(m.branch?.name ?? "", m.branch?.nameAr)).foregroundStyle(.secondary)
                }
                ForEach(Destination.allCases.filter { $0.permission == nil || m.can($0.permission!) }) { destination in
                    Label(l.text(destination.rawValue), systemImage: destination.symbol).frame(minHeight: 44).tag(destination)
                }
                Section {
                    Label(l.text(m.reachable ? "online" : "offline"), systemImage: m.reachable ? "wifi" : "wifi.slash").foregroundStyle(m.reachable ? Color.secondary : Color.orange)
                    Text("\(m.pending.filter { $0.state != .accepted }.count) · \(l.text("sync"))").monospacedDigit()
                    if let date = m.lastRefresh { Text(date, style: .time).font(.caption).foregroundStyle(.secondary) }
                }
            }.navigationTitle(l.text("app"))
        } detail: {
            NavigationStack {
                Group {
                    switch selected ?? .pos {
                    case .pos: MenuView()
                    case .floor: FloorView { selected = .pos }
                    case .orders: OrdersView(history: false)
                    case .history: OrdersView(history: true)
                    case .kitchen: KitchenView()
                    case .reservations: ReservationsView()
                    case .sync: SyncView()
                    case .settings: SettingsView()
                    }
                }.navigationTitle(l.text((selected ?? .pos).rawValue)).navigationBarTitleDisplayMode(.inline)
                    .toolbar { Button { Task { await m.perform { try await m.refresh() } } } label: { Label(l.text("refresh"), systemImage: "arrow.clockwise") }.disabled(!m.reachable).keyboardShortcut("r", modifiers: .command) }
            }
        }.sheet(item: $m.detail) { order in OrderView(order: order) }
    }
}
