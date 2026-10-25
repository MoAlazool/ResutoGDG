import SwiftUI

struct CustomerPicker: View {
    @EnvironmentObject var m: POSModel
    @EnvironmentObject var l: Language
    @Environment(\.dismiss) var dismiss
    @State private var query = ""
    @State private var results: [Customer] = []
    @State private var loading = false
    @State private var issue: String?
    var body: some View {
        ResutoNavigationStack {
            List {
                if loading { ProgressView() }
                if let issue { Text(l.failureText(issue)).foregroundStyle(.orange) }
                if results.isEmpty && !loading { EmptyState(key: "empty_customers", symbol: "person.crop.circle.badge.questionmark") }
                ForEach(results) { customer in
                    Button {
                        m.customerId = customer.id; m.customerName = customer.displayName ?? customer.phone ?? l.text("customer"); m.persistDraft(); dismiss()
                    } label: {
                        VStack(alignment: .leading, spacing: 5) { Text(customer.displayName ?? l.text("customer")).font(.headline); if let phone = customer.phone { Text(Money.western(phone)).font(.subheadline).foregroundStyle(.secondary).environment(\.layoutDirection, .leftToRight) } }.padding(.vertical, 8)
                    }
                }
            }.searchable(text: $query, prompt: l.text("search_customers")).navigationTitle(l.text("customer"))
                .toolbar { Button(l.text("cancel")) { dismiss() } }
                .task(id: query) {
                    results = []; issue = nil
                    guard query.trimmingCharacters(in: .whitespaces).count >= 2 else { return }
                    do {
                        try await Task.sleep(for: .milliseconds(300)); loading = true; defer { loading = false }
                        let values = try await m.customers(query: query); try Task.checkCancellation(); results = values
                    } catch is CancellationError { } catch { issue = FailurePresentation(error).key }
                }
        }
    }
}
struct ReservationsView: View {
    @EnvironmentObject var m: POSModel
    @EnvironmentObject var l: Language
    @State private var date = Date()
    @State private var selected: ReservationRecord?
    @State private var table = ""
    var body: some View {
        List {
            DatePicker(l.text("date"), selection: $date, displayedComponents: .date)
                .environment(\.timeZone, BusinessDate.timezone(branch:m.branch?.timezone,restaurant:m.restaurant?.timezone))
            if m.reservations.isEmpty { EmptyState(key: "empty_reservations", symbol: "calendar") }
            ForEach(m.reservations) { reservation in
                VStack(alignment: .leading, spacing: 10) {
                    HStack { Text(reservation.guestName).font(.headline); Spacer(); Text(l.text(reservation.status)).foregroundStyle(Design.accent) }
                    HStack { Text(reservation.code).monospaced(); Text("\(reservation.partySize) · \(l.text("people"))"); Text(reservation.tableLabel ?? l.text("table")) }.font(.subheadline).foregroundStyle(.secondary)
                    if let start = ServerDate.parse(reservation.startsAt) { Text(start, style: .time) }
                    if m.can("reservations:write"), ["confirmed", "held"].contains(reservation.status) {
                        Button(l.text("check_in")) { table = reservation.tableId ?? ""; selected = reservation }.disabled(!m.reachable)
                    }
                }.padding(.vertical, 10)
            }
        }.environment(\.timeZone,BusinessDate.timezone(branch:m.branch?.timezone,restaurant:m.restaurant?.timezone))
            .task(id: date) { await m.perform { try await m.loadReservations(date: date) } }
            .sheet(item: $selected) { reservation in
                ResutoNavigationStack {
                    Form {
                        Text(reservation.guestName).font(.title2)
                        Picker(l.text("table"), selection: $table) {
                            Text(l.text("select_table")).tag("")
                            ForEach(m.live?.tables ?? m.layout?.tables ?? []) { table in Text(table.label).tag(table.id) }
                        }
                        Button(l.text("check_in")) { Task { await m.perform { try await m.reservationCheckIn(reservation, tableId: table); try await m.loadReservations(date: date); selected = nil } } }.disabled(table.isEmpty || !m.reachable)
                    }.navigationTitle(l.text("check_in")).toolbar { Button(l.text("cancel")) { selected = nil } }
                }
            }
    }
}
