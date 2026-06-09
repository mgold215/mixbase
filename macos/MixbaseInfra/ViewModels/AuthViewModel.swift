import Foundation

@MainActor
final class AuthViewModel: ObservableObject {
    @Published var isAuthenticated = false
    @Published var isChecking = true
    @Published var email: String
    @Published var errorMessage: String?
    @Published var busy = false

    let client: InfraAPIClient

    init(client: InfraAPIClient) {
        self.client = client
        self.email = KeychainService.load(forKey: "infra_email") ?? ""
    }

    /// Check on launch whether a persisted cookie session is still valid.
    func restore() async {
        isChecking = true
        isAuthenticated = await client.checkSession()
        isChecking = false
    }

    func login(password: String) async {
        errorMessage = nil
        busy = true
        defer { busy = false }
        do {
            try await client.login(email: email, password: password)
            KeychainService.save(email, forKey: "infra_email")
            isAuthenticated = true
        } catch InfraAPIClient.APIError.unauthorized {
            errorMessage = "Invalid email or password."
        } catch {
            errorMessage = "Sign-in failed. Check the environment and your connection."
        }
    }

    func logout() async {
        await client.logout()
        isAuthenticated = false
    }
}
