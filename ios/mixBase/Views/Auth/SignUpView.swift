import SwiftUI

// MARK: - SignUpView
// Presented as a sheet from LoginView. Creates a new account and signs in immediately.

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
