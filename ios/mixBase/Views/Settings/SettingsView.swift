import SwiftUI

// MARK: - SettingsView
// Simple settings screen with sections for:
// 1. Authentication (change app password)
// 2. API Keys (Supabase, Replicate, Anthropic)
// 3. About (app version, branding)

struct SettingsView: View {

    // Fields for editing passwords and API keys
    // These are local state — in a real app you'd persist to Keychain
    @State private var appPassword = ""
    @State private var supabaseKey = ""
    @State private var replicateKey = ""
    @State private var anthropicKey = ""

    // Feedback state
    @State private var showSavedAlert = false

    var body: some View {
        ZStack {
            // Dark background
            Color(hex: "#080808")
                .ignoresSafeArea()

            Form {
                // MARK: - Authentication Section
                Section {
                    SecureField("New app password", text: $appPassword)
                        .foregroundColor(Color(hex: "#f0f0f0"))
                        .textContentType(.password)

                    // Save button for the password
                    Button("Update Password") {
                        // In a real app, this would update Keychain or Config
                        showSavedAlert = true
                    }
                    .foregroundColor(Color(hex: "#2dd4bf"))
                    .disabled(appPassword.isEmpty)
                } header: {
                    Text("Authentication")
                        .foregroundColor(Color(hex: "#2dd4bf"))
                } footer: {
                    Text("This password is used for the app login gate.")
                        .foregroundColor(.gray)
                }

                // MARK: - API Keys Section
                Section {
                    // Supabase anon key
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Supabase Key")
                            .font(.caption)
                            .foregroundColor(.gray)
                        SecureField("Supabase anon key", text: $supabaseKey)
                            .foregroundColor(Color(hex: "#f0f0f0"))
                            .textContentType(.none)
                            .autocorrectionDisabled()
                    }

                    // Replicate API key
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Replicate Key")
                            .font(.caption)
                            .foregroundColor(.gray)
                        SecureField("Replicate API key", text: $replicateKey)
                            .foregroundColor(Color(hex: "#f0f0f0"))
                            .textContentType(.none)
                            .autocorrectionDisabled()
                    }

                    // Anthropic API key
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Anthropic Key")
                            .font(.caption)
                            .foregroundColor(.gray)
                        SecureField("Anthropic API key", text: $anthropicKey)
                            .foregroundColor(Color(hex: "#f0f0f0"))
                            .textContentType(.none)
                            .autocorrectionDisabled()
                    }

                    // Save button for API keys
                    Button("Save Keys") {
                        // In a real app, this would update Keychain
                        showSavedAlert = true
                    }
                    .foregroundColor(Color(hex: "#2dd4bf"))
                } header: {
                    Text("API Keys")
                        .foregroundColor(Color(hex: "#2dd4bf"))
                } footer: {
                    Text("Keys are stored locally on this device.")
                        .foregroundColor(.gray)
                }

                // MARK: - About Section
                Section {
                    HStack {
                        Text("App")
                            .foregroundColor(Color(hex: "#f0f0f0"))
                        Spacer()
                        Text("mixBase")
                            .foregroundColor(Color(hex: "#2dd4bf"))
                            .fontWeight(.semibold)
                    }

                    HStack {
                        Text("Version")
                            .foregroundColor(Color(hex: "#f0f0f0"))
                        Spacer()
                        Text("1.0.0")
                            .foregroundColor(.gray)
                    }

                    HStack {
                        Text("Platform")
                            .foregroundColor(Color(hex: "#f0f0f0"))
                        Spacer()
                        Text("iOS 17+")
                            .foregroundColor(.gray)
                    }
                } header: {
                    Text("About")
                        .foregroundColor(Color(hex: "#2dd4bf"))
                }
            }
            .scrollContentBackground(.hidden) // Hide default white form background
        }
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarColorScheme(.dark, for: .navigationBar)
        // Show a confirmation alert when settings are saved
        .alert("Saved", isPresented: $showSavedAlert) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("Your settings have been updated.")
        }
    }
}
