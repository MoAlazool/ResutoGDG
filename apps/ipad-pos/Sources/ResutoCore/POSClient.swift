import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Separate from the staff session: staff switching must not unpair a shared iPad.
/// The application supplies KeychainStore(namespace: Configuration.namespace).
public actor DeviceCredentialStore {
    private struct Credential: Codable { let token: String; let orgId: String; let branchId: String; let deviceId: String }
    private let secrets: any SecretStore
    public init(secrets: any SecretStore) { self.secrets = secrets }
    public func save(_ pair: POSPairResult, scope: Scope) throws {
        guard pair.contractVersion == "0.2.0", pair.device.requireStaff == true else { throw RuleError.invalid("pos_staff_contract_required") }
        guard pair.orgId == scope.orgId, pair.device.branchId == scope.branchId,
              pair.device.status == "active", !pair.device.expired,
              pair.token.range(of: "^rpos_[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else { throw RuleError.invalid("pos_context_mismatch") }
        try secrets.write(JSONEncoder().encode(Credential(token:pair.token,orgId:pair.orgId,branchId:pair.device.branchId,deviceId:pair.device.id)), key:"paired-device")
    }
    func token(scope: Scope) throws -> String {
        guard let data = try secrets.read("paired-device") else { throw RuleError.invalid("pos_pairing_required") }
        let credential = try JSONDecoder().decode(Credential.self,from:data)
        guard credential.orgId == scope.orgId, credential.branchId == scope.branchId else { throw RuleError.invalid("pos_context_mismatch") }
        return credential.token
    }
    public func remove() throws { try secrets.remove("paired-device") }
}
/// Draft compatibility adapter. Not selected by the live app until the documented shadow migration gate passes.
public actor POSClient {
    private let base: URL; private let auth: AuthService; private let devices: DeviceCredentialStore; private let transport: any HTTPTransport
    public let scope: Scope
    public init(base: URL, auth: AuthService, devices: DeviceCredentialStore, transport: any HTTPTransport, scope: Scope) throws {
        guard base.scheme == "https", base.path == "/v1", base.host != nil, base.user == nil, base.password == nil,
              base.query == nil, base.fragment == nil, scope.environment == base.absoluteString else { throw RuleError.invalid("https_required") }
        self.base = base; self.auth = auth; self.devices = devices; self.transport = transport; self.scope = scope
    }
    public func pair(code: String, appVersion: String) async throws {
        let cleaned = code.uppercased().filter { !$0.isWhitespace && $0 != "-" }
        guard cleaned.count == 10, cleaned.allSatisfy({ "0123456789ABCDEFGHJKMNPQRSTVWXYZ".contains($0) }), appVersion.utf16.count <= 40 else { throw RuleError.invalid("pos_pairing_code_invalid") }
        struct Pair: Encodable { let code: String; let platform = "ipados"; let appVersion: String }
        var request = URLRequest(url:base.appendingPathComponent("pos/pair")); request.httpMethod = "POST"; request.timeoutInterval = 30
        request.httpBody = try JSONEncoder().encode(Pair(code:cleaned,appVersion:appVersion))
        request.setValue("application/json",forHTTPHeaderField:"Content-Type"); request.setValue(UUID().uuidString,forHTTPHeaderField:"X-Request-ID")
        let result = try await transport.send(request)
        let paired: POSPairResult = try decode(result)
        try await devices.save(paired,scope:scope)
    }
    public func session(membership: Membership) async throws -> POSSession {
        let value: POSSession = try await get("session")
        try value.validate(scope:scope,membership:membership); return value
    }
    public func get<T: Decodable & Sendable>(_ path: String, query: [String:String] = [:]) async throws -> T {
        try await send(path,method:"GET",query:query,body:nil)
    }
    public func post<B: Encodable & Sendable,T: Decodable & Sendable>(_ path: String, body: B) async throws -> T {
        try await send(path,method:"POST",query:[:],body:JSONEncoder().encode(body))
    }
    private func send<T: Decodable>(_ path: String, method: String, query: [String:String], body: Data?) async throws -> T {
        let parts = path.split(separator:"/",omittingEmptySubsequences:false)
        let roots: Set<String> = ["session","events","sync","orders","kitchen","print-jobs"]
        guard let first = parts.first, roots.contains(String(first)), parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }),
              !path.contains(":"), !path.contains("?"), !path.contains("#"), !path.contains("%"), !path.contains("\\") else { throw RuleError.invalid("invalid_path") }
        var components = URLComponents(url:base.appendingPathComponent("pos/" + path),resolvingAgainstBaseURL:false)!
        components.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name:$0.key,value:$0.value) }
        for attempt in 0...1 {
            var request = URLRequest(url:components.url!); request.httpMethod = method; request.httpBody = body; request.timeoutInterval = 35
            request.setValue("Bearer \(try await devices.token(scope:scope))",forHTTPHeaderField:"Authorization")
            request.setValue("Bearer \(try await auth.token())",forHTTPHeaderField:"X-Resuto-Staff-Authorization")
            request.setValue(UUID().uuidString,forHTTPHeaderField:"X-Request-ID"); request.setValue("application/json",forHTTPHeaderField:"Accept")
            if body != nil { request.setValue("application/json",forHTTPHeaderField:"Content-Type") }
            let result = try await transport.send(request)
            let failure = try? JSONDecoder().decode(APIErrorEnvelope.self,from:result.data).error
            if result.status == 401, ["device_revoked","device_expired"].contains(failure?.code ?? "") { try await devices.remove() }
            if result.status == 401, failure?.code == "unauthorized", method == "GET", attempt == 0 { await auth.invalidateAccessToken(); continue }
            return try decode(result)
        }
        throw RuleError.invalid("session_expired")
    }
    private func decode<T: Decodable>(_ result: HTTPResult) throws -> T {
        guard (200..<300).contains(result.status) else {
            let error = try? JSONDecoder().decode(APIErrorEnvelope.self,from:result.data).error
            throw APIError(status:result.status,code:error?.code ?? "http_error",message:error?.message ?? "request_failed",requestId:error?.requestId,retryAfter:result.headers["retry-after"].flatMap(Double.init),details:error?.details)
        }
        return try JSONDecoder().decode(T.self,from:result.data)
    }
}
