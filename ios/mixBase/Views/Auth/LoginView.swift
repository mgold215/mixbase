import SwiftUI

// MARK: - LoginView
// Email + password sign-in screen. Matches the web app's visual design.

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
