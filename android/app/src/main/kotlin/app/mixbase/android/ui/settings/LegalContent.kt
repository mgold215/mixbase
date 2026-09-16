package app.mixbase.android.ui.settings

/**
 * Native legal / support documents — rendered in-app, never as links to
 * mixbase.app, so no tap on these screens can leave the app. Same text as
 * ios/mixBase/Views/Settings/SettingsView.swift (LegalContent).
 */
data class LegalSection(val heading: String, val body: String)

data class LegalDoc(val title: String, val updated: String?, val sections: List<LegalSection>)

object LegalContent {

    val docs: Map<String, LegalDoc> = linkedMapOf(
        "privacy" to LegalDoc("Privacy Policy", "April 23, 2026", privacy()),
        "terms" to LegalDoc("Terms of Service", "April 23, 2026", terms()),
        "support" to LegalDoc("Support", null, support()),
    )

    private fun privacy() = listOf(
        LegalSection("1. Who we are",
            "mixBase (\"we\", \"our\", \"the app\") is a music version-control and release-management tool. We are operated as an independent product. Questions can be directed to privacy@mixbase.app."),
        LegalSection("2. Information we collect",
            "Account data — your email address and hashed password, used to authenticate you.\n\nAudio files — the audio files you upload. These are stored in Supabase cloud storage and are private to your account unless you explicitly share them.\n\nProject metadata — titles, BPM, key, genre, notes, and release information you enter.\n\nArtwork images — cover art you upload or generate via AI.\n\nFeedback — comments left by collaborators on your shared tracks (includes the reviewer name they provide).\n\nUsage data — standard server logs (IP address, request timestamps, response codes) retained for up to 30 days for debugging."),
        LegalSection("3. How we use your information",
            "To operate and maintain your account and its associated music projects. To deliver core features: audio playback, version tracking, release pipeline, and share links. To send transactional emails (password reset, account notices) — we do not send marketing email. To diagnose technical issues using anonymised log data.\n\nWe do not sell, rent, or share your personal data or audio files with third parties for advertising purposes."),
        LegalSection("4. Third-party services",
            "Supabase — database and file storage provider. Data is stored in the US-East-1 region.\n\nRailway — application hosting.\n\nReplicate — optional AI artwork generation. Only invoked when you explicitly request artwork generation; your prompts are sent to Replicate's API.\n\nEach provider's own privacy policy is available on its website."),
        LegalSection("5. Data retention",
            "Your account and all associated data (projects, audio files, artwork) are retained for as long as your account is active. You may delete individual projects, versions, or your entire account at any time. Deleted audio files are removed from storage within 24 hours."),
        LegalSection("6. Security",
            "All data is transmitted over HTTPS. Passwords are hashed by Supabase Auth using bcrypt and are never stored in plaintext. Audio files are stored in private Supabase buckets; public URLs are only generated when you create a share link. Share links expire when you delete the corresponding version."),
        LegalSection("7. Your rights",
            "Depending on your jurisdiction you may have the right to: access the personal data we hold about you; correct inaccurate data; request deletion of your account and all associated data; and export your data in a portable format.\n\nTo exercise any of these rights, email privacy@mixbase.app. We will respond within 30 days."),
        LegalSection("8. Children",
            "mixBase is not directed at children under 13 (or under 16 in the EU). We do not knowingly collect personal data from children. If you believe a child has created an account, contact us and we will delete it promptly."),
        LegalSection("9. Changes to this policy",
            "We may update this policy occasionally. Material changes will be communicated via the email address on your account. The \"last updated\" date at the top of this page always reflects the current version."),
        LegalSection("10. Contact", "Privacy questions or requests: privacy@mixbase.app"),
    )

    private fun terms() = listOf(
        LegalSection("1. Acceptance",
            "By creating an account or using mixBase (\"Service\", \"we\", \"our\"), you agree to these Terms. If you do not agree, do not use the Service. These Terms form a binding agreement between you and mixBase."),
        LegalSection("2. Eligibility",
            "You must be at least 13 years old (16 in the EU/EEA) to use mixBase. By using the Service you represent that you meet this requirement."),
        LegalSection("3. Your content",
            "You retain full ownership of all audio files, artwork, notes, and other content you upload (\"User Content\"). By uploading User Content you grant mixBase a limited, worldwide, royalty-free license to store, process, and display your content solely to operate and improve the Service. This license ends when you delete the content or close your account.\n\nYou represent that you own or have all necessary rights to the User Content you upload, and that uploading it does not infringe any third-party rights."),
        LegalSection("4. Acceptable use",
            "You agree not to: upload content you do not have rights to (e.g., commercially released music you do not own); use the Service to infringe any intellectual property rights; attempt to access other users' accounts or data; use automated tools to scrape, crawl, or overload our infrastructure; circumvent any security or access control measures; use the Service for any illegal purpose; or post abusive, harassing, hateful, or otherwise objectionable content anywhere on the Service, including the community feed and comments.\n\nWe have zero tolerance for objectionable content and abusive behavior. Content can be reported and users blocked directly in the apps; we review reports within 24 hours and remove violating content and, where warranted, the accounts that posted it."),
        LegalSection("5. Copyright / DMCA",
            "mixBase respects intellectual property rights and complies with the Digital Millennium Copyright Act (17 U.S.C. § 512). If you believe content on our platform infringes your copyright, please submit a notice to our designated agent via the DMCA page on our website. We will respond to valid notices by removing or disabling access to the allegedly infringing content. Accounts that repeatedly infringe copyrights will be terminated."),
        LegalSection("6. Share links",
            "When you generate a share link for a version, that link becomes accessible to anyone who has it. You control which versions have share links and can revoke access at any time by deleting the version. You are responsible for deciding what you share and with whom."),
        LegalSection("7. Account and security",
            "You are responsible for maintaining the security of your account credentials. Notify us immediately at legal@mixbase.app if you suspect unauthorized access. We are not liable for losses resulting from unauthorized use of your account."),
        LegalSection("8. Pricing",
            "The mixBase app is free to download and use. It offers no purchases, subscriptions, or paid upgrades."),
        LegalSection("9. Disclaimers",
            "THE SERVICE IS PROVIDED \"AS IS\" WITHOUT WARRANTY OF ANY KIND. WE DO NOT GUARANTEE UNINTERRUPTED AVAILABILITY, FREEDOM FROM BUGS, OR THAT YOUR CONTENT WILL NEVER BE LOST. BACK UP CONTENT YOU CARE ABOUT."),
        LegalSection("10. Limitation of liability",
            "To the maximum extent permitted by law, mixBase's liability to you for any claim arising from these Terms or your use of the Service is limited to the greater of (a) the amount you paid us in the 12 months preceding the claim or (b) \$100. We are not liable for indirect, consequential, punitive, or special damages."),
        LegalSection("11. Indemnification",
            "You agree to indemnify and hold harmless mixBase and its affiliates from any claims, losses, or expenses (including legal fees) arising from your User Content, your violation of these Terms, or your infringement of any third-party rights."),
        LegalSection("12. Termination",
            "We may suspend or terminate your account for material violation of these Terms, including copyright infringement, with or without notice. You may close your account at any time by contacting legal@mixbase.app. Upon termination, your content will be deleted within 30 days."),
        LegalSection("13. Governing law",
            "These Terms are governed by the laws of the United States. Disputes will be resolved in the courts of competent jurisdiction. If any provision is found unenforceable, the remainder continues in effect."),
        LegalSection("14. Changes",
            "We may update these Terms. Material changes will be communicated by email or prominent notice in the app at least 14 days before taking effect. Continued use after the effective date constitutes acceptance."),
        LegalSection("15. Contact", "Legal questions: legal@mixbase.app"),
    )

    private fun support() = listOf(
        LegalSection("Need help?",
            "Questions? We're here to help. Email support@mixbase.app and we'll get back to you within 24 hours."),
        LegalSection("How do I upload a new mix?",
            "Open a project, then tap \"Upload new mix\". Select your audio file (WAV, MP3, FLAC, M4A, AAC, or OGG up to 500 MB). The file uploads directly to secure cloud storage — large files are handled automatically."),
        LegalSection("How do share links work?",
            "On any mix, tap the share icon. This generates a unique link anyone can open in a browser — no account required. Listeners can play the track and leave timestamped feedback. You can revoke access by deleting the mix."),
        LegalSection("Can I download my audio files?",
            "Yes. Your own files are always yours — you get back exactly the file you uploaded, at full quality, from the web app. To let the people you share a link with download it too, turn on the download toggle on the mix; a Download button then appears on the share page."),
        LegalSection("What audio formats are supported?",
            "WAV, MP3, FLAC, M4A, AAC, and OGG. For best quality we recommend uploading lossless WAV or FLAC masters and keeping compressed versions for share links."),
        LegalSection("How do I generate AI artwork?",
            "Open a project and choose \"Generate artwork\". Describe the vibe of the track and mixBase will generate a cover using AI. Generations are subject to a monthly quota that resets at the start of each month."),
        LegalSection("What is the Pipeline?",
            "The Pipeline is a release checklist. Add a release, then track milestones like mixing, mastering, artwork, DSP submission, and social posts — all in one place."),
        LegalSection("How do I delete my account?",
            "You can delete your account directly in the app: Settings → Delete Account. This immediately and permanently removes all your data — projects, audio files, artwork, comments, and account credentials. If you prefer, you can also email support@mixbase.app with the subject \"Delete my account\"."),
        LegalSection("Is there a storage limit?",
            "During early access there is no hard storage cap per account. We reserve the right to introduce fair-use limits in the future and will notify you well in advance."),
    )
}
