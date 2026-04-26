import Foundation
import Combine

// MARK: - AuthService
// Handles Supabase Auth via direct REST calls (no SDK dependency).
// Publishes auth state so views can reactively update.

@MainActor
class AuthService: ObservableObject {

    static let shared = AuthService()

    @Published var isAuthenticated = false
    @Published var userId: String? = nil
    @Published var userEmail: String? = nil
    @Published var isLoading = false
    @Published var errorMessage: String? = nil
    @Published var subscriptionTier: String = "free"
    @Published var subscriptionUsage: [String: Int] = [:]

    private let supabaseURL = Config.supabaseURL
    private let supabaseAnonKey = Config.supabaseAnonKey

    private init() {
        // Restore session from Keychain on launch
        restoreSession()
    }

    // MARK: - Session restore
    private func restoreSession() {
        guard let token = KeychainService.load(forKey: "access_token"),
              let uid = KeychainService.load(forKey: "user_id") else { return }

        // Validate the stored token is still good
        Task {
            if await validateToken(token) {
                self.userId = uid
                self.userEmail = KeychainService.load(forKey: "user_email")
                self.isAuthenticated = true
                SupabaseService.shared.setAccessToken(token)
            } else {
                // Try refreshing before giving up
                await refreshSession()
            }
        }
    }

    // MARK: - Sign In
    func signIn(email: String, password: String) async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        guard let url = URL(string: "\(supabaseURL)/auth/v1/token?grant_type=password") else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue(supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["email": email, "password": password])

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else { return }

            if http.statusCode == 200 {
                let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
                applySession(json: json, email: email)
            } else {
                let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                errorMessage = (json?["error_description"] as? String) ?? "Invalid email or password"
            }
        } catch {
            errorMessage = "Network error. Check your connection."
        }
    }

    // MARK: - Sign Up
    func signUp(email: String, password: String) async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        guard let url = URL(string: "\(supabaseURL)/auth/v1/signup") else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue(supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["email": email, "password": password])

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else { return }

            if http.statusCode == 200 {
                // Sign up succeeded — sign in immediately to get a session
                await signIn(email: email, password: password)
            } else {
                let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                let msg = (json?["msg"] as? String) ?? (json?["error_description"] as? String) ?? "Sign up failed"
                errorMessage = msg.contains("already registered") ? "An account with that email already exists." : msg
            }
        } catch {
            errorMessage = "Network error. Check your connection."
        }
    }

    // MARK: - Sign In with Apple
    // Exchanges the Apple identity token with Supabase for a session.
    func signInWithApple(idToken: String, nonce: String) async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        guard let url = URL(string: "\(supabaseURL)/auth/v1/token?grant_type=id_token") else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue(supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "provider": "apple",
            "id_token": idToken,
            "nonce": nonce,
        ])

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else { return }

            if http.statusCode == 200 {
                let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
                let email = (json?["user"] as? [String: Any])?["email"] as? String ?? ""
                applySession(json: json, email: email)
            } else {
                let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                errorMessage = (json?["error_description"] as? String)
                    ?? (json?["msg"] as? String)
                    ?? "Apple Sign In failed"
            }
        } catch {
            errorMessage = "Network error. Check your connection."
        }
    }

    // MARK: - Sign Out
    func signOut() {
        KeychainService.clearAll()
        SupabaseService.shared.setAccessToken(nil)
        isAuthenticated = false
        userId = nil
        userEmail = nil
    }

    // MARK: - Token refresh
    func refreshSession() async {
        guard let refreshToken = KeychainService.load(forKey: "refresh_token") else {
            signOut()
            return
        }

        guard let url = URL(string: "\(supabaseURL)/auth/v1/token?grant_type=refresh_token") else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue(supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["refresh_token": refreshToken])

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                signOut()
                return
            }
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            let email = KeychainService.load(forKey: "user_email") ?? ""
            applySession(json: json, email: email)
        } catch {
            signOut()
        }
    }

    // MARK: - Validate token
    private func validateToken(_ token: String) async -> Bool {
        guard let url = URL(string: "\(supabaseURL)/auth/v1/user") else { return false }
        var request = URLRequest(url: url)
        request.setValue(supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            return (response as? HTTPURLResponse)?.statusCode == 200
        } catch {
            return false
        }
    }

    // MARK: - Apply session from Supabase response JSON
    private func applySession(json: [String: Any]?, email: String) {
        guard
            let accessToken = json?["access_token"] as? String,
            let refreshToken = json?["refresh_token"] as? String,
            let userDict = json?["user"] as? [String: Any],
            let uid = userDict["id"] as? String
        else {
            errorMessage = "Unexpected response from server"
            return
        }

        KeychainService.save(accessToken, forKey: "access_token")
        KeychainService.save(refreshToken, forKey: "refresh_token")
        KeychainService.save(uid, forKey: "user_id")
        KeychainService.save(email, forKey: "user_email")

        SupabaseService.shared.setAccessToken(accessToken)
        SupabaseService.shared.setUserId(uid)

        self.userId = uid
        self.userEmail = email
        self.isAuthenticated = true
        Task { await self.fetchSubscription() }
    }

    // MARK: - Fetch subscription info
    func fetchSubscription() async {
        guard let token = KeychainService.load(forKey: "access_token"),
              let url = URL(string: "https://mixbase.app/api/subscription") else { return }

        var request = URLRequest(url: url)
        request.setValue("sb-access-token=\(token)", forHTTPHeaderField: "Cookie")

        do {
            let (data, _) = try await URLSession.shared.data(for: request)
            let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            let tier = json?["tier"] as? String ?? "free"
            let usage = json?["usage"] as? [String: Int] ?? [:]
            await MainActor.run {
                self.subscriptionTier = tier
                self.subscriptionUsage = usage
            }
        } catch {
            // Non-fatal — tier defaults to "free"
        }
    }
}
