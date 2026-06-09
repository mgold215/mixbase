import Foundation

// Talks to the deployed Next.js backend's /api/infra/* endpoints.
//
// Auth is cookie-based: POST /api/auth sets the httpOnly sb-access-token cookie,
// which this client's persistent HTTPCookieStorage captures and replays on every
// subsequent request — and which the middleware decodes into X-User-Id. We block
// redirects to /login so an expired/missing session surfaces as `.unauthorized`
// rather than silently fetching the login HTML page.

@MainActor
final class InfraAPIClient: ObservableObject {
    @Published private(set) var environment: InfraEnvironment

    private let session: URLSession
    private let decoder = JSONDecoder()

    enum APIError: LocalizedError {
        case unauthorized
        case http(Int)
        case decoding(String)
        case transport(String)

        var errorDescription: String? {
            switch self {
            case .unauthorized: return "Not authorized — sign in with an admin account."
            case .http(let code): return "Server returned HTTP \(code)."
            case .decoding(let msg): return "Could not read the server response. \(msg)"
            case .transport(let msg): return msg
            }
        }
    }

    init(environment: InfraEnvironment = .production) {
        self.environment = environment
        let config = URLSessionConfiguration.default
        config.httpCookieStorage = HTTPCookieStorage.shared
        config.httpShouldSetCookies = true
        config.httpCookieAcceptPolicy = .always
        config.timeoutIntervalForRequest = 20
        let delegate = NoLoginRedirectDelegate()
        self.session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
    }

    func setEnvironment(_ env: InfraEnvironment) { environment = env }

    private func url(_ path: String) -> URL { environment.baseURL.appendingPathComponent(path) }

    // MARK: - Auth

    func login(email: String, password: String) async throws {
        var req = URLRequest(url: url("/api/auth"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["email": email, "password": password])
        let (_, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse else { throw APIError.transport("No response from server.") }
        if http.statusCode == 401 { throw APIError.unauthorized }
        guard http.statusCode == 200 else { throw APIError.http(http.statusCode) }
    }

    func logout() async {
        var req = URLRequest(url: url("/api/auth/logout"))
        req.httpMethod = "POST"
        _ = try? await session.data(for: req)
        if let host = environment.baseURL.host {
            for cookie in HTTPCookieStorage.shared.cookies ?? [] where host.contains(cookie.domain) || cookie.domain.contains(host) {
                HTTPCookieStorage.shared.deleteCookie(cookie)
            }
        }
    }

    /// True if the current cookie session is valid (the user is signed in).
    func checkSession() async -> Bool {
        do {
            _ = try await rawGet("/api/auth/me")
            return true
        } catch {
            return false
        }
    }

    // MARK: - Requests

    func get<T: Decodable>(_ path: String) async throws -> T {
        let data = try await rawGet(path)
        do { return try decoder.decode(T.self, from: data) }
        catch { throw APIError.decoding(String(describing: error)) }
    }

    func postJSON<T: Decodable>(_ path: String, body: [String: Any]) async throws -> T {
        var req = URLRequest(url: url(path))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await session.data(for: req)
        try validate(resp)
        do { return try decoder.decode(T.self, from: data) }
        catch { throw APIError.decoding(String(describing: error)) }
    }

    private func rawGet(_ path: String) async throws -> Data {
        let req = URLRequest(url: url(path))
        let (data, resp) = try await session.data(for: req)
        try validate(resp)
        return data
    }

    private func validate(_ resp: URLResponse) throws {
        guard let http = resp as? HTTPURLResponse else { throw APIError.transport("No response from server.") }
        if http.statusCode == 401 || http.statusCode == 403 { throw APIError.unauthorized }
        if (300...399).contains(http.statusCode) { throw APIError.unauthorized } // blocked login redirect
        guard (200...299).contains(http.statusCode) else { throw APIError.http(http.statusCode) }
    }
}

// Stops the URL loading system from following redirects to /login, so callers
// see the 3xx response (treated as unauthorized) instead of the login page HTML.
private final class NoLoginRedirectDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        if request.url?.path.contains("/login") == true {
            completionHandler(nil) // stop — surface the redirect itself
        } else {
            completionHandler(request)
        }
    }
}
