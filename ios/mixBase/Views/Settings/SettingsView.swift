import SwiftUI

// MARK: - SettingsView
// Account screen showing user info, legal links, and account deletion.

struct SettingsView: View {

    @EnvironmentObject var authService: AuthService
    @EnvironmentObject var audioService: AudioService

    // Artist name editing (profiles.artist_name — feeds Now Playing / Bluetooth
    // AVRCP, the Home header, and the public share pages)
    @State private var artistName = ""
    @State private var savedArtistName = ""
    @State private var isSavingArtist = false
    @State private var artistSaved = false
    @State private var artistSaveError: String? = nil

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

                // MARK: - Artist Section
                Section {
                    TextField("Your artist name", text: $artistName)
                        .foregroundColor(Color(hex: "#f0f0f0"))
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.words)
                        .onChange(of: artistName) { _, newValue in
                            // Keep the "Saved" state while the text still matches
                            // what's stored (the save itself re-normalizes the
                            // field, which lands here too).
                            if newValue.trimmingCharacters(in: .whitespaces) != savedArtistName {
                                artistSaved = false
                            }
                            artistSaveError = nil
                        }

                    if let error = artistSaveError {
                        Text(error)
                            .font(.caption)
                            .foregroundColor(.red)
                    }

                    Button(action: { Task { await saveArtistName() } }) {
                        HStack {
                            Text(artistSaved ? "Saved" : "Save")
                            if isSavingArtist {
                                Spacer()
                                ProgressView()
                                    .tint(Color(hex: "#2dd4bf"))
                            }
                        }
                    }
                    .foregroundColor(canSaveArtistName ? Color(hex: "#2dd4bf") : .gray)
                    .disabled(!canSaveArtistName || isSavingArtist)
                } header: {
                    Text("Artist")
                        .foregroundColor(Color(hex: "#2dd4bf"))
                } footer: {
                    Text("Shown as the artist on the lock screen, car displays, and your share pages.")
                        .foregroundColor(.gray)
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
        .task { await loadArtistName() }
    }

    // MARK: - Artist name

    // Saveable when the trimmed value differs from what's stored — including
    // clearing it (an artist can remove the name; displays fall back to defaults).
    private var canSaveArtistName: Bool {
        artistName.trimmingCharacters(in: .whitespaces) != savedArtistName
    }

    private func loadArtistName() async {
        guard let uid = authService.userId else { return }
        let name = await SupabaseService.shared.fetchArtistName(userId: uid)
        savedArtistName = name
        // Don't clobber anything the user already started typing.
        if artistName.isEmpty { artistName = name }
    }

    private func saveArtistName() async {
        guard let uid = authService.userId else { return }
        let trimmed = artistName.trimmingCharacters(in: .whitespaces)
        isSavingArtist = true
        artistSaveError = nil
        defer { isSavingArtist = false }

        do {
            try await SupabaseService.shared.updateArtistName(userId: uid, name: trimmed)
            savedArtistName = trimmed
            artistName = trimmed
            artistSaved = true
            // Repaint Now Playing / Bluetooth and the Home header immediately.
            audioService.artistName = trimmed
        } catch {
            artistSaveError = error.localizedDescription
        }
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
