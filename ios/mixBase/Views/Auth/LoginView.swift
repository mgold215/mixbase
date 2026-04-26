import SwiftUI
import AuthenticationServices
import CryptoKit

// MARK: - LoginView
// Email + password sign-in screen with Sign in with Apple / Google.

struct LoginView: View {

    @EnvironmentObject var authService: AuthService

    @State private var email = ""
    @State private var password = ""
    @State private var showSignUp = false

    var body: some View {
        ZStack {
            Color(hex: "#0d0b08").ignoresSafeArea()

            // Atmospheric teal glow centred behind the card
            RadialGradient(
                colors: [Color(hex: "#2dd4bf").opacity(0.07), .clear],
                center: .center,
                startRadius: 0,
                endRadius: 320
            )
            .ignoresSafeArea()

            VStack(spacing: 0) {
                Spacer()

                // Logo
                VStack(spacing: 6) {
                    HStack(spacing: 0) {
                        Text("mix").font(.system(size: 32, weight: .bold)).foregroundColor(Color(hex: "#ede4d0"))
                        Text("BASE").font(.system(size: 32, weight: .bold)).foregroundColor(Color(hex: "#2dd4bf"))
                    }
                    Text("ROUGH-TO-RELEASE")
                        .font(.system(size: 10, weight: .medium))
                        .tracking(3)
                        .foregroundColor(Color(hex: "#86efac"))
                    Text("Track the evolution of your mixes")
                        .font(.system(size: 13))
                        .foregroundColor(Color(hex: "#6b6050"))
                        .padding(.top, 2)
                }
                .padding(.bottom, 32)

                // Card
                VStack(spacing: 16) {

                    // Sign in with Apple
                    AppleSignInButton(authService: authService)
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

                    // Email field
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Email")
                            .font(.system(size: 12))
                            .foregroundColor(Color(hex: "#9b8b78"))
                        TextField("you@example.com", text: $email)
                            .keyboardType(.emailAddress)
                            .autocapitalization(.none)
                            .autocorrectionDisabled()
                            .padding(.horizontal, 14)
                            .padding(.vertical, 12)
                            .background(Color(hex: "#1a1612"))
                            .cornerRadius(10)
                            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color(hex: "#2a2420"), lineWidth: 1))
                            .foregroundColor(Color(hex: "#ede4d0"))
                    }

                    // Password field
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Password")
                            .font(.system(size: 12))
                            .foregroundColor(Color(hex: "#9b8b78"))
                        SecureField("••••••••", text: $password)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 12)
                            .background(Color(hex: "#1a1612"))
                            .cornerRadius(10)
                            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color(hex: "#2a2420"), lineWidth: 1))
                            .foregroundColor(Color(hex: "#ede4d0"))
                    }

                    // Error message
                    if let error = authService.errorMessage {
                        Text(error)
                            .font(.system(size: 12))
                            .foregroundColor(.red)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }

                    // Sign in button
                    Button(action: {
                        Task { await authService.signIn(email: email, password: password) }
                    }) {
                        Group {
                            if authService.isLoading {
                                ProgressView().tint(Color(hex: "#0d0b08"))
                            } else {
                                Text("Sign in")
                                    .font(.system(size: 15, weight: .semibold))
                                    .foregroundColor(Color(hex: "#0d0b08"))
                            }
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(Color(hex: "#2dd4bf"))
                        .cornerRadius(10)
                    }
                    .disabled(authService.isLoading || email.isEmpty || password.isEmpty)
                    .opacity((authService.isLoading || email.isEmpty || password.isEmpty) ? 0.5 : 1)

                    // Sign up link
                    HStack(spacing: 4) {
                        Text("Don't have an account?")
                            .font(.system(size: 13))
                            .foregroundColor(Color(hex: "#6b6050"))
                        Button("Create one") { showSignUp = true }
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
                Spacer()
            }
        }
        .sheet(isPresented: $showSignUp) {
            SignUpView()
                .environmentObject(authService)
        }
    }
}

// MARK: - Apple Sign In Button (UIViewRepresentable)
// Uses ASAuthorizationAppleIDButton for the native look Apple requires.
struct AppleSignInButton: UIViewRepresentable {
    let authService: AuthService

    // Store the nonce so we can send it to Supabase for verification
    @State private var currentNonce: String?

    func makeCoordinator() -> Coordinator {
        Coordinator(authService: authService)
    }

    func makeUIView(context: Context) -> ASAuthorizationAppleIDButton {
        let button = ASAuthorizationAppleIDButton(type: .signIn, style: .white)
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
            // User cancelled or error — only show if not a cancellation
            if (error as? ASAuthorizationError)?.code != .canceled {
                Task { @MainActor in
                    authService.errorMessage = "Apple Sign In failed. Please try again."
                }
            }
        }

        func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
            // Get the key window for presentation
            guard let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
                  let window = scene.windows.first else {
                return UIWindow()
            }
            return window
        }

        // Generate a random nonce string
        private func randomNonceString(length: Int = 32) -> String {
            precondition(length > 0)
            var randomBytes = [UInt8](repeating: 0, count: length)
            let errorCode = SecRandomCopyBytes(kSecRandomDefault, randomBytes.count, &randomBytes)
            if errorCode != errSecSuccess { fatalError("Unable to generate nonce.") }
            let charset: [Character] = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVXYZabcdefghijklmnopqrstuvwxyz-._")
            return String(randomBytes.map { charset[Int($0) % charset.count] })
        }

        // SHA256 hash of the nonce to send to Apple
        private func sha256(_ input: String) -> String {
            let inputData = Data(input.utf8)
            let hashed = SHA256.hash(data: inputData)
            return hashed.compactMap { String(format: "%02x", $0) }.joined()
        }
    }
}
