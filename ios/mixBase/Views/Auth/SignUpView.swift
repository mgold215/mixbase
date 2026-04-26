import SwiftUI
import AuthenticationServices
import CryptoKit

// MARK: - SignUpView
// Presented as a sheet from LoginView. Creates a new account and signs in immediately.
// Also offers Sign in with Apple.

struct SignUpView: View {

    @EnvironmentObject var authService: AuthService
    @Environment(\.dismiss) private var dismiss

    @State private var email = ""
    @State private var password = ""
    @State private var confirm = ""
    @State private var validationError: String? = nil

    private var formError: String? {
        if let v = validationError { return v }
        return authService.errorMessage
    }

    var body: some View {
        ZStack {
            Color(hex: "#0d0b08").ignoresSafeArea()

            RadialGradient(
                colors: [Color(hex: "#2dd4bf").opacity(0.06), .clear],
                center: .center,
                startRadius: 0,
                endRadius: 320
            )
            .ignoresSafeArea()

            VStack(spacing: 0) {
                // Drag indicator
                Capsule()
                    .fill(Color(hex: "#2a2420"))
                    .frame(width: 36, height: 4)
                    .padding(.top, 12)
                    .padding(.bottom, 28)

                // Logo
                VStack(spacing: 4) {
                    HStack(spacing: 0) {
                        Text("mix").font(.system(size: 28, weight: .bold)).foregroundColor(Color(hex: "#ede4d0"))
                        Text("BASE").font(.system(size: 28, weight: .bold)).foregroundColor(Color(hex: "#2dd4bf"))
                    }
                    Text("Start tracking your music today")
                        .font(.system(size: 13))
                        .foregroundColor(Color(hex: "#6b6050"))
                }
                .padding(.bottom, 28)

                // Form card
                VStack(spacing: 14) {

                    // Sign in with Apple
                    AppleSignUpButton(authService: authService)
                        .frame(height: 44)
                        .cornerRadius(10)

                    // Divider
                    HStack(spacing: 8) {
                        Rectangle().fill(Color(hex: "#2a2420")).frame(height: 1)
                        Text("or")
                            .font(.system(size: 11))
                            .foregroundColor(Color(hex: "#6b6050"))
                        Rectangle().fill(Color(hex: "#2a2420")).frame(height: 1)
                    }
                    .padding(.vertical, 4)

                    fieldGroup(label: "Email") {
                        TextField("you@example.com", text: $email)
                            .keyboardType(.emailAddress)
                            .autocapitalization(.none)
                            .autocorrectionDisabled()
                    }

                    fieldGroup(label: "Password") {
                        SecureField("Min. 8 characters", text: $password)
                    }

                    fieldGroup(label: "Confirm password") {
                        SecureField("••••••••", text: $confirm)
                    }

                    if let error = formError {
                        Text(error)
                            .font(.system(size: 12))
                            .foregroundColor(.red)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }

                    Button(action: attemptSignUp) {
                        Group {
                            if authService.isLoading {
                                ProgressView().tint(Color(hex: "#0d0b08"))
                            } else {
                                Text("Create account")
                                    .font(.system(size: 15, weight: .semibold))
                                    .foregroundColor(Color(hex: "#0d0b08"))
                            }
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(Color(hex: "#2dd4bf"))
                        .cornerRadius(10)
                    }
                    .disabled(authService.isLoading || email.isEmpty || password.isEmpty || confirm.isEmpty)
                    .opacity((authService.isLoading || email.isEmpty || password.isEmpty || confirm.isEmpty) ? 0.5 : 1)

                    HStack(spacing: 4) {
                        Text("Already have an account?")
                            .font(.system(size: 13))
                            .foregroundColor(Color(hex: "#6b6050"))
                        Button("Sign in") { dismiss() }
                            .font(.system(size: 13))
                            .foregroundColor(Color(hex: "#2dd4bf"))
                    }
                    .padding(.top, 4)
                }
                .padding(24)
                .background(Color(hex: "#0f1513").opacity(0.85))
                .cornerRadius(16)
                .overlay(RoundedRectangle(cornerRadius: 16).stroke(Color(hex: "#1e1810"), lineWidth: 1))
                .padding(.horizontal, 24)

                Spacer()
            }
        }
        .onChange(of: authService.isAuthenticated) { _, authenticated in
            if authenticated { dismiss() }
        }
    }

    private func attemptSignUp() {
        validationError = nil
        authService.errorMessage = nil

        guard password == confirm else {
            validationError = "Passwords do not match"
            return
        }
        guard password.count >= 8 else {
            validationError = "Password must be at least 8 characters"
            return
        }

        Task { await authService.signUp(email: email, password: password) }
    }

    @ViewBuilder
    private func fieldGroup<Content: View>(label: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
                .font(.system(size: 12))
                .foregroundColor(Color(hex: "#9b8b78"))
            content()
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .background(Color(hex: "#1a1612"))
                .cornerRadius(10)
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color(hex: "#2a2420"), lineWidth: 1))
                .foregroundColor(Color(hex: "#ede4d0"))
        }
    }
}

// MARK: - Apple Sign Up Button (UIViewRepresentable)
// Uses ASAuthorizationAppleIDButton with .signUp type for the signup screen.
struct AppleSignUpButton: UIViewRepresentable {
    let authService: AuthService

    func makeCoordinator() -> Coordinator {
        Coordinator(authService: authService)
    }

    func makeUIView(context: Context) -> ASAuthorizationAppleIDButton {
        let button = ASAuthorizationAppleIDButton(type: .signUp, style: .white)
        button.addTarget(context.coordinator, action: #selector(Coordinator.handleAppleSignIn), for: .touchUpInside)
        return button
    }

    func updateUIView(_ uiView: ASAuthorizationAppleIDButton, context: Context) {}

    class Coordinator: NSObject, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
        let authService: AuthService
        var currentNonce: String?

        init(authService: AuthService) {
            self.authService = authService
        }

        @objc func handleAppleSignIn() {
            let nonce = randomNonceString()
            currentNonce = nonce

            let provider = ASAuthorizationAppleIDProvider()
            let request = provider.createRequest()
            request.requestedScopes = [.email, .fullName]
            request.nonce = sha256(nonce)

            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            controller.performRequests()
        }

        func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
            guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
                  let identityToken = credential.identityToken,
                  let tokenString = String(data: identityToken, encoding: .utf8),
                  let nonce = currentNonce else {
                return
            }

            Task {
                await authService.signInWithApple(idToken: tokenString, nonce: nonce)
            }
        }

        func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
            if (error as? ASAuthorizationError)?.code != .canceled {
                Task { @MainActor in
                    authService.errorMessage = "Apple Sign In failed. Please try again."
                }
            }
        }

        func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
            guard let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
                  let window = scene.windows.first else {
                return UIWindow()
            }
            return window
        }

        private func randomNonceString(length: Int = 32) -> String {
            precondition(length > 0)
            var randomBytes = [UInt8](repeating: 0, count: length)
            let errorCode = SecRandomCopyBytes(kSecRandomDefault, randomBytes.count, &randomBytes)
            if errorCode != errSecSuccess { fatalError("Unable to generate nonce.") }
            let charset: [Character] = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVXYZabcdefghijklmnopqrstuvwxyz-._")
            return String(randomBytes.map { charset[Int($0) % charset.count] })
        }

        private func sha256(_ input: String) -> String {
            let inputData = Data(input.utf8)
            let hashed = SHA256.hash(data: inputData)
            return hashed.compactMap { String(format: "%02x", $0) }.joined()
        }
    }
}
