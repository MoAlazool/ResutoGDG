import Foundation

/// Public UI keys and a support reference; never renders an arbitrary backend message or response body.
public struct FailurePresentation: Sendable {
    public let key: String; public let requestId: String?
    public init(_ error: Error) {
        if let api = error as? APIError {
            requestId = api.requestId
            if api.code == "pairing_code_invalid" { key = "pos_pairing_code_invalid" }
            else if api.status == 401 && !["device_revoked","device_expired"].contains(api.code) { key = "session_expired" }
            else if api.status == 403 { key = "permission_denied" }
            else { key = Self.key(code:api.code) }
        } else {
            requestId = nil
            if let rule = error as? RuleError, case .invalid(let code) = rule { key = Self.key(code:code) }
            else if error is URLError { key = "connection_interrupted" }
            else { key = "request_failed" }
        }
    }
    public static func key(code: String) -> String {
        switch code {
        case "pos_price_changed": return "price_changed"
        case "pos_items_unavailable": return "item_unavailable"
        case "stale_order","version_conflict": return "order_changed"
        case "device_revoked","device_expired": return "pos_pairing_required"
        case "auth_failed": return "sign_in_failed"
        default: return code // Language renders unknown keys as a generic localized failure.
        }
    }
}
