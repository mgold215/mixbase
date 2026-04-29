import SwiftUI

// MARK: - ProjectsView
// Two sections: Tracks (project grid) and Collections (playlists/EPs/albums).
// Segmented picker at top to switch between them.

struct ProjectsView: View {

    @EnvironmentObject var audioService: AudioService

    // Segment selection: 0 = Tracks, 1 = Collections
    @State private var selectedSegment = 0

    // Projects data
    @State private var projects: [Project] = []
    @State private var latestVersions: [UUID: Version] = [:]

    // Collections data
    @State private var collections: [Collection] = []

    // Sheets
    @State private var showNewProject = false
    @State private var showNewCollection = false

    // Loading
    @State private var isLoading = true

    // 2-column grid
    private let columns = [
        GridItem(.flexible(), spacing: 12),
        GridItem(.flexible(), spacing: 12)
    ]

    var body: some View {
        NavigationStack {
            ZStack {
                Color(hex: "#080808")
                    .ignoresSafeArea()

                VStack(spacing: 0) {
                    // MARK: - Segment Picker
                    Picker("", selection: $selectedSegment) {
                        Text("Tracks").tag(0)
                        Text("Collections").tag(1)
                    }
                    .pickerStyle(.segmented)
                    .padding(.horizontal)
                    .padding(.top, 8)

                    // MARK: - Content
                    ScrollView {
                        if isLoading {
                            ProgressView()
                                .tint(Color(hex: "#2dd4bf"))
                                .padding(.top, 60)
                        } else if selectedSegment == 0 {
                            tracksGrid
                        } else {
                            collectionsSection
                        }
                    }
                }
            }
            .navigationTitle("Projects")
            .navigationBarTitleDisplayMode(.large)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button(action: {
                        if selectedSegment == 0 {
                            showNewProject = true
                        } else {
                            showNewCollection = true
                        }
                    }) {
                        Image(systemName: "plus")
                            .foregroundColor(Color(hex: "#2dd4bf"))
                    }
                }
            }
            .task {
                await loadAll()
            }
        }
        // Sheets must be on NavigationStack (not inner ZStack) for reliable iPad presentation
        .sheet(isPresented: $showNewProject) {
            NewProjectView(onCreated: {
                Task { await loadProjects() }
            })
        }
        .sheet(isPresented: $showNewCollection) {
            NewCollectionSheet(projects: projects) { collection in
                collections.insert(collection, at: 0)
            }
        }
    }

    // MARK: - Tracks Grid
    private var tracksGrid: some View {
        Group {
            if projects.isEmpty {
                VStack(spacing: 12) {
                    Image(systemName: "music.note.list")
                        .font(.system(size: 48))
                        .foregroundColor(.gray)
                    Text("No projects yet")
                        .font(.headline)
                        .foregroundColor(.gray)
                    Text("Tap + to create your first project")
                        .font(.subheadline)
                        .foregroundColor(.gray.opacity(0.6))
                }
                .padding(.top, 80)
            } else {
                LazyVGrid(columns: columns, spacing: 16) {
                    ForEach(projects) { project in
                        NavigationLink(destination: ProjectDetailView(projectId: project.id)) {
                            projectCard(project: project)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal)
                .padding(.top, 12)
                .padding(.bottom, 80)
            }
        }
    }

    // MARK: - Collections Section
    private var collectionsSection: some View {
        Group {
            if collections.isEmpty {
                VStack(spacing: 12) {
                    Image(systemName: "rectangle.stack.badge.plus")
                        .font(.system(size: 48))
                        .foregroundColor(.gray)
                    Text("No collections yet")
                        .font(.headline)
                        .foregroundColor(.gray)
                    Text("Create a playlist, EP, or album")
                        .font(.subheadline)
                        .foregroundColor(.gray.opacity(0.6))
                }
                .padding(.top, 80)
            } else {
                LazyVStack(spacing: 12) {
                    ForEach(collections) { collection in
                        NavigationLink(destination: CollectionDetailView(
                            collection: collection,
                            allProjects: projects
                        )) {
                            collectionRow(collection: collection)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal)
                .padding(.top, 12)
                .padding(.bottom, 80)
            }
        }
    }

    // MARK: - Project Card
    @ViewBuilder
    private func projectCard(project: Project) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            ZStack(alignment: .bottomTrailing) {
                if let artworkUrl = project.artworkUrl, let url = URL(string: artworkUrl) {
                    AsyncImage(url: url) { image in
                        image.resizable().aspectRatio(contentMode: .fill)
                    } placeholder: {
                        artworkPlaceholder
                    }
                    .frame(height: 140)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                } else {
                    artworkPlaceholder
                        .frame(height: 140)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                }

                if let version = latestVersions[project.id] {
                    Button(action: {
                        audioService.play(
                            version: version,
                            trackName: project.title,
                            artworkUrl: project.artworkUrl
                        )
                    }) {
                        ZStack {
                            Circle()
                                .fill(Color(hex: "#2dd4bf"))
                                .frame(width: 32, height: 32)
                            if audioService.currentVersion?.projectId == project.id && audioService.isPlaying {
                                Image(systemName: "waveform")
                                    .font(.system(size: 12))
                                    .foregroundColor(Color(hex: "#080808"))
                            } else {
                                Image(systemName: "play.fill")
                                    .font(.system(size: 12))
                                    .foregroundColor(Color(hex: "#080808"))
                            }
                        }
                    }
                    .padding(6)
                }
            }

            Text(project.title)
                .font(.subheadline)
                .fontWeight(.semibold)
                .foregroundColor(Color(hex: "#f0f0f0"))
                .lineLimit(1)

            HStack(spacing: 4) {
                if let genre = project.genre {
                    Text(genre)
                        .font(.caption2)
                        .foregroundColor(.gray)
                }
                if let bpm = project.bpm {
                    Text("- \(bpm) BPM")
                        .font(.caption2)
                        .foregroundColor(.gray)
                }
            }

            StatusBadge(status: "WIP")
        }
        .padding(10)
        .background(Color(hex: "#111111"))
        .cornerRadius(12)
    }

    // MARK: - Collection Row
    private func collectionRow(collection: Collection) -> some View {
        HStack(spacing: 14) {
            // Type icon
            ZStack {
                RoundedRectangle(cornerRadius: 10)
                    .fill(Color(hex: "#1a1a1a"))
                    .frame(width: 56, height: 56)
                Image(systemName: iconForType(collection.type))
                    .font(.title3)
                    .foregroundColor(colorForType(collection.type))
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(collection.title)
                    .font(.subheadline)
                    .fontWeight(.semibold)
                    .foregroundColor(Color(hex: "#f0f0f0"))

                HStack(spacing: 8) {
                    Text(collection.type.uppercased())
                        .font(.caption2)
                        .fontWeight(.medium)
                        .foregroundColor(colorForType(collection.type))

                    if let date = collection.releaseDate {
                        Text(date, style: .date)
                            .font(.caption2)
                            .foregroundColor(.gray)
                    }
                }
            }

            Spacer()

            Image(systemName: "chevron.right")
                .font(.caption)
                .foregroundColor(.gray.opacity(0.5))
        }
        .padding(12)
        .background(Color(hex: "#111111"))
        .cornerRadius(12)
    }

    private var artworkPlaceholder: some View {
        RoundedRectangle(cornerRadius: 10)
            .fill(Color(hex: "#1a1a1a"))
            .overlay(
                Image(systemName: "music.note")
                    .font(.title)
                    .foregroundColor(.gray.opacity(0.4))
            )
    }

    private func iconForType(_ type: String) -> String {
        switch type {
        case "album": return "opticaldisc"
        case "ep": return "square.stack"
        case "playlist": return "music.note.list"
        default: return "music.note.list"
        }
    }

    private func colorForType(_ type: String) -> Color {
        switch type {
        case "album": return Color(hex: "#2dd4bf")
        case "ep": return .purple
        case "playlist": return .yellow
        default: return .gray
        }
    }

    // MARK: - Data Loading
    private func loadAll() async {
        isLoading = true
        await withTaskGroup(of: Void.self) { group in
            group.addTask { await loadProjects() }
            group.addTask { await loadCollections() }
        }
        isLoading = false
    }

    private func loadProjects() async {
        do {
            projects = try await SupabaseService.shared.fetchProjects()
            var versions: [UUID: Version] = [:]
            for project in projects {
                let projectVersions = try await SupabaseService.shared.fetchVersions(projectId: project.id)
                if let latest = projectVersions.max(by: { $0.versionNumber < $1.versionNumber }) {
                    versions[project.id] = latest
                }
            }
            latestVersions = versions
        } catch {
            print("ProjectsView: Failed to load projects — \(error.localizedDescription)")
        }
    }

    private func loadCollections() async {
        do {
            collections = try await SupabaseService.shared.fetchCollections()
        } catch {
            print("ProjectsView: Failed to load collections — \(error.localizedDescription)")
        }
    }
}

// MARK: - New Collection Sheet
// Quick sheet to create a playlist, EP, or album

struct NewCollectionSheet: View {

    @Environment(\.dismiss) private var dismiss
    let projects: [Project]
    var onCreated: (Collection) -> Void

    @State private var title = ""
    @State private var type = "playlist"
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    private let types = ["playlist", "ep", "album"]

    var body: some View {
        NavigationStack {
            ZStack {
                Color(hex: "#080808").ignoresSafeArea()

                Form {
                    Section {
                        TextField("Collection name", text: $title)
                            .foregroundColor(Color(hex: "#f0f0f0"))
                    } header: {
                        Text("Title *")
                            .foregroundColor(Color(hex: "#2dd4bf"))
                    }

                    Section {
                        Picker("Type", selection: $type) {
                            Text("Playlist").tag("playlist")
                            Text("EP").tag("ep")
                            Text("Album").tag("album")
                        }
                        .pickerStyle(.segmented)
                    } header: {
                        Text("Type")
                            .foregroundColor(.gray)
                    }

                    if let errorMessage {
                        Section {
                            Text(errorMessage)
                                .foregroundColor(.red)
                                .font(.caption)
                        }
                    }

                    Section {
                        Button(action: create) {
                            if isSubmitting {
                                ProgressView().tint(Color(hex: "#2dd4bf"))
                            } else {
                                Text("Create")
                                    .fontWeight(.semibold)
                                    .foregroundColor(Color(hex: "#080808"))
                                    .frame(maxWidth: .infinity)
                            }
                        }
                        .listRowBackground(
                            title.isEmpty ? Color.gray.opacity(0.3) : Color(hex: "#2dd4bf")
                        )
                        .disabled(title.isEmpty || isSubmitting)
                    }
                }
                .scrollContentBackground(.hidden)
            }
            .navigationTitle("New Collection")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .foregroundColor(.gray)
                }
            }
        }
    }

    private func create() {
        isSubmitting = true
        Task {
            do {
                let collection = try await SupabaseService.shared.createCollection(
                    title: title.trimmingCharacters(in: .whitespaces),
                    type: type
                )
                onCreated(collection)
                dismiss()
            } catch {
                errorMessage = error.localizedDescription
                isSubmitting = false
            }
        }
    }
}

// MARK: - Collection Detail View
// Shows tracks in a collection with drag-to-reorder and add/remove

struct CollectionDetailView: View {

    let collection: Collection
    let allProjects: [Project]

    @EnvironmentObject var audioService: AudioService

    @State private var items: [CollectionItem] = []
    @State private var isLoading = true
    @State private var showAddTrack = false

    // Map project IDs to projects for quick lookup
    private var projectMap: [UUID: Project] {
        Dictionary(uniqueKeysWithValues: allProjects.map { ($0.id, $0) })
    }

    var body: some View {
        ZStack {
            Color(hex: "#080808").ignoresSafeArea()

            if isLoading {
                ProgressView().tint(Color(hex: "#2dd4bf"))
            } else {
                List {
                    // MARK: - Collection Info Header
                    Section {
                        HStack(spacing: 12) {
                            ZStack {
                                RoundedRectangle(cornerRadius: 12)
                                    .fill(Color(hex: "#1a1a1a"))
                                    .frame(width: 72, height: 72)
                                Image(systemName: collection.type == "album" ? "opticaldisc" : collection.type == "ep" ? "square.stack" : "music.note.list")
                                    .font(.title2)
                                    .foregroundColor(Color(hex: "#2dd4bf"))
                            }

                            VStack(alignment: .leading, spacing: 4) {
                                Text(collection.title)
                                    .font(.title3)
                                    .fontWeight(.bold)
                                    .foregroundColor(Color(hex: "#f0f0f0"))
                                Text("\(collection.type.uppercased()) - \(items.count) tracks")
                                    .font(.caption)
                                    .foregroundColor(.gray)
                            }
                        }
                        .listRowBackground(Color(hex: "#080808"))
                    }

                    // MARK: - Track List (reorderable)
                    Section {
                        ForEach(items) { item in
                            if let project = projectMap[item.projectId] {
                                HStack(spacing: 12) {
                                    Text("\(item.position + 1)")
                                        .font(.caption)
                                        .fontWeight(.bold)
                                        .foregroundColor(Color(hex: "#2dd4bf"))
                                        .frame(width: 24)

                                    // Artwork thumbnail
                                    if let artworkUrl = project.artworkUrl, let url = URL(string: artworkUrl) {
                                        AsyncImage(url: url) { image in
                                            image.resizable().aspectRatio(contentMode: .fill)
                                        } placeholder: {
                                            RoundedRectangle(cornerRadius: 6)
                                                .fill(Color(hex: "#1a1a1a"))
                                        }
                                        .frame(width: 40, height: 40)
                                        .clipShape(RoundedRectangle(cornerRadius: 6))
                                    } else {
                                        RoundedRectangle(cornerRadius: 6)
                                            .fill(Color(hex: "#1a1a1a"))
                                            .frame(width: 40, height: 40)
                                            .overlay(
                                                Image(systemName: "music.note")
                                                    .font(.caption2)
                                                    .foregroundColor(.gray.opacity(0.4))
                                            )
                                    }

                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(project.title)
                                            .font(.subheadline)
                                            .fontWeight(.medium)
                                            .foregroundColor(Color(hex: "#f0f0f0"))
                                        if let genre = project.genre {
                                            Text(genre)
                                                .font(.caption2)
                                                .foregroundColor(.gray)
                                        }
                                    }

                                    Spacer()
                                }
                                .listRowBackground(Color(hex: "#111111"))
                            }
                        }
                        .onMove(perform: moveItems)
                        .onDelete(perform: deleteItems)
                    } header: {
                        Text("Tracklist")
                            .foregroundColor(Color(hex: "#f0f0f0"))
                    }

                    // MARK: - Add Track Button
                    Section {
                        Button(action: { showAddTrack = true }) {
                            HStack {
                                Image(systemName: "plus.circle.fill")
                                    .foregroundColor(Color(hex: "#2dd4bf"))
                                Text("Add Track")
                                    .foregroundColor(Color(hex: "#2dd4bf"))
                            }
                        }
                        .listRowBackground(Color(hex: "#111111"))
                    }
                }
                .listStyle(.insetGrouped)
                .scrollContentBackground(.hidden)
                .environment(\.editMode, .constant(.active))
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbarColorScheme(.dark, for: .navigationBar)
        .sheet(isPresented: $showAddTrack) {
            AddTrackSheet(
                collectionId: collection.id,
                allProjects: allProjects,
                existingProjectIds: Set(items.map(\.projectId)),
                nextPosition: items.count
            ) {
                Task { await loadItems() }
            }
        }
        .task {
            await loadItems()
        }
    }

    private func loadItems() async {
        isLoading = true
        do {
            items = try await SupabaseService.shared.fetchCollectionItems(collectionId: collection.id)
        } catch {
            print("CollectionDetail: Failed to load items — \(error.localizedDescription)")
        }
        isLoading = false
    }

    private func moveItems(from source: IndexSet, to destination: Int) {
        items.move(fromOffsets: source, toOffset: destination)
        // Update positions in Supabase
        Task {
            for (index, item) in items.enumerated() {
                try? await SupabaseService.shared.updateCollectionItemPosition(
                    itemId: item.id,
                    position: index
                )
            }
        }
    }

    private func deleteItems(at offsets: IndexSet) {
        let toDelete = offsets.map { items[$0] }
        items.remove(atOffsets: offsets)
        Task {
            for item in toDelete {
                try? await SupabaseService.shared.removeFromCollection(itemId: item.id)
            }
        }
    }
}

// MARK: - Add Track Sheet
// Pick a project to add to a collection

struct AddTrackSheet: View {

    @Environment(\.dismiss) private var dismiss

    let collectionId: UUID
    let allProjects: [Project]
    let existingProjectIds: Set<UUID>
    let nextPosition: Int
    var onAdded: () -> Void

    // Projects not already in the collection
    private var availableProjects: [Project] {
        allProjects.filter { !existingProjectIds.contains($0.id) }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Color(hex: "#080808").ignoresSafeArea()

                if availableProjects.isEmpty {
                    VStack(spacing: 8) {
                        Text("All tracks already added")
                            .font(.subheadline)
                            .foregroundColor(.gray)
                    }
                } else {
                    List {
                        ForEach(availableProjects) { project in
                            Button(action: { addProject(project) }) {
                                HStack(spacing: 12) {
                                    if let artworkUrl = project.artworkUrl, let url = URL(string: artworkUrl) {
                                        AsyncImage(url: url) { image in
                                            image.resizable().aspectRatio(contentMode: .fill)
                                        } placeholder: {
                                            RoundedRectangle(cornerRadius: 6)
                                                .fill(Color(hex: "#1a1a1a"))
                                        }
                                        .frame(width: 44, height: 44)
                                        .clipShape(RoundedRectangle(cornerRadius: 6))
                                    } else {
                                        RoundedRectangle(cornerRadius: 6)
                                            .fill(Color(hex: "#1a1a1a"))
                                            .frame(width: 44, height: 44)
                                            .overlay(
                                                Image(systemName: "music.note")
                                                    .font(.caption)
                                                    .foregroundColor(.gray.opacity(0.4))
                                            )
                                    }

                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(project.title)
                                            .font(.subheadline)
                                            .fontWeight(.medium)
                                            .foregroundColor(Color(hex: "#f0f0f0"))
                                        if let genre = project.genre {
                                            Text(genre)
                                                .font(.caption2)
                                                .foregroundColor(.gray)
                                        }
                                    }

                                    Spacer()

                                    Image(systemName: "plus.circle")
                                        .foregroundColor(Color(hex: "#2dd4bf"))
                                }
                            }
                            .listRowBackground(Color(hex: "#111111"))
                        }
                    }
                    .listStyle(.insetGrouped)
                    .scrollContentBackground(.hidden)
                }
            }
            .navigationTitle("Add Track")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                        .foregroundColor(Color(hex: "#2dd4bf"))
                }
            }
        }
    }

    private func addProject(_ project: Project) {
        Task {
            do {
                _ = try await SupabaseService.shared.addToCollection(
                    collectionId: collectionId,
                    projectId: project.id,
                    position: nextPosition
                )
                onAdded()
                dismiss()
            } catch {
                print("Failed to add track: \(error.localizedDescription)")
            }
        }
    }
}
