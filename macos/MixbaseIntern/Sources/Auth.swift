import Foundation
import Security

// The owner signs in once. Only the refresh token is kept, in the login
// Keychain; a short-lived access token is fetched from it when needed.
final class Auth {
    static let shared = Auth()
    private let lock = NSLock()
    private var accessToken: String?
    private var expiresAt: TimeInterval = 0
    private(set) var email: String? = UserDefaults.standard.string(forKey: "email")

    var isSignedIn: Bool { keychainLoad() != nil }

    // MARK: Keychain

    private func query() -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: Paths.bundleId,
         kSecAttrAccount as String: "refresh_token"]
    }
    private func keychainLoad() -> String? {
        var q = query(); q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        return String(data: d, encoding: .utf8)
    }
    private func keychainSave(_ value: String) {
        SecItemDelete(query() as CFDictionary)
        var q = query(); q[kSecValueData as String] = Data(value.utf8)
        let status = SecItemAdd(q as CFDictionary, nil)
        if status != errSecSuccess { Log.write("keychain save failed: \(status)") }
    }
    func signOut() {
        lock.lock(); defer { lock.unlock() }
        SecItemDelete(query() as CFDictionary)
        accessToken = nil; expiresAt = 0
    }

    // MARK: Supabase auth

    private func post(_ grant: String, body: [String: Any]) -> (Int, [String: Any]?) {
        var req = URLRequest(url: URL(string: "\(Paths.supabaseURL)/auth/v1/token?grant_type=\(grant)")!)
        req.httpMethod = "POST"
        req.timeoutInterval = 30
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(Paths.supabaseKey, forHTTPHeaderField: "apikey")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        let sem = DispatchSemaphore(value: 0)
        var status = 0; var json: [String: Any]?
        URLSession.shared.dataTask(with: req) { data, resp, _ in
            status = (resp as? HTTPURLResponse)?.statusCode ?? 0
            if let data { json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] }
            sem.signal()
        }.resume()
        sem.wait()
        return (status, json)
    }

    private func apply(_ json: [String: Any]?) -> Bool {
        guard let json, let access = json["access_token"] as? String, let refresh = json["refresh_token"] as? String else { return false }
        accessToken = access
        expiresAt = Date().timeIntervalSince1970 + ((json["expires_in"] as? Double) ?? 3600)
        keychainSave(refresh)
        return true
    }

    /// Returns nil on success, or a sentence saying what went wrong.
    func signIn(email: String, password: String) -> String? {
        lock.lock(); defer { lock.unlock() }
        let (status, json) = post("password", body: ["email": email, "password": password])
        if apply(json) {
            self.email = email
            UserDefaults.standard.set(email, forKey: "email")
            return nil
        }
        if status == 0 { return "Could not reach mixBASE. Check the connection and try again." }
        return (json?["error_description"] as? String) ?? (json?["msg"] as? String) ?? "Sign-in failed (\(status))."
    }

    /// A valid access token, refreshed when it has under five minutes left.
    /// Nil when signed out, or when the refresh was refused.
    func token() -> String? {
        lock.lock(); defer { lock.unlock() }
        if let t = accessToken, expiresAt - Date().timeIntervalSince1970 > 300 { return t }
        guard let refresh = keychainLoad() else { return nil }
        let (status, json) = post("refresh_token", body: ["refresh_token": refresh])
        if apply(json) { return accessToken }
        // 400/401: the refresh token itself is no longer good. Anything else
        // (no network, a server error) leaves the session alone for a retry.
        if status == 400 || status == 401 {
            Log.write("refresh refused (\(status)): signed out")
            SecItemDelete(query() as CFDictionary)
            accessToken = nil
            DispatchQueue.main.async { NotificationCenter.default.post(name: .internSignedOut, object: nil) }
        }
        return nil
    }
}

extension Notification.Name {
    static let internSignedOut = Notification.Name("internSignedOut")
}
