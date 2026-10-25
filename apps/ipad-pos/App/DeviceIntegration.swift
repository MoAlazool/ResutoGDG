import SwiftUI
import CryptoKit

/// Migration stage 1: dual-credential device reads alongside the working staff client. Never writes orders/payments.
@MainActor final class DeviceIntegration: ObservableObject {
    @Published private(set) var binding: DeviceBinding?
    @Published private(set) var session: POSSession?
    @Published private(set) var snapshot: POSShadowSync.Snapshot?
    @Published private(set) var issue: String?
    @Published private(set) var connecting = false
    private var client: POSClient?
    private var devices: DeviceCredentialStore?
    private var membership: Membership?
    private var configuration: Configuration?
    private var shadow: POSShadowSync?
    private var files: [URL] = []
    private var worker: Task<Void,Never>?
    private var revision = UUID()
    private var foreground = true

    func attach(configuration: Configuration, auth: AuthService, scope: Scope, membership: Membership) async {
        detach(); self.configuration = configuration; self.membership = membership
        do {
            let devices = DeviceCredentialStore(secrets:KeychainStore(namespace:configuration.namespace)); self.devices = devices
            client = try POSClient(base:configuration.apiURL,auth:auth,devices:devices,transport:transport(),scope:scope)
            binding = try await devices.binding()
            if let binding, binding.orgId != scope.orgId || binding.branchId != scope.branchId { issue = "pos_context_mismatch"; return }
            resume()
        } catch { issue = FailurePresentation(error).key }
    }
    private func transport() -> any HTTPTransport {
#if DEBUG && targetEnvironment(simulator)
        // Reuse the app's explicit simulator test transport; never manufacture a second synthetic server instance.
        if let testTransport { return testTransport }
#endif
        return RejectRedirects.transport()
    }
#if DEBUG && targetEnvironment(simulator)
    var testTransport: (any HTTPTransport)?
#endif
    func pair(code: String) async {
        guard let client, let devices else { issue = "session_expired"; return }
        stopWorker(); shadow = nil; session = nil; snapshot = nil; files = []
        let identity = revision; issue = nil; connecting = true
        defer { connecting = false }
        do {
            try await client.pair(code:code,appVersion:Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.1.0")
            guard identity == revision, foreground else { return }
            binding = try await devices.binding()
            try await prepare()
            resume()
        } catch {
            binding = try? await devices.binding()
            session = nil; snapshot = nil
            issue = error is URLError ? "pairing_ambiguous" : ((error as? APIError)?.status == 404 ? "pos_backend_pending" : FailurePresentation(error).key)
        }
    }
    private func prepare() async throws {
        guard let client, let membership, let configuration else { throw RuleError.invalid("session_expired") }
        let identity = revision
        let verified = try await client.session(membership:membership)
        guard identity == revision, !Task.isCancelled else { throw CancellationError() }
        session = verified
        if shadow == nil {
            let identityString = client.scope.storageIdentity + ":" + verified.device.id
            let digest = SHA256.hash(data:Data(identityString.utf8)).map { String(format:"%02x",$0) }.joined()
            let namespace = configuration.namespace + ".pos." + digest
            let projections = try EncryptedStore(name:"projections",namespace:namespace), cursor = try EncryptedStore(name:"events",namespace:namespace)
            files = [projections.url,cursor.url]
            let journal = try POSEventJournal(scope:client.scope,deviceId:verified.device.id,storage:cursor)
            shadow = try POSShadowSync(client:client,membership:membership,deviceId:verified.device.id,journal:journal,storage:projections)
        }
    }
    func resume() {
        foreground = true
        guard worker == nil, client != nil, devices != nil, issue != "pos_context_mismatch" else { return }
        let identity = revision
        worker = Task { [weak self] in
            var failures = 0
            do {
                if let self, let devices = self.devices, let client = self.client {
                    let binding = try await devices.binding()
                    guard identity == self.revision, !Task.isCancelled else { return }
                    self.binding = binding
                    guard let binding else { self.worker = nil; return }
                    guard binding.orgId == client.scope.orgId, binding.branchId == client.scope.branchId else {
                        self.issue = "pos_context_mismatch"; self.worker = nil; return
                    }
                }
            } catch {
                if let self, identity == self.revision { self.issue = FailurePresentation(error).key; self.worker = nil }; return
            }
            while !Task.isCancelled {
                guard let self, self.foreground, identity == self.revision else { break }
                do {
                    self.connecting = self.session == nil
                    try await self.prepare()
                    guard let shadow = self.shadow else { break }
                    try await shadow.poll(wait:25)
                    let value = await shadow.current()
                    guard !Task.isCancelled, identity == self.revision else { break }
                    self.snapshot = value; self.issue = nil; self.connecting = false; failures = 0
                    // Bounded pacing also protects fixtures/fast empty feeds from a tight loop.
                    try await Task.sleep(for:.seconds(1))
                } catch is CancellationError { break }
                catch {
                    guard !Task.isCancelled, identity == self.revision else { break }
                    self.connecting = false
                    let failure = error as? APIError
                    if failure?.code == "device_revoked" || failure?.code == "device_expired" {
                        self.binding = nil; self.session = nil; self.snapshot = nil; self.shadow = nil; self.files = []; self.issue = "pos_pairing_required"; break
                    }
                    self.issue = failure?.status == 404 ? "pos_backend_pending" : FailurePresentation(error).key
                    if failure?.status == 401 || failure?.status == 403 ||
                        (error as? RuleError) == .invalid("pos_context_mismatch") || (error as? RuleError) == .invalid("pos_staff_contract_required") {
                        self.session = nil; self.snapshot = nil; self.shadow = nil; break
                    }
                    failures += 1
                    do { try await Task.sleep(for:.seconds(min(60,pow(2,Double(min(failures,5)))))) } catch { break }
                }
            }
            if let self, identity == self.revision { self.worker = nil; self.connecting = false }
        }
    }
    private func stopWorker() { revision = UUID(); worker?.cancel(); worker = nil; connecting = false }
    func pause() { foreground = false; stopWorker() }
    func detach() {
        pause(); client = nil; devices = nil; membership = nil; configuration = nil; shadow = nil
        binding = nil; session = nil; snapshot = nil; issue = nil; files = []
    }
    func forget() async {
        let interrupted = worker
        stopWorker()
        // Join the cancelled poll before deleting files; an atomic write already in progress must finish first.
        await interrupted?.value
        do {
            try await devices?.remove()
            for file in files where FileManager.default.fileExists(atPath:file.path) { try FileManager.default.removeItem(at:file) }
            binding = nil; session = nil; shadow = nil; snapshot = nil; issue = nil; files = []
        } catch { issue = FailurePresentation(error).key }
    }
}
