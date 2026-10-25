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
                .onChange(of: phase) { _, value in if value != .active { model.persistDraft(); model.deviceIntegration.pause() } else { model.deviceIntegration.resume() } }
        }
    }
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
            if m.simulatedUITest { Text("SIMULATED UI TEST — NOT STAGING").font(.caption.bold()).padding(6).accessibilityIdentifier("simulatedTestBanner") }
            if let error = m.error {
                HStack { Image(systemName: "exclamationmark.triangle.fill"); VStack(alignment:.leading,spacing:4) { Text(l.failureText(error)); if let request = m.errorRequestId { Text(l.text("support_reference") + ": " + request).font(.caption.monospaced()).environment(\.layoutDirection,.leftToRight) } }.textSelection(.enabled); Spacer(); Button { m.error = nil; m.errorRequestId = nil } label: { Image(systemName: "xmark") }.accessibilityLabel(l.text("close")) }
                    .padding().foregroundStyle(.primary).background(.orange.opacity(0.18)).accessibilityIdentifier("errorBanner")
            }
            if let notice = m.notice {
                HStack { Image(systemName: "checkmark.circle.fill"); Text(notice.replacingOccurrences(of: "accepted", with: l.text("sync_accepted"))); Spacer(); Button { m.notice = nil } label: { Image(systemName: "xmark") }.accessibilityLabel(l.text("close")) }.padding().foregroundStyle(Design.accent).background(Design.accent.opacity(0.1))
            }
            if m.me == nil { SignInView() }
            else if m.locked {
                EmptyState(key: "session_expired", symbol: "lock.shield")
                Button(l.text("sign_out")) { Task { await m.signOut() } }.buttonStyle(.borderedProminent).padding()
            } else if m.branch == nil { WorkspaceSelection() }
            else { WorkspaceView() }
        }.background(Design.canvas).disabled(m.busy)
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
        GeometryReader { geometry in
            ScrollView {
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .center, spacing: 56) { introduction.frame(width: 350); credentials.frame(width: 440) }.padding(48)
                    VStack(alignment: .leading, spacing: 28) { introduction; credentials }.frame(maxWidth: 480).padding(28)
                }.frame(maxWidth: .infinity, minHeight: geometry.size.height)
            }.scrollDismissesKeyboard(.interactively)
        }.background(Design.canvas).sheet(isPresented: $configuration) { ConfigurationView() }
    }
    private var introduction: some View {
        VStack(alignment: .leading, spacing: 24) {
            Image(systemName: "fork.knife.circle.fill").font(.system(size: 64)).foregroundStyle(Design.accent).accessibilityHidden(true)
            Text("Resuto").font(.system(.largeTitle, design: .rounded, weight: .bold))
            Text(l.text("welcome")).font(.title.bold())
            Text(l.text("welcome_detail")).font(.title3).foregroundStyle(.primary).fixedSize(horizontal: false, vertical: true)
            Label(l.text("staff_access_notice"), systemImage: "lock.shield").font(.body).fixedSize(horizontal: false, vertical: true)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
    private var credentials: some View {
        ResutoCard(padding: 28) {
            VStack(alignment: .leading, spacing: 22) {
                Text(l.text("staff_sign_in")).font(.title2.bold())
                VStack(alignment: .leading, spacing: 10) {
                    Text(l.text("email")).font(.headline)
                    TextField(l.text("email"), text: $email).textContentType(.username).keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled().environment(\.layoutDirection, .leftToRight).accessibilityIdentifier("email").accessibilityLabel(l.text("email"))
                }
                VStack(alignment: .leading, spacing: 10) {
                    Text(l.text("password")).font(.headline)
                    SecureField(l.text("password"), text: $password).textContentType(.password).accessibilityIdentifier("password").accessibilityLabel(l.text("password"))
                }
                Button(l.text("sign_in")) {
                    let credential = password; password = ""
                    Task { await m.perform { try await m.signIn(email: email.trimmingCharacters(in: .whitespaces), password: credential) } }
                }.buttonStyle(PrimaryActionStyle()).disabled(email.isEmpty || password.isEmpty || m.configuration == nil).keyboardShortcut(.defaultAction).accessibilityIdentifier("signIn")
                Divider()
                Button(l.text("configure")) { configuration = true }.frame(minHeight: 44)
                Toggle("العربية / English", isOn: $l.arabic).frame(minHeight: 44)
            }.textFieldStyle(.roundedBorder).controlSize(.large)
        }

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
        ResutoNavigationStack {
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
        ResutoNavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    VStack(alignment: .leading, spacing: 10) {
                        Text(l.text("choose_workspace")).font(.largeTitle.bold())
                        Text(l.text("workspace_notice")).font(.title3).fixedSize(horizontal: false, vertical: true)
                    }
                    Text(l.text("choose_restaurant")).font(.title2.bold())
                    ForEach(m.me?.memberships ?? []) { member in
                        Button { Task { await m.perform { try await m.choose(member) } } } label: {
                            ResutoCard {
                                HStack(spacing: 18) {
                                    Image(systemName: "building.2").font(.title2).foregroundStyle(Design.accent)
                                    VStack(alignment: .leading, spacing: 8) { Text(member.orgName).font(.headline); Text(l.text("role_" + member.role)).font(.body) }
                                    Spacer()
                                    Image(systemName: member.id == m.membership?.id ? "checkmark.circle.fill" : "chevron.forward").font(.title3).foregroundStyle(Design.accent)
                                }.frame(minHeight: 56)
                            }
                        }.buttonStyle(.plain).accessibilityIdentifier("restaurant." + member.id)
                    }
                    if let restaurant = m.restaurant {
                        Text(l.text("choose_branch")).font(.title2.bold())
                        ForEach(restaurant.branches.filter { $0.isActive && m.membership?.allows(branch: $0.id) == true }) { branch in
                            Button { Task { await m.perform { try await m.choose(branch) } } } label: {
                                ResutoCard { HStack(spacing: 18) { Image(systemName: "mappin.circle").font(.title2).foregroundStyle(Design.accent); Text(l.name(branch.name, branch.nameAr)).font(.headline); Spacer(); Image(systemName: "arrow.forward").foregroundStyle(Design.accent) }.frame(minHeight: 56) }
                            }.buttonStyle(.plain).accessibilityIdentifier("branch." + branch.id)
                        }
                    }
                }.padding(32).frame(maxWidth: 840).frame(maxWidth: .infinity)
            }.background(Design.canvas).navigationTitle(l.text("app"))
                .toolbar { Button(l.text("sign_out")) { Task { await m.signOut() } }; Button("العربية / English") { l.arabic.toggle() } }
        }
    }
}
enum Destination: String, CaseIterable, Identifiable {
    case pos, floor, orders, kitchen, availability, reservations, history, sync, settings
    var id: String { rawValue }
    var symbol: String { switch self { case .pos: "square.grid.2x2"; case .floor: "square.split.2x2"; case .orders: "list.bullet.rectangle"; case .kitchen: "flame"; case .availability: "checkmark.circle"; case .reservations: "calendar"; case .history: "clock"; case .sync: "arrow.triangle.2.circlepath"; case .settings: "gearshape" } }
    var permission: String? { switch self { case .pos: "menu:read"; case .floor: "floor:read"; case .orders, .history: "orders:read"; case .kitchen: "kitchen:operate"; case .availability: "menu:availability"; case .reservations: "reservations:read"; default: nil } }
}
struct WorkspaceView: View {
    @EnvironmentObject var m: POSModel
    @EnvironmentObject var l: Language
    @State private var selected: Destination? = .pos
    var body: some View {
        NavigationSplitView {
            List(selection: $selected) {
                Section {
                    Text(m.restaurant?.name ?? "Resuto").font(.headline).foregroundStyle(.primary)
                    Label(l.name(m.branch?.name ?? "", m.branch?.nameAr), systemImage: "mappin.circle").font(.subheadline).foregroundStyle(.primary)
                }
                ForEach(Destination.allCases.filter { $0.permission == nil || m.can($0.permission!) }) { destination in
                    Button { selected = destination } label: {
                        Label(l.text(destination.rawValue), systemImage: destination.symbol)
                            .font(.body.weight(selected == destination ? .semibold : .regular)).frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                    }.buttonStyle(.plain).accessibilityElement(children: .combine)
                        .accessibilityIdentifier("nav." + destination.rawValue)
                        .accessibilityAddTraits(selected == destination ? .isSelected : [])
                        .listRowBackground(selected == destination ? Design.accent.opacity(0.08) : Color.clear)
                }
                Section {
                    Label(l.text(m.reachable ? "online" : "offline"), systemImage: m.reachable ? "wifi" : "wifi.slash").foregroundStyle(m.reachable ? Color.secondary : Color.orange)
                    Text("\(m.pending.filter { $0.state != .accepted }.count) · \(l.text("sync"))").monospacedDigit()
                    if let date = m.lastRefresh { Text(date, style: .time).font(.caption).foregroundStyle(.secondary) }
                }
            }.navigationTitle(l.text("app")).navigationSplitViewColumnWidth(min: 220, ideal: 248, max: 280).accessibilityIdentifier("workspace.sidebar")
        } detail: {
            ResutoNavigationStack {
                Group {
                    switch selected ?? .pos {
                    case .pos: MenuView(chooseTable: { selected = .floor })
                    case .floor: FloorView { selected = .pos }
                    case .orders: OrdersView(history: false)
                    case .history: OrdersView(history: true)
                    case .kitchen: KitchenView()
                    case .availability: AvailabilityView()
                    case .reservations: ReservationsView()
                    case .sync: SyncView()
                    case .settings: SettingsView()
                    }
                }.navigationTitle(l.text((selected ?? .pos).rawValue)).navigationBarTitleDisplayMode(.inline)
                    .toolbar { Button { Task { await m.perform { try await m.refresh() } } } label: { Label(l.text("refresh"), systemImage: "arrow.clockwise") }.disabled(!m.reachable).keyboardShortcut("r", modifiers: .command)
                        Button { selected = .settings } label: { Label(l.text("settings"),systemImage:"gearshape") }.accessibilityIdentifier("workspace.settings")
                    }
            }
        }.onAppear {
            // Choose an initial destination from membership hints while branch identity validation is loading.
            // Operational controls still require the scoped lease through m.can and the backend guard.
            if m.membership?.role == "kitchen" { selected = .kitchen }
            else if m.membership?.can("orders:write") == true { selected = .pos }
            else if m.membership?.can("floor:read") == true { selected = .floor }
            else if m.membership?.can("orders:read") == true { selected = .orders }
            else { selected = .settings }
        }.sheet(item: $m.detail) { order in OrderView(order: order) }
    }
}
