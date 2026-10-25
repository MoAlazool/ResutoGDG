import Foundation

/// Public endpoint configuration. Production origins must be approved in a reviewed release build.
/// Prevents editable connection settings from forwarding staff/device credentials to arbitrary HTTPS hosts.
public enum ApprovedEnvironment {
    public static func contains(api: URL, auth: URL) -> Bool { isStaging(api:api,auth:auth) }
    public static func isStaging(api: URL, auth: URL) -> Bool {
        valid(api,host:"resuto-2-staging-api.onrender.com",path:"/v1") &&
        valid(auth,host:"skvnznyfxpxfuzvuipju.supabase.co",path:"")
    }
    private static func valid(_ url: URL, host: String, path: String) -> Bool {
        url.scheme == "https" && url.host == host && (url.port == nil || url.port == 443) &&
        (url.path == path || (path.isEmpty && url.path == "/")) && url.user == nil && url.password == nil && url.query == nil && url.fragment == nil
    }
}
