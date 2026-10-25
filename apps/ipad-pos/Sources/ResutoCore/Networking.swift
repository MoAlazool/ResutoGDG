import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct HTTPResult: Sendable {
    public let data: Data; public let status: Int; public let headers: [String: String]
    public init(data: Data, status: Int, headers: [String: String] = [:]) { self.data = data; self.status = status; self.headers = headers }
}
public protocol HTTPTransport: Sendable { func send(_ request: URLRequest) async throws -> HTTPResult }
public struct URLSessionTransport: HTTPTransport {
    public let session: URLSession
    public init(session: URLSession = .shared) { self.session = session }
    public func send(_ request: URLRequest) async throws -> HTTPResult {
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse, data.count <= 15_000_000 else { throw RuleError.invalid("invalid_response") }
        return HTTPResult(data: data, status: response.statusCode, headers: response.allHeaderFields.reduce(into: [:]) { $0[String(describing: $1.key).lowercased()] = String(describing: $1.value) })
    }
}
public protocol SecretStore: Sendable {
    func read(_ key: String) throws -> Data?
    func write(_ data: Data, key: String) throws
    func remove(_ key: String) throws
}
public struct AuthSession: Codable, Sendable {
    public let access_token: String; public let refresh_token: String; public let expires_at: TimeInterval?
    public let expires_in: TimeInterval?
}
public actor AuthService {
    private let url: URL; private let publicKey: String; private let transport: any HTTPTransport; private let secrets: any SecretStore
    private var session: AuthSession?; private var expiry: Date = .distantPast
    private var refreshTask: Task<AuthSession, Error>?
    private var revision = UUID()
    public init(url: URL, publicKey: String, transport: any HTTPTransport, secrets: any SecretStore) throws {
        guard url.scheme == "https", url.host != nil, url.user == nil, url.password == nil else { throw RuleError.invalid("https_required") }
        self.url = url; self.publicKey = publicKey; self.transport = transport; self.secrets = secrets
        if let data = try secrets.read("session") {
            session = try JSONDecoder().decode(AuthSession.self, from: data)
            expiry = Date(timeIntervalSince1970: session?.expires_at ?? 0)
        }
    }
    public func hasSession() -> Bool { session != nil }
    public func signIn(email: String, password: String) async throws {
        revision = UUID(); let identity = revision
        refreshTask?.cancel(); refreshTask = nil
        let result = try await exchange(grant: "password", body: ["email": email, "password": password])
        guard identity == revision else { throw CancellationError() }
        try persist(result)
    }
    public func token() async throws -> String {
        guard let session else { throw APIError(status: 401, code: "unauthorized", message: "session_expired") }
        if expiry.timeIntervalSinceNow > 60 { return session.access_token }
        let identity = revision
        if let refreshTask {
            let result = try await refreshTask.value
            guard identity == revision else { throw CancellationError() }
            return result.access_token
        }
        let task = Task { try await self.exchange(grant: "refresh_token", body: ["refresh_token": session.refresh_token]) }
        refreshTask = task
        defer { refreshTask = nil }
        do { let renewed = try await task.value; guard identity == revision else { throw CancellationError() }; try persist(renewed); return renewed.access_token }
        catch { if let failure = error as? APIError, failure.status == 400 || failure.status == 401 { try clear() }; throw error }
    }
    public func invalidateAccessToken() { expiry = .distantPast }
    public func signOut() async throws {
        let existing = session
        try clear() // Local logout must work even if the remote endpoint is unavailable.
        if let existing {
            var endpoint = URLComponents(url: url.appendingPathComponent("auth/v1/logout"), resolvingAgainstBaseURL: false)!
            endpoint.queryItems = [URLQueryItem(name:"scope",value:"local")]
            var request = URLRequest(url: endpoint.url!)
            request.timeoutInterval = 10
            request.httpMethod = "POST"; request.setValue(publicKey, forHTTPHeaderField: "apikey")
            request.setValue("Bearer \(existing.access_token)", forHTTPHeaderField: "Authorization")
            _ = try? await transport.send(request)
        }
    }
    private func clear() throws { revision = UUID(); refreshTask?.cancel(); refreshTask = nil; session = nil; expiry = .distantPast; try secrets.remove("session") }
    private func persist(_ result: AuthSession) throws {
        let expires = result.expires_at ?? Date().timeIntervalSince1970 + (result.expires_in ?? 0)
        let normalized = AuthSession(access_token: result.access_token, refresh_token: result.refresh_token, expires_at: expires, expires_in: result.expires_in)
        try secrets.write(JSONEncoder().encode(normalized), key: "session")
        session = normalized; expiry = Date(timeIntervalSince1970: expires)
    }
    private func exchange(grant: String, body: [String: String]) async throws -> AuthSession {
        var components = URLComponents(url: url.appendingPathComponent("auth/v1/token"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "grant_type", value: grant)]
        var request = URLRequest(url: components.url!)
        request.httpMethod = "POST"; request.httpBody = try JSONEncoder().encode(body)
        request.setValue(publicKey, forHTTPHeaderField: "apikey"); request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let result = try await transport.send(request)
        guard (200..<300).contains(result.status) else { throw APIError(status: result.status, code: "auth_failed", message: "sign_in_failed") }
        return try JSONDecoder().decode(AuthSession.self, from: result.data)
    }
}
public actor APIClient {
    public let base: URL
    private let auth: AuthService; private let transport: any HTTPTransport
    private var etags: [String: String] = [:]; private var cached: [String: Data] = [:]
    private var cacheRevision = UUID()
    public init(base: URL, auth: AuthService, transport: any HTTPTransport) throws {
        guard base.scheme == "https", base.host != nil, base.user == nil, base.password == nil else { throw RuleError.invalid("https_required") }
        self.base = base; self.auth = auth; self.transport = transport
    }
    public func clearCache() { cacheRevision = UUID(); cached.removeAll(); etags.removeAll() }
    public func get<T: Decodable & Sendable>(_ path: String, query: [String: String] = [:]) async throws -> T {
        try await request(path, method: "GET", query: query, body: nil, key: nil)
    }
    public func post<B: Encodable & Sendable, T: Decodable & Sendable>(_ path: String, body: B, key: String? = nil) async throws -> T {
        // A mutation may have committed even when its response is lost or malformed. Revalidate every read afterward.
        defer { clearCache() }
        return try await request(path, method: "POST", query: [:], body: JSONEncoder().encode(body), key: key)
    }
    private func request<T: Decodable & Sendable>(_ path: String, method: String, query: [String: String], body: Data?, key: String?) async throws -> T {
        guard !path.contains(".."), !path.contains(":"), !path.contains("?"), !path.hasPrefix("/") else { throw RuleError.invalid("invalid_path") }
        var components = URLComponents(url: base.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        components.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
        let url = components.url!, cacheKey = url.absoluteString, revision = cacheRevision
        for attempt in 0...1 {
            var request = URLRequest(url: url); request.httpMethod = method; request.httpBody = body; request.timeoutInterval = 30
            request.setValue("Bearer \(try await auth.token())", forHTTPHeaderField: "Authorization")
            request.setValue(UUID().uuidString, forHTTPHeaderField: "X-Request-ID")
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
            if let key { request.setValue(key, forHTTPHeaderField: "Idempotency-Key") }
            if method == "GET", let tag = etags[cacheKey] { request.setValue(tag, forHTTPHeaderField: "If-None-Match") }
            let result = try await transport.send(request)
            if method == "GET" {
                try Task.checkCancellation()
                guard revision == cacheRevision else { throw CancellationError() }
            }
            // Only reads retry automatically after refresh. Mutations retain explicit operation identity.
            if result.status == 401, method == "GET", attempt == 0 { await auth.invalidateAccessToken(); continue }
            if result.status == 304, let data = cached[cacheKey] { return try JSONDecoder().decode(T.self, from: data) }
            guard (200..<300).contains(result.status) else {
                let error = try? JSONDecoder().decode(APIErrorEnvelope.self, from: result.data).error
                throw APIError(status: result.status, code: error?.code ?? "http_error", message: error?.message ?? "request_failed", requestId: error?.requestId, retryAfter: result.headers["retry-after"].flatMap(Double.init), details: error?.details)
            }
            let decoded = try JSONDecoder().decode(T.self, from: result.data)
            if method == "GET", let tag = result.headers["etag"], result.data.count < 5_000_000 {
                if cached.count >= 24, let oldest = cached.keys.sorted().first { cached.removeValue(forKey: oldest); etags.removeValue(forKey: oldest) }
                cached[cacheKey] = result.data; etags[cacheKey] = tag
            }
            else if method == "GET" { cached.removeValue(forKey:cacheKey); etags.removeValue(forKey:cacheKey) }
            return decoded
        }
        throw APIError(status: 401, code: "unauthorized", message: "session_expired")
    }
}
