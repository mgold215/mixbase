import Foundation
import Combine

// MARK: - AuthService
// Handles Supabase Auth via direct REST calls.
// Stores tokens in Keychain with expiry tracking for reliable 30-day sessions.
// Proactively refreshes the access token before it expires so API calls never fail silently.

@MainActor
class AuthService: ObservableObject {

    static let shared = AuthService()

    @Published var isAuthenticated = false
    @Published var userId: String? = nil
    @Published var userEmail: String? = nil
    @Published var isLoading = false
    @Published var errorMessage: String? = nil

    private let supabaseURL = Config.supabaseURL
    private let supabaseAnonKey = Config.supabaseAnonKey

    // Guards against firing two concurrent refreshes (launch + foreground), which
    // would race over Supabase's rotating refresh tokens and invalidate the session.
    private var isRefreshing = false

    // Refresh once the access token is within this window of expiring.
    private let refreshLeeway: TimeInterval = 5 * 60 // 5 minutes

    // Fires ~5 min before the access token expires so a long, uninterrupted
    // foreground session never starts 401-ing mid-use.
    private var refreshTimer: Timer?

    private init() {
        restoreSession()
    }

    // MARK: - Session restore
    // Optimistically restore from the Keychain WITHOUT a network call. Supabase
    // refresh tokens are long-lived (no expiry by default), so as long as we still
    // hold one the user has a valid session — we must never drop them just because
    // the short-lived (~1h) access token has expired or the network is momentarily
    // down. We then refresh in the background only if the access token is stale.
    private func restoreSession() {
        guard let token = KeychainService.load(forKey: "access_token"),
              let uid = KeychainService.load(forKey: "user_id"),
              KeychainService.load(forKey: "refresh_token") != nil else { return }

        self.userId = uid
        self.userEmail = KeychainService.load(forKey: "user_email")
        self.isAuthenticated = true
        SupabaseService.shared.setAccessToken(token)
        SupabaseService.shared.setUserId(uid)

        Task { await ensureFreshToken() }
    }

    // MARK: - Keep the session warm
    // Call on app launch and whenever the app returns to the foreground. Refreshes
    // the access token if it is missing, expired, or about to expire. A healthy
    // token is left untouched so we don't burn through refresh-token rotations.
    func ensureFreshToken() async {
        guard isAuthenticated else { return }

        let exp = currentTokenExpiry()
        let now = Date().timeIntervalSince1970
        if let exp = exp, exp - now > refreshLeeway {
            scheduleProactiveRefresh() // healthy — just (re)arm the timer
            return
        }
        await refreshSession()
    }

    // Schedules a single proactive refresh just before the current access token
    // expires, then re-arms itself after each successful refresh (via applySession).
    private func scheduleProactiveRefresh() {
        refreshTimer?.invalidate()
        guard let exp = currentTokenExpiry() else { return }

        let now = Date().timeIntervalSince1970
        let delay = max(30, exp - now - refreshLeeway) // never sooner than 30s out
        refreshTimer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] _ in
            Task { @MainActor in await self?.refreshSession() }
        }
    }

    // Epoch expiry of the stored access token: prefer the saved `expires_at`,
    // falling back to decoding the JWT's `exp` claim.
    private func currentTokenExpiry() -> TimeInterval? {
        if let saved = KeychainService.load(forKey: "expires_at"),
           let exp = TimeInterval(saved) {
            return exp
        }
        if let token = KeychainService.load(forKey: "access_token") {
            return decodeJWTExpiry(token)
        }
        return nil
    }

    // Reads the `exp` claim from a JWT without verifying its signature.
    private func decodeJWTExpiry(_ token: String) -> TimeInterval? {
        let segments = token.split(separator: ".")
        guard segments.count == 3 else { return nil }

        var base64 = String(segments[1])
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while base64.count % 4 != 0 { base64 += "=" }

        guard let data = Data(base64Encoded: base64),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let exp = json["exp"] as? TimeInterval else { return nil }
        return exp
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
        refreshTimer?.invalidate()
        refreshTimer = nil
        KeychainService.clearAll()
        SupabaseService.shared.setAccessToken(nil)
        isAuthenticated = false
        userId = nil
        userEmail = nil
    }

    // MARK: - Token refresh
    // Returns true if the session is (still) valid afterwards.
    //
    // Critically, we ONLY sign the user out when Supabase *definitively* rejects
    // the refresh token (HTTP 400/401 — revoked or truly expired). Network errors,
    // timeouts and 5xx/429 responses are transient: we keep the existing session so
    // a momentary blip can't log the user out.
    @discardableResult
    func refreshSession() async -> Bool {
        // Collapse concurrent refreshes into the first one.
        if isRefreshing { return isAuthenticated }
        isRefreshing = true
        defer { isRefreshing = false }

        guard let refreshToken = KeychainService.load(forKey: "refresh_token") else {
            signOut()
            return false
        }

        guard let url = URL(string: "\(supabaseURL)/auth/v1/token?grant_type=refresh_token") else {
            return isAuthenticated
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue(supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["refresh_token": refreshToken])

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else { return isAuthenticated }

            if http.statusCode == 200 {
                let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                let email = KeychainService.load(forKey: "user_email") ?? ""
                applySession(json: json, email: email)
                return true
            }

            // 400/401 = the refresh token itself is invalid/revoked. Only then do we
            // clear credentials and bounce to login.
            if http.statusCode == 400 || http.statusCode == 401 {
                signOut()
                return false
            }

            // 5xx, 429, etc. — server-side or rate-limit hiccup. Keep the session;
            // we'll try again on the next launch/foreground.
            return isAuthenticated
        } catch {
            // Network failure — keep the session intact, do NOT wipe the Keychain.
            return isAuthenticated
        }
    }

    // MARK: - Apply session from Supabase response JSON
    // Saves all tokens + expiry to Keychain, updates in-memory state,
    // and schedules the next proactive refresh.
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

        // Persist everything to Keychain (survives app restarts, updates, etc.)
        KeychainService.save(accessToken, forKey: "access_token")
        KeychainService.save(refreshToken, forKey: "refresh_token")
        KeychainService.save(uid, forKey: "user_id")
        KeychainService.save(email, forKey: "user_email")

        // Persist the access-token expiry so we can decide when to refresh without
        // decoding the JWT every time. Supabase returns `expires_at` (epoch) and/or
        // `expires_in` (seconds); fall back to the JWT's own `exp` claim.
        let expiry: TimeInterval? = {
            if let at = json?["expires_at"] as? TimeInterval { return at }
            if let inS = json?["expires_in"] as? TimeInterval { return Date().timeIntervalSince1970 + inS }
            return decodeJWTExpiry(accessToken)
        }()
        if let expiry = expiry {
            KeychainService.save(String(Int(expiry)), forKey: "expires_at")
        }

        SupabaseService.shared.setAccessToken(accessToken)
        SupabaseService.shared.setUserId(uid)

        self.userId = uid
        self.userEmail = email
        self.isAuthenticated = true

        // Keep the session warm: refresh again shortly before this token expires.
        scheduleProactiveRefresh()

        // Load artist name for Now Playing / Control Center / Bluetooth AVRCP
        Task {
            let name = await SupabaseService.shared.fetchArtistName(userId: uid)
            await MainActor.run { AudioService.shared.artistName = name }
        }
    }
}
