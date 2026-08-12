import SwiftUI

// MARK: - SettingsView
// Account screen showing user info, legal links, and account deletion.

struct SettingsView: View {

    @EnvironmentObject var authService: AuthService

    // Account deletion flow
    @State private var showDeleteConfirm = false
    @State private var deleteText = ""
    @State private var isDeleting = false
    @State private var deleteError: String? = nil

    var body: some View {
        ZStack {
            Color(hex: "#080808")
                .ignoresSafeArea()

            Form {
                // MARK: - Account Section
                Section {
                    HStack {
                        Text("Email")
                            .foregroundColor(Color(hex: "#f0f0f0"))
                        Spacer()
                        Text(authService.userEmail ?? "—")
                            .foregroundColor(.gray)
                            .lineLimit(1)
                    }
                } header: {
                    Text("Account")
                        .foregroundColor(Color(hex: "#2dd4bf"))
                }

                // MARK: - Legal Section
                Section {
                    Link(destination: URL(string: "https://mixbase.app/privacy")!) {
                        HStack {
                            Text("Privacy Policy")
                                .foregroundColor(Color(hex: "#f0f0f0"))
                            Spacer()
                            Image(systemName: "arrow.up.right")
                                .foregroundColor(.gray)
                                .font(.caption)
                        }
                    }

                    Link(destination: URL(string: "https://mixbase.app/terms")!) {
                        HStack {
                            Text("Terms of Service")
                                .foregroundColor(Color(hex: "#f0f0f0"))
                            Spacer()
                            Image(systemName: "arrow.up.right")
                                .foregroundColor(.gray)
                                .font(.caption)
                        }
                    }

                    Link(destination: URL(string: "https://mixbase.app/support")!) {
                        HStack {
                            Text("Support")
                                .foregroundColor(Color(hex: "#f0f0f0"))
                            Spacer()
                            Image(systemName: "arrow.up.right")
                                .foregroundColor(.gray)
                                .font(.caption)
                        }
                    }
                } header: {
                    Text("Legal")
                        .foregroundColor(Color(hex: "#2dd4bf"))
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
                } header: {
                    Text("About")
                        .foregroundColor(Color(hex: "#2dd4bf"))
                }

                // MARK: - Sign Out
                Section {
                    Button("Sign Out") {
                        authService.signOut()
                    }
                    .foregroundColor(Color(hex: "#2dd4bf"))
                }

                // MARK: - Delete Account
                Section {
                    if !showDeleteConfirm {
                        Button("Delete Account") {
                            showDeleteConfirm = true
                        }
                        .foregroundColor(.red)
                    } else {
                        VStack(alignment: .leading, spacing: 12) {
                            Text("This will permanently delete your account and all your data. This cannot be undone.")
                                .font(.caption)
                                .foregroundColor(.gray)

                            Text("Type DELETE to confirm:")
                                .font(.caption)
                                .foregroundColor(Color(hex: "#f0f0f0"))

                            TextField("DELETE", text: $deleteText)
                                .foregroundColor(Color(hex: "#f0f0f0"))
                                .autocorrectionDisabled()
                                .textInputAutocapitalization(.characters)

                            if let error = deleteError {
                                Text(error)
                                    .font(.caption)
                                    .foregroundColor(.red)
                            }

                            HStack {
                                Button("Permanently Delete") {
                                    Task { await performDelete() }
                                }
                                .foregroundColor(.white)
                                .padding(.horizontal, 16)
                                .padding(.vertical, 8)
                                .background(deleteText == "DELETE" ? Color.red : Color.gray)
                                .cornerRadius(8)
                                .disabled(deleteText != "DELETE" || isDeleting)

                                Button("Cancel") {
                                    showDeleteConfirm = false
                                    deleteText = ""
                                    deleteError = nil
                                }
                                .foregroundColor(.gray)
                            }
                        }
                    }
                } header: {
                    Text("Danger Zone")
                        .foregroundColor(.red)
                } footer: {
                    Text("Deleting your account removes all projects, mixes, collections, and releases.")
                        .foregroundColor(.gray)
                }
            }
            .scrollContentBackground(.hidden)
        }
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarColorScheme(.dark, for: .navigationBar)
    }

    // MARK: - Delete account
    // Guideline 5.1.1(v): this flow must always work. Routed through
    // MixbaseAPI so an expired access token is refreshed and retried instead
    // of dying on a hand-rolled request with a stale cookie.
    private func performDelete() async {
        guard deleteText == "DELETE" else { return }
        isDeleting = true
        deleteError = nil

        do {
            try await MixbaseAPI.shared.deleteAccount()
            // Success — sign out locally
            authService.signOut()
        } catch {
            deleteError = error.localizedDescription
            isDeleting = false
        }
    }
}
