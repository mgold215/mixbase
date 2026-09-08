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
                // Rendered natively, never as links to mixbase.app: every web
                // page there links back to the homepage, which shows web
                // subscription pricing — App Review reads that as the app
                // accessing paid plans (Guideline 3.1.1 rejection, 2026-09-08).
                // Nothing reachable from these screens can leave the app.
                Section {
                    NavigationLink(destination: LegalDocView(
                        title: "Privacy Policy",
                        updated: LegalContent.privacyUpdated,
                        sections: LegalContent.privacy
                    )) {
                        Text("Privacy Policy")
                            .foregroundColor(Color(hex: "#f0f0f0"))
                    }

                    NavigationLink(destination: LegalDocView(
                        title: "Terms of Service",
                        updated: LegalContent.termsUpdated,
                        sections: LegalContent.terms
                    )) {
                        Text("Terms of Service")
                            .foregroundColor(Color(hex: "#f0f0f0"))
                    }

                    NavigationLink(destination: LegalDocView(
                        title: "Support",
                        updated: nil,
                        sections: LegalContent.support
                    )) {
                        Text("Support")
                            .foregroundColor(Color(hex: "#f0f0f0"))
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

// MARK: - Native legal / support screens
// These documents used to open mixbase.app in the browser. Every page there
// carries a "Back to mixBase" link to the homepage, which shows the web
// product's subscription pricing — and App Review reads that as the app
// "accessing paid plans" (Guideline 3.1.1 rejection, 2026-09-08). Rendering
// the documents natively keeps every tap inside the app: no link here (or on
// any screen these push) can reach a page where plans are visible.

struct LegalSectionItem: Identifiable {
    let id: String
    let heading: String
    let body: String

    init(_ heading: String, _ body: String) {
        self.id = heading
        self.heading = heading
        self.body = body
    }
}

struct LegalDocView: View {
    let title: String
    let updated: String?
    let sections: [LegalSectionItem]

    var body: some View {
        ZStack {
            Color(hex: "#080808")
                .ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    if let updated {
                        Text("Last updated: \(updated)")
                            .font(.caption)
                            .foregroundColor(.gray)
                    }

                    ForEach(sections) { section in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(section.heading)
                                .font(.subheadline)
                                .fontWeight(.semibold)
                                .foregroundColor(Color(hex: "#2dd4bf"))
                            // verbatim: rendered as plain text, so addresses in
                            // the copy never become tappable links out of the app
                            Text(verbatim: section.body)
                                .font(.footnote)
                                .foregroundColor(Color(hex: "#c9c4bb"))
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(20)
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarColorScheme(.dark, for: .navigationBar)
    }
}

enum LegalContent {

    static let privacyUpdated = "April 23, 2026"
    static let termsUpdated = "April 23, 2026"

    static let privacy: [LegalSectionItem] = [
        .init("1. Who we are",
              "mixBase (\"we\", \"our\", \"the app\") is a music version-control and release-management tool. We are operated as an independent product. Questions can be directed to privacy@mixbase.app."),
        .init("2. Information we collect",
              "Account data — your email address and hashed password, used to authenticate you.\n\nAudio files — the audio files you upload. These are stored in Supabase cloud storage and are private to your account unless you explicitly share them.\n\nProject metadata — titles, BPM, key, genre, notes, and release information you enter.\n\nArtwork images — cover art you upload or generate via AI.\n\nFeedback — comments left by collaborators on your shared tracks (includes the reviewer name they provide).\n\nUsage data — standard server logs (IP address, request timestamps, response codes) retained for up to 30 days for debugging."),
        .init("3. How we use your information",
              "To operate and maintain your account and its associated music projects. To deliver core features: audio playback, version tracking, release pipeline, and share links. To send transactional emails (password reset, account notices) — we do not send marketing email. To diagnose technical issues using anonymised log data.\n\nWe do not sell, rent, or share your personal data or audio files with third parties for advertising purposes."),
        .init("4. Third-party services",
              "Supabase — database and file storage provider. Data is stored in the US-East-1 region.\n\nRailway — application hosting.\n\nReplicate — optional AI artwork generation. Only invoked when you explicitly request artwork generation; your prompts are sent to Replicate's API.\n\nEach provider's own privacy policy is available on its website."),
        .init("5. Data retention",
              "Your account and all associated data (projects, audio files, artwork) are retained for as long as your account is active. You may delete individual projects, versions, or your entire account at any time. Deleted audio files are removed from storage within 24 hours."),
        .init("6. Security",
              "All data is transmitted over HTTPS. Passwords are hashed by Supabase Auth using bcrypt and are never stored in plaintext. Audio files are stored in private Supabase buckets; public URLs are only generated when you create a share link. Share links expire when you delete the corresponding version."),
        .init("7. Your rights",
              "Depending on your jurisdiction you may have the right to: access the personal data we hold about you; correct inaccurate data; request deletion of your account and all associated data; and export your data in a portable format.\n\nTo exercise any of these rights, email privacy@mixbase.app. We will respond within 30 days."),
        .init("8. Children",
              "mixBase is not directed at children under 13 (or under 16 in the EU). We do not knowingly collect personal data from children. If you believe a child has created an account, contact us and we will delete it promptly."),
        .init("9. Changes to this policy",
              "We may update this policy occasionally. Material changes will be communicated via the email address on your account. The \"last updated\" date at the top of this page always reflects the current version."),
        .init("10. Contact",
              "Privacy questions or requests: privacy@mixbase.app"),
    ]

    static let terms: [LegalSectionItem] = [
        .init("1. Acceptance",
              "By creating an account or using mixBase (\"Service\", \"we\", \"our\"), you agree to these Terms. If you do not agree, do not use the Service. These Terms form a binding agreement between you and mixBase."),
        .init("2. Eligibility",
              "You must be at least 13 years old (16 in the EU/EEA) to use mixBase. By using the Service you represent that you meet this requirement."),
        .init("3. Your content",
              "You retain full ownership of all audio files, artwork, notes, and other content you upload (\"User Content\"). By uploading User Content you grant mixBase a limited, worldwide, royalty-free license to store, process, and display your content solely to operate and improve the Service. This license ends when you delete the content or close your account.\n\nYou represent that you own or have all necessary rights to the User Content you upload, and that uploading it does not infringe any third-party rights."),
        .init("4. Acceptable use",
              "You agree not to: upload content you do not have rights to (e.g., commercially released music you do not own); use the Service to infringe any intellectual property rights; attempt to access other users' accounts or data; use automated tools to scrape, crawl, or overload our infrastructure; circumvent any security or access control measures; use the Service for any illegal purpose; or post abusive, harassing, hateful, or otherwise objectionable content anywhere on the Service, including the community feed and comments.\n\nWe have zero tolerance for objectionable content and abusive behavior. Content can be reported and users blocked directly in the apps; we review reports within 24 hours and remove violating content and, where warranted, the accounts that posted it."),
        .init("5. Copyright / DMCA",
              "mixBase respects intellectual property rights and complies with the Digital Millennium Copyright Act (17 U.S.C. § 512). If you believe content on our platform infringes your copyright, please submit a notice to our designated agent via the DMCA page on our website. We will respond to valid notices by removing or disabling access to the allegedly infringing content. Accounts that repeatedly infringe copyrights will be terminated."),
        .init("6. Share links",
              "When you generate a share link for a version, that link becomes accessible to anyone who has it. You control which versions have share links and can revoke access at any time by deleting the version. You are responsible for deciding what you share and with whom."),
        .init("7. Account and security",
              "You are responsible for maintaining the security of your account credentials. Notify us immediately at legal@mixbase.app if you suspect unauthorized access. We are not liable for losses resulting from unauthorized use of your account."),
        .init("8. Pricing",
              "The mixBase app is free to download and use. It offers no purchases, subscriptions, or paid upgrades."),
        .init("9. Disclaimers",
              "THE SERVICE IS PROVIDED \"AS IS\" WITHOUT WARRANTY OF ANY KIND. WE DO NOT GUARANTEE UNINTERRUPTED AVAILABILITY, FREEDOM FROM BUGS, OR THAT YOUR CONTENT WILL NEVER BE LOST. BACK UP CONTENT YOU CARE ABOUT."),
        .init("10. Limitation of liability",
              "To the maximum extent permitted by law, mixBase's liability to you for any claim arising from these Terms or your use of the Service is limited to the greater of (a) the amount you paid us in the 12 months preceding the claim or (b) $100. We are not liable for indirect, consequential, punitive, or special damages."),
        .init("11. Indemnification",
              "You agree to indemnify and hold harmless mixBase and its affiliates from any claims, losses, or expenses (including legal fees) arising from your User Content, your violation of these Terms, or your infringement of any third-party rights."),
        .init("12. Termination",
              "We may suspend or terminate your account for material violation of these Terms, including copyright infringement, with or without notice. You may close your account at any time by contacting legal@mixbase.app. Upon termination, your content will be deleted within 30 days."),
        .init("13. Governing law",
              "These Terms are governed by the laws of the United States. Disputes will be resolved in the courts of competent jurisdiction. If any provision is found unenforceable, the remainder continues in effect."),
        .init("14. Changes",
              "We may update these Terms. Material changes will be communicated by email or prominent notice in the app at least 14 days before taking effect. Continued use after the effective date constitutes acceptance."),
        .init("15. Contact",
              "Legal questions: legal@mixbase.app"),
    ]

    static let support: [LegalSectionItem] = [
        .init("Need help?",
              "Questions? We're here to help. Email support@mixbase.app and we'll get back to you within 24 hours."),
        .init("How do I upload a new version of a track?",
              "Open a project, then tap \"Upload new version\". Select your audio file (WAV, MP3, FLAC, M4A, AAC, or OGG up to 500 MB). The file uploads directly to secure cloud storage — large files are handled automatically."),
        .init("How do share links work?",
              "On any version, tap \"Share\". This generates a unique link anyone can open in a browser — no account required. Listeners can play the track and leave timestamped feedback. You can revoke access by deleting the version."),
        .init("Can I download my audio files?",
              "Yes. Your own files are always downloadable from within the app via the \"Original\" link on any mix — you get back exactly the file you uploaded, at full WAV quality. To let the people you share a link with download it too, tick \"Let people with the share link download this file\" on the mix; a Download button then appears on the share page."),
        .init("What audio formats are supported?",
              "WAV, MP3, FLAC, M4A, AAC, and OGG. For best quality we recommend uploading lossless WAV or FLAC masters and keeping compressed versions for share links."),
        .init("How do I generate AI artwork?",
              "Open a project and tap \"Generate Artwork\". Describe the vibe of the track and mixBase will generate options using AI. Generations are subject to a monthly quota that resets at the start of each month."),
        .init("What is the Pipeline?",
              "The Pipeline is a release checklist. Add a release, then track milestones like mixing, mastering, artwork, DSP submission, and social posts — all in one place."),
        .init("How do I delete my account?",
              "You can delete your account directly in the app: Settings → Delete Account. This immediately and permanently removes all your data — projects, audio files, artwork, comments, and account credentials. If you prefer, you can also email support@mixbase.app with the subject \"Delete my account\"."),
        .init("Is there a storage limit?",
              "During early access there is no hard storage cap per account. We reserve the right to introduce fair-use limits in the future and will notify you well in advance."),
    ]
}
