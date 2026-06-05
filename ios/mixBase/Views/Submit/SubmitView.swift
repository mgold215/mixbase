import SwiftUI

// MARK: - SubmitView
// The SubmitBase tab. Two sections via segmented control:
// 1. Compose — browse curators, select a song, write a pitch, and send
// 2. Tracker — view past submissions with status tracking

struct SubmitView: View {

    @State private var selectedSection = 0  // 0 = Compose, 1 = Tracker

    // Curators data
    @State private var curators: [Curator] = []
    @State private var submissions: [Submission] = []
    @State private var projects: [Project] = []
    @State private var projectVersions: [UUID: [Version]] = [:]
    @State private var isLoading = true

    // Filters
    @State private var searchText = ""
    @State private var filterType: String? = nil

    // Compose state
    @State private var selectedProject: Project? = nil
    @State private var selectedCurator: Curator? = nil
    @State private var pitchMessage = ""
    @State private var showCuratorDetail: Curator? = nil
    @State private var showAddCurator = false
    @State private var isSending = false
    @State private var sentConfirmation = false

    var body: some View {
        NavigationStack {
            ZStack {
                Color(hex: "#080808").ignoresSafeArea()

                VStack(spacing: 0) {
                    // Segmented control
                    Picker("Section", selection: $selectedSection) {
                        Text("Compose").tag(0)
                        Text("Tracker").tag(1)
                    }
                    .pickerStyle(.segmented)
                    .padding(.horizontal)
                    .padding(.top, 8)

                    if selectedSection == 0 {
                        composeSection
                    } else {
                        trackerSection
                    }
                }
            }
            .navigationTitle("SubmitBase")
            .navigationBarTitleDisplayMode(.large)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button(action: { showAddCurator = true }) {
                        Image(systemName: "plus")
                            .foregroundColor(Color(hex: "#2dd4bf"))
                    }
                }
            }
            .task { await loadData() }
            .sheet(isPresented: $showAddCurator) {
                AddCuratorSheet(onSave: { curator in
                    curators.append(curator)
                    curators.sort { $0.name.lowercased() < $1.name.lowercased() }
                })
            }
            .sheet(item: $showCuratorDetail) { curator in
                CuratorDetailSheet(curator: curator, submissions: submissions.filter { $0.curatorId == curator.id.uuidString })
            }
        }
    }

    // MARK: - Compose Section

    private var composeSection: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                // Step 1: Pick a song
                songPicker

                // Step 2: Write your pitch
                pitchEditor

                // Step 3: Browse & send to curators
                curatorDirectory
            }
            .padding(.top, 16)
            .padding(.bottom, 80)
        }
    }

    // MARK: - Song Picker
    private var songPicker: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Select Song")
                .font(.headline)
                .foregroundColor(Color(hex: "#f0f0f0"))
                .padding(.horizontal)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    ForEach(projects) { project in
                        Button(action: { selectedProject = project }) {
                            VStack(spacing: 6) {
                                // Artwork
                                if let url = project.artworkUrl, let imgUrl = URL(string: url) {
                                    AsyncImage(url: imgUrl) { image in
                                        image.resizable().aspectRatio(contentMode: .fill)
                                    } placeholder: {
                                        RoundedRectangle(cornerRadius: 8)
                                            .fill(Color(hex: "#1a1a1a"))
                                    }
                                    .frame(width: 64, height: 64)
                                    .clipShape(RoundedRectangle(cornerRadius: 8))
                                } else {
                                    RoundedRectangle(cornerRadius: 8)
                                        .fill(Color(hex: "#1a1a1a"))
                                        .frame(width: 64, height: 64)
                                        .overlay(
                                            Image(systemName: "music.note")
                                                .foregroundColor(.gray.opacity(0.4))
                                        )
                                }

                                Text(project.title)
                                    .font(.caption2)
                                    .foregroundColor(Color(hex: "#f0f0f0"))
                                    .lineLimit(1)
                                    .frame(width: 64)
                            }
                            .padding(6)
                            .background(
                                selectedProject?.id == project.id
                                    ? Color(hex: "#2dd4bf").opacity(0.15)
                                    : Color.clear
                            )
                            .cornerRadius(10)
                            .overlay(
                                RoundedRectangle(cornerRadius: 10)
                                    .stroke(
                                        selectedProject?.id == project.id
                                            ? Color(hex: "#2dd4bf")
                                            : Color.clear,
                                        lineWidth: 2
                                    )
                            )
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal)
            }
        }
    }

    // MARK: - Pitch Editor
    private var pitchEditor: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Pitch Message")
                .font(.headline)
                .foregroundColor(Color(hex: "#f0f0f0"))
                .padding(.horizontal)

            TextEditor(text: $pitchMessage)
                .scrollContentBackground(.hidden)
                .foregroundColor(Color(hex: "#f0f0f0"))
                .font(.subheadline)
                .frame(minHeight: 100)
                .padding(10)
                .background(Color(hex: "#111111"))
                .cornerRadius(10)
                .padding(.horizontal)
                .onAppear {
                    if pitchMessage.isEmpty {
                        pitchMessage = defaultPitchTemplate()
                    }
                }

            // Template button
            Button(action: { pitchMessage = defaultPitchTemplate() }) {
                HStack(spacing: 4) {
                    Image(systemName: "doc.text")
                    Text("Reset Template")
                }
                .font(.caption)
                .foregroundColor(Color(hex: "#2dd4bf"))
            }
            .padding(.horizontal)
        }
    }

    // MARK: - Curator Directory
    private var curatorDirectory: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Curators")
                    .font(.headline)
                    .foregroundColor(Color(hex: "#f0f0f0"))
                Text("(\(filteredCurators.count))")
                    .font(.subheadline)
                    .foregroundColor(.gray)
                Spacer()
            }
            .padding(.horizontal)

            // Search bar
            HStack {
                Image(systemName: "magnifyingglass")
                    .foregroundColor(.gray)
                TextField("Search curators...", text: $searchText)
                    .foregroundColor(Color(hex: "#f0f0f0"))
            }
            .padding(10)
            .background(Color(hex: "#111111"))
            .cornerRadius(8)
            .padding(.horizontal)

            // Type filter pills
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    filterPill("All", selected: filterType == nil) { filterType = nil }
                    filterPill("Playlist", selected: filterType == "playlist") { filterType = "playlist" }
                    filterPill("Label", selected: filterType == "label") { filterType = "label" }
                    filterPill("Blog", selected: filterType == "blog") { filterType = "blog" }
                    filterPill("Radio", selected: filterType == "radio") { filterType = "radio" }
                    filterPill("Influencer", selected: filterType == "influencer") { filterType = "influencer" }
                }
                .padding(.horizontal)
            }

            // Curator list
            if isLoading {
                ProgressView()
                    .tint(Color(hex: "#2dd4bf"))
                    .frame(maxWidth: .infinity)
                    .padding(.top, 20)
            } else if filteredCurators.isEmpty {
                Text("No curators found")
                    .font(.subheadline)
                    .foregroundColor(.gray)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 20)
            } else {
                LazyVStack(spacing: 8) {
                    ForEach(filteredCurators) { curator in
                        curatorRow(curator: curator)
                    }
                }
                .padding(.horizontal)
            }
        }
    }

    // MARK: - Curator Row
    @ViewBuilder
    private func curatorRow(curator: Curator) -> some View {
        HStack(spacing: 12) {
            // Type icon
            curatorTypeIcon(curator.type)

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(curator.name)
                        .font(.subheadline)
                        .fontWeight(.semibold)
                        .foregroundColor(Color(hex: "#f0f0f0"))
                        .lineLimit(1)

                    // Confidence badge
                    Text(curator.confidence)
                        .font(.system(size: 8, weight: .bold))
                        .foregroundColor(curator.confidence == "VERIFIED" ? .green : .orange)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 2)
                        .background(
                            (curator.confidence == "VERIFIED" ? Color.green : Color.orange)
                                .opacity(0.15)
                        )
                        .cornerRadius(4)
                }

                HStack(spacing: 6) {
                    if let type = curator.type {
                        Text(type.capitalized)
                            .font(.caption2)
                            .foregroundColor(.gray)
                    }
                    if let method = curator.contactMethod {
                        Text("via \(method)")
                            .font(.caption2)
                            .foregroundColor(.gray.opacity(0.6))
                    }
                }
            }

            Spacer()

            // Send button (only if a song is selected)
            if selectedProject != nil {
                Button(action: { Task { await sendPitch(to: curator) } }) {
                    HStack(spacing: 4) {
                        Image(systemName: "paperplane.fill")
                        Text("Send")
                    }
                    .font(.caption2)
                    .fontWeight(.semibold)
                    .foregroundColor(Color(hex: "#080808"))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(Color(hex: "#2dd4bf"))
                    .cornerRadius(6)
                }
            }

            // Info button
            Button(action: { showCuratorDetail = curator }) {
                Image(systemName: "info.circle")
                    .foregroundColor(.gray)
            }
        }
        .padding(12)
        .background(Color(hex: "#111111"))
        .cornerRadius(10)
    }

    // MARK: - Tracker Section

    private var trackerSection: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                // Stats row
                statsRow

                // Submission list
                if submissions.isEmpty {
                    VStack(spacing: 12) {
                        Image(systemName: "paperplane")
                            .font(.system(size: 48))
                            .foregroundColor(.gray.opacity(0.3))
                        Text("No submissions yet")
                            .font(.headline)
                            .foregroundColor(.gray)
                        Text("Send your first pitch from the Compose tab")
                            .font(.subheadline)
                            .foregroundColor(.gray.opacity(0.6))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.top, 40)
                } else {
                    LazyVStack(spacing: 8) {
                        ForEach(submissions) { submission in
                            submissionRow(submission: submission)
                        }
                    }
                    .padding(.horizontal)
                }
            }
            .padding(.top, 16)
            .padding(.bottom, 80)
        }
    }

    // MARK: - Stats Row
    private var statsRow: some View {
        HStack(spacing: 12) {
            statBubble("Total", value: submissions.count, color: "#2dd4bf")
            statBubble("Sent", value: submissions.filter { $0.status == "sent" }.count, color: "#60a5fa")
            statBubble("Accepted", value: submissions.filter { $0.status == "accepted" }.count, color: "#34d399")
            statBubble("Response", value: responseRate, color: "#fbbf24", isPercent: true)
        }
        .padding(.horizontal)
    }

    private var responseRate: Int {
        let sent = submissions.filter { $0.status != "draft" }.count
        guard sent > 0 else { return 0 }
        let responded = submissions.filter { ["responded", "accepted", "rejected"].contains($0.status) }.count
        return Int(Double(responded) / Double(sent) * 100)
    }

    private func statBubble(_ label: String, value: Int, color: String, isPercent: Bool = false) -> some View {
        VStack(spacing: 4) {
            Text(isPercent ? "\(value)%" : "\(value)")
                .font(.title3)
                .fontWeight(.bold)
                .foregroundColor(Color(hex: color))
            Text(label)
                .font(.caption2)
                .foregroundColor(.gray)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
        .background(Color(hex: "#111111"))
        .cornerRadius(10)
    }

    // MARK: - Submission Row
    @ViewBuilder
    private func submissionRow(submission: Submission) -> some View {
        let curator = curators.first(where: { $0.id.uuidString == submission.curatorId })
        let project = projects.first(where: { $0.id.uuidString == submission.projectId })

        HStack(spacing: 12) {
            // Status dot
            Circle()
                .fill(statusColor(submission.status))
                .frame(width: 10, height: 10)

            VStack(alignment: .leading, spacing: 3) {
                Text(curator?.name ?? "Unknown Curator")
                    .font(.subheadline)
                    .fontWeight(.semibold)
                    .foregroundColor(Color(hex: "#f0f0f0"))
                    .lineLimit(1)

                HStack(spacing: 6) {
                    if let project = project {
                        Text(project.title)
                            .font(.caption2)
                            .foregroundColor(Color(hex: "#2dd4bf"))
                    }
                    Text(submission.status.replacingOccurrences(of: "_", with: " ").capitalized)
                        .font(.caption2)
                        .foregroundColor(.gray)
                }
            }

            Spacer()

            // Status picker
            Menu {
                ForEach(["sent", "opened", "responded", "accepted", "rejected", "no_response"], id: \.self) { status in
                    Button(status.replacingOccurrences(of: "_", with: " ").capitalized) {
                        Task { await updateStatus(submission: submission, status: status) }
                    }
                }
            } label: {
                Text(submission.status.replacingOccurrences(of: "_", with: " ").capitalized)
                    .font(.caption2)
                    .fontWeight(.medium)
                    .foregroundColor(statusColor(submission.status))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(statusColor(submission.status).opacity(0.15))
                    .cornerRadius(6)
            }
        }
        .padding(12)
        .background(Color(hex: "#111111"))
        .cornerRadius(10)
    }

    // MARK: - Helpers

    private var filteredCurators: [Curator] {
        curators.filter { curator in
            let matchesSearch = searchText.isEmpty ||
                curator.name.localizedCaseInsensitiveContains(searchText)
            let matchesType = filterType == nil || curator.type == filterType
            return matchesSearch && matchesType
        }
    }

    private func filterPill(_ title: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.caption2)
                .fontWeight(.semibold)
                .foregroundColor(selected ? Color(hex: "#080808") : Color(hex: "#f0f0f0"))
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(selected ? Color(hex: "#2dd4bf") : Color(hex: "#222222"))
                .clipShape(Capsule())
        }
    }

    private func curatorTypeIcon(_ type: String?) -> some View {
        let icon: String
        let color: Color
        switch type {
        case "playlist": icon = "music.note.list"; color = .blue
        case "label": icon = "building.2"; color = .purple
        case "blog": icon = "doc.text"; color = .orange
        case "radio": icon = "radio"; color = .red
        case "influencer": icon = "person.wave.2"; color = .pink
        default: icon = "questionmark.circle"; color = .gray
        }
        return Image(systemName: icon)
            .foregroundColor(color)
            .frame(width: 32, height: 32)
            .background(color.opacity(0.15))
            .clipShape(Circle())
    }

    private func statusColor(_ status: String) -> Color {
        switch status {
        case "sent": return .blue
        case "opened": return .cyan
        case "responded": return .yellow
        case "accepted": return .green
        case "rejected": return .red
        case "no_response": return .gray
        default: return .gray
        }
    }

    private func defaultPitchTemplate() -> String {
        let trackTitle = selectedProject?.title ?? "[track]"
        let genre = selectedProject?.genre ?? "electronic"
        return """
        Hey! I'd love to submit my latest track "\(trackTitle)" for your consideration.

        It's a \(genre) track that I think would be a great fit for your playlist/label.

        Here's the link: [share link]

        Thanks for listening!
        """
    }

    // MARK: - Actions

    private func sendPitch(to curator: Curator) async {
        guard let project = selectedProject else { return }
        isSending = true

        // Find the latest version's share token
        let versions = projectVersions[project.id] ?? []
        let latest = versions.max(by: { $0.versionNumber < $1.versionNumber })
        let shareUrl = latest?.shareToken.map { "https://mixbase.app/share/\($0)" }

        do {
            var fields: [String: Any] = [
                "curator_id": curator.id.uuidString,
                "project_id": project.id.uuidString,
                "channel": curator.contactMethod ?? "email",
                "message": pitchMessage,
            ]
            if let versionId = latest?.id.uuidString { fields["version_id"] = versionId }
            if let url = shareUrl { fields["share_url"] = url }

            let submission = try await SupabaseService.shared.createSubmission(fields)
            submissions.insert(submission, at: 0)
            sentConfirmation = true

            // Brief confirmation then reset
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            sentConfirmation = false
        } catch {
            print("Failed to send pitch: \(error.localizedDescription)")
        }
        isSending = false
    }

    private func updateStatus(submission: Submission, status: String) async {
        do {
            try await SupabaseService.shared.updateSubmissionStatus(id: submission.id, status: status)
            if let idx = submissions.firstIndex(where: { $0.id == submission.id }) {
                submissions[idx] = Submission(
                    id: submission.id, userId: submission.userId,
                    projectId: submission.projectId, versionId: submission.versionId,
                    curatorId: submission.curatorId, channel: submission.channel,
                    message: submission.message, shareUrl: submission.shareUrl,
                    status: status, responseNotes: submission.responseNotes,
                    sentAt: submission.sentAt, createdAt: submission.createdAt
                )
            }
        } catch {
            print("Failed to update status: \(error.localizedDescription)")
        }
    }

    // MARK: - Data Loading

    private func loadData() async {
        isLoading = true
        do {
            async let c = SupabaseService.shared.fetchCurators()
            async let s = SupabaseService.shared.fetchSubmissions()
            async let p = SupabaseService.shared.fetchProjects()
            curators = try await c
            submissions = try await s
            projects = try await p

            // Load versions for all projects (for share tokens)
            for project in projects {
                let versions = try await SupabaseService.shared.fetchVersions(projectId: project.id)
                projectVersions[project.id] = versions
            }
        } catch {
            print("SubmitView: Failed to load data — \(error.localizedDescription)")
        }
        isLoading = false
    }
}

// MARK: - Add Curator Sheet

struct AddCuratorSheet: View {
    @Environment(\.dismiss) private var dismiss
    var onSave: (Curator) -> Void

    @State private var name = ""
    @State private var type = "playlist"
    @State private var contactMethod = "email"
    @State private var contactValue = ""
    @State private var platform = ""
    @State private var notes = ""
    @State private var isSaving = false

    let types = ["playlist", "label", "blog", "radio", "influencer", "other"]
    let methods = ["email", "instagram", "twitter", "soundcloud", "form", "other"]

    var body: some View {
        NavigationStack {
            ZStack {
                Color(hex: "#080808").ignoresSafeArea()
                ScrollView {
                    VStack(spacing: 16) {
                        formField("Name", text: $name)
                        pickerField("Type", selection: $type, options: types)
                        pickerField("Contact Method", selection: $contactMethod, options: methods)
                        formField("Contact Value", text: $contactValue, placeholder: "email or URL")
                        formField("Platform", text: $platform, placeholder: "Spotify, YouTube, etc.")
                        formField("Notes", text: $notes, placeholder: "Your private notes")
                    }
                    .padding()
                }
            }
            .navigationTitle("Add Curator")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .foregroundColor(.gray)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await save() } }
                        .foregroundColor(Color(hex: "#2dd4bf"))
                        .disabled(name.isEmpty || isSaving)
                }
            }
        }
    }

    private func formField(_ label: String, text: Binding<String>, placeholder: String? = nil) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.caption)
                .foregroundColor(.gray)
            TextField(placeholder ?? label, text: text)
                .foregroundColor(Color(hex: "#f0f0f0"))
                .padding(10)
                .background(Color(hex: "#111111"))
                .cornerRadius(8)
        }
    }

    private func pickerField(_ label: String, selection: Binding<String>, options: [String]) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.caption)
                .foregroundColor(.gray)
            Picker(label, selection: selection) {
                ForEach(options, id: \.self) { option in
                    Text(option.capitalized).tag(option)
                }
            }
            .pickerStyle(.segmented)
        }
    }

    private func save() async {
        isSaving = true
        do {
            var fields: [String: Any] = [
                "name": name,
                "type": type,
                "contact_method": contactMethod,
                "accepts_submissions": true,
                "confidence": "UNVERIFIED"
            ]
            if !contactValue.isEmpty { fields["contact_value"] = contactValue }
            if !platform.isEmpty { fields["platform"] = platform }
            if !notes.isEmpty { fields["notes"] = notes }

            let curator = try await SupabaseService.shared.createCurator(fields)
            onSave(curator)
            dismiss()
        } catch {
            print("Failed to save curator: \(error.localizedDescription)")
        }
        isSaving = false
    }
}

// MARK: - Curator Detail Sheet

struct CuratorDetailSheet: View {
    let curator: Curator
    let submissions: [Submission]
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ZStack {
                Color(hex: "#080808").ignoresSafeArea()
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        // Header
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text(curator.name)
                                    .font(.title2)
                                    .fontWeight(.bold)
                                    .foregroundColor(Color(hex: "#f0f0f0"))

                                Text(curator.confidence)
                                    .font(.caption2)
                                    .fontWeight(.bold)
                                    .foregroundColor(curator.confidence == "VERIFIED" ? .green : .orange)
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(
                                        (curator.confidence == "VERIFIED" ? Color.green : Color.orange).opacity(0.15)
                                    )
                                    .cornerRadius(4)
                            }

                            if let type = curator.type {
                                Text(type.capitalized)
                                    .font(.subheadline)
                                    .foregroundColor(.gray)
                            }
                        }

                        // Contact info
                        if let method = curator.contactMethod, let value = curator.contactValue {
                            infoRow("Contact", value: "\(method.capitalized): \(value)")
                        }
                        if let platform = curator.platform {
                            infoRow("Platform", value: platform)
                        }
                        if let genres = curator.genres, !genres.isEmpty {
                            infoRow("Genres", value: genres.joined(separator: ", "))
                        }
                        if let guidelines = curator.guidelines {
                            infoRow("Guidelines", value: guidelines)
                        }
                        if let notes = curator.notes, !notes.isEmpty {
                            infoRow("Notes", value: notes)
                        }

                        // Submission history
                        if !submissions.isEmpty {
                            Text("Submission History (\(submissions.count))")
                                .font(.headline)
                                .foregroundColor(Color(hex: "#f0f0f0"))
                                .padding(.top, 8)

                            ForEach(submissions) { sub in
                                HStack {
                                    Circle()
                                        .fill(sub.status == "accepted" ? Color.green :
                                              sub.status == "rejected" ? Color.red : Color.blue)
                                        .frame(width: 8, height: 8)
                                    Text(sub.status.replacingOccurrences(of: "_", with: " ").capitalized)
                                        .font(.caption)
                                        .foregroundColor(.gray)
                                    Spacer()
                                    Text(sub.sentAt ?? sub.createdAt, style: .date)
                                        .font(.caption2)
                                        .foregroundColor(.gray.opacity(0.6))
                                }
                                .padding(10)
                                .background(Color(hex: "#111111"))
                                .cornerRadius(8)
                            }
                        }
                    }
                    .padding()
                }
            }
            .navigationTitle("Curator")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .foregroundColor(Color(hex: "#2dd4bf"))
                }
            }
        }
    }

    private func infoRow(_ label: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.caption)
                .foregroundColor(.gray)
            Text(value)
                .font(.subheadline)
                .foregroundColor(Color(hex: "#f0f0f0"))
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(hex: "#111111"))
        .cornerRadius(8)
    }
}
