import Foundation
import Security
import CryptoKit

struct KeychainStore: SecretStore {
    let namespace: String
    private func query(_ key: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: namespace, kSecAttrAccount as String: key]
    }
    func read(_ key: String) throws -> Data? {
        var q = query(key); q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw RuleError.invalid("keychain_unavailable") }
        return data
    }
    func write(_ data: Data, key: String) throws {
        let attributes: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let status = SecItemUpdate(query(key) as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            let insert = query(key).merging(attributes) { _, new in new }
            guard SecItemAdd(insert as CFDictionary, nil) == errSecSuccess else { throw RuleError.invalid("keychain_unavailable") }
        } else if status != errSecSuccess { throw RuleError.invalid("keychain_unavailable") }
    }
    func remove(_ key: String) throws {
        let status = SecItemDelete(query(key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw RuleError.invalid("keychain_unavailable") }
    }
}
struct EncryptedStore: DataStore {
    let url: URL; let key: SymmetricKey
    init(name: String, namespace: String) throws {
        let secrets = KeychainStore(namespace: namespace)
        let data: Data
        if let existing = try secrets.read("storage-key") { data = existing }
        else { data = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }; try secrets.write(data, key: "storage-key") }
        key = SymmetricKey(data: data)
        let directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent(namespace)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
        var excluded = directory; var values = URLResourceValues(); values.isExcludedFromBackup = true; try excluded.setResourceValues(values)
        url = directory.appendingPathComponent(name + ".sealed")
    }
    func read() throws -> Data? {
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        return try AES.GCM.open(AES.GCM.SealedBox(combined: Data(contentsOf: url)), using: key, authenticating: Data(url.lastPathComponent.utf8))
    }
    func write(_ data: Data) throws {
        let sealed = try AES.GCM.seal(data, using: key, authenticating: Data(url.lastPathComponent.utf8))
        guard let combined = sealed.combined else { throw RuleError.invalid("storage_unavailable") }
        try combined.write(to: url, options: [.atomic, .completeFileProtection])
    }
}
struct Configuration: Codable, Equatable {
    let apiURL: URL; let supabaseURL: URL; let publicKey: String
    static var saved: Configuration? { UserDefaults.standard.data(forKey: "configuration").flatMap { try? JSONDecoder().decode(Self.self, from: $0) } }
    var namespace: String { "resuto." + SHA256.hash(data: Data((apiURL.absoluteString + supabaseURL.absoluteString).utf8)).map { String(format: "%02x", $0) }.joined() }
    func validate() throws {
        for url in [apiURL, supabaseURL] {
            guard url.scheme == "https", url.host != nil, url.user == nil, url.password == nil, url.query == nil, url.fragment == nil else { throw RuleError.invalid("https_required") }
        }
        guard apiURL.path == "/v1", supabaseURL.path.isEmpty || supabaseURL.path == "/" else { throw RuleError.invalid("invalid_configuration") }
        if !publicKey.hasPrefix("sb_publishable_") {
            let parts = publicKey.split(separator: ".")
            guard parts.count == 3 else { throw RuleError.invalid("publishable_key_required") }
            var payload = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
            payload += String(repeating: "=", count: (4 - payload.count % 4) % 4)
            guard let data = Data(base64Encoded: payload), let claims = try JSONSerialization.jsonObject(with: data) as? [String: Any], claims["role"] as? String == "anon" else { throw RuleError.invalid("publishable_key_required") }
        }
    }
    func save() throws { try validate(); UserDefaults.standard.set(try JSONEncoder().encode(self), forKey: "configuration") }
}
final class RejectRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    static func transport() -> URLSessionTransport {
        let config = URLSessionConfiguration.ephemeral
        config.urlCache = nil; config.httpCookieStorage = nil; config.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSessionTransport(session: URLSession(configuration: config, delegate: RejectRedirects(), delegateQueue: nil))
    }
}
