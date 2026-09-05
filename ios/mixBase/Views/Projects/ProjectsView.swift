import SwiftUI
import PhotosUI
#if os(macOS)
import AppKit
#endif

// MARK: - ProjectsView
// Two sections: Tracks (project grid) and Collections (playlists/EPs/albums).
// Segmented picker at top to switch between them.

struct ProjectsView: View {

    @EnvironmentObject var audioService: AudioService

    // Set by ContentView when a widget deep link (mixbase://new-project) asks
    // for the New Project sheet; consumed (reset to false) here.
    @Binding var openNewProject: Bool

    // Segment selection: 0 = Tracks, 1 = Collections
    @State private var selectedSegment = 0

    // Projects data
    @State private var projects: [Project] = []
    @State private var latestVersions: [UUID: Version] = [:]

    // Collections data
    @State private var collections: [Collection] = []
    // Collection id → its items (ONE query for the whole list): fallback covers
    // (first track's artwork when no cover is set) and track counts.
    @State private var collectionItems: [UUID: [CollectionItem]] = [:]

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
                    .refreshable {
                        await loadAll()
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
        // Widget deep link → New Project sheet. onChange covers the tab
        // already being alive; onAppear covers a first-time tab build, where
        // the flag was set before this view existed to observe it.
        .onChange(of: openNewProject) { _, requested in
            if requested { consumeNewProjectRequest() }
        }
        .onAppear {
            if openNewProject { consumeNewProjectRequest() }
        }
    }

    private func consumeNewProjectRequest() {
        selectedSegment = 0
        showNewProject = true
        openNewProject = false
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
                            allProjects: projects,
                            onUpdated: { updated in
                                if let idx = collections.firstIndex(where: { $0.id == updated.id }) {
                                    collections[idx] = updated
                                }
                            },
                            onDeleted: { id in
                                collections.removeAll { $0.id == id }
                                collectionItems[id] = nil
                            },
                            onItemsChanged: { id, newItems in
                                collectionItems[id] = newItems
                            }
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
                            artworkUrl: project.artworkUrl,
                            visualizerUrl: project.visualizerUrl
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

            StatusBadge(status: "Mix")
        }
        .padding(10)
        .background(Color(hex: "#111111"))
        .cornerRadius(12)
    }

    // MARK: - Collection Row
    private func collectionRow(collection: Collection) -> some View {
        HStack(spacing: 14) {
            // Cover — falls back to the first track's artwork, then the type icon
            if let cover = collectionCoverUrl(collection), let url = URL(string: cover) {
                AsyncImage(url: url) { image in
                    image.resizable().aspectRatio(contentMode: .fill)
                } placeholder: {
                    RoundedRectangle(cornerRadius: 10).fill(Color(hex: "#1a1a1a"))
                }
                .frame(width: 56, height: 56)
                .clipShape(RoundedRectangle(cornerRadius: 10))
            } else {
                ZStack {
                    RoundedRectangle(cornerRadius: 10)
                        .fill(Color(hex: "#1a1a1a"))
                        .frame(width: 56, height: 56)
                    Image(systemName: iconForType(collection.type))
                        .font(.title3)
                        .foregroundColor(colorForType(collection.type))
                }
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

                    let count = collectionItems[collection.id]?.count ?? 0
                    Text("\(count) track\(count == 1 ? "" : "s")")
                        .font(.caption2)
                        .foregroundColor(.gray)

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
            // Latest version per project, fetched concurrently
            let projectIds = projects.map(\.id)
            latestVersions = await withTaskGroup(of: (UUID, Version?).self) { group in
                for id in projectIds {
                    group.addTask {
                        let projectVersions = (try? await SupabaseService.shared.fetchVersions(projectId: id)) ?? []
                        return (id, projectVersions.max(by: { $0.versionNumber < $1.versionNumber }))
                    }
                }
                var result: [UUID: Version] = [:]
                for await (id, latest) in group {
                    if let latest { result[id] = latest }
                }
                return result
            }
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
        // Covers/counts are decoration — their failure must not blank the list.
        if let items = try? await SupabaseService.shared.fetchAllCollectionItems() {
            collectionItems = Dictionary(grouping: items, by: \.collectionId)
        }
    }

    // The image shown for a collection: its cover, else the legacy artwork
    // column, else the first track's artwork.
    private func collectionCoverUrl(_ collection: Collection) -> String? {
        if let cover = collection.coverUrl, !cover.isEmpty { return cover }
        if let legacy = collection.artworkUrl, !legacy.isEmpty { return legacy }
        let projectMap = Dictionary(uniqueKeysWithValues: projects.map { ($0.id, $0) })
        for item in (collectionItems[collection.id] ?? []).sorted(by: { $0.position < $1.position }) {
            if let art = projectMap[item.projectId]?.artworkUrl, !art.isEmpty { return art }
        }
        return nil
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
// The album workspace: big editable cover (upload from Photos, reuse a track's
// artwork, or remove), editable details (title/type/release date/notes), play
// & shuffle through the shared audio engine, a reorderable tracklist whose
// rows open the full project editor, the public album share link, and delete.

struct CollectionDetailView: View {

    let allProjects: [Project]

    private let onUpdated: (Collection) -> Void
    private let onDeleted: (UUID) -> Void
    private let onItemsChanged: (UUID, [CollectionItem]) -> Void

    @EnvironmentObject var audioService: AudioService
    @Environment(\.dismiss) private var dismiss

    @State private var collection: Collection
    @State private var items: [CollectionItem] = []
    // Latest version per project in this collection — what play buttons play.
    @State private var latestVersions: [UUID: Version] = [:]
    @State private var isLoading = true

    // Sheets & pickers
    @State private var showAddTrack = false
    @State private var showEditDetails = false
    @State private var showCoverFromTracks = false
    @State private var showPhotosPicker = false
    @State private var showDeleteConfirm = false
    @State private var coverPickerItem: PhotosPickerItem?

    @State private var isSavingCover = false
    @State private var shareURL: URL?
    @State private var errorMessage: String?

    init(collection: Collection,
         allProjects: [Project],
         onUpdated: @escaping (Collection) -> Void = { _ in },
         onDeleted: @escaping (UUID) -> Void = { _ in },
         onItemsChanged: @escaping (UUID, [CollectionItem]) -> Void = { _, _ in }) {
        _collection = State(initialValue: collection)
        self.allProjects = allProjects
        self.onUpdated = onUpdated
        self.onDeleted = onDeleted
        self.onItemsChanged = onItemsChanged
    }

    // Map project IDs to projects for quick lookup
    private var projectMap: [UUID: Project] {
        Dictionary(uniqueKeysWithValues: allProjects.map { ($0.id, $0) })
    }

    // Collection projects in tracklist order.
    private var orderedProjects: [Project] {
        items.compactMap { projectMap[$0.projectId] }
    }

    // Cover to display: the set cover, else legacy artwork, else first track art.
    private var displayCoverUrl: String? {
        if let cover = collection.coverUrl, !cover.isEmpty { return cover }
        if let legacy = collection.artworkUrl, !legacy.isEmpty { return legacy }
        return orderedProjects.first(where: { $0.artworkUrl?.isEmpty == false })?.artworkUrl
    }

    var body: some View {
        ZStack {
            Color(hex: "#080808").ignoresSafeArea()

            if isLoading {
                ProgressView().tint(Color(hex: "#2dd4bf"))
            } else {
                List {
                    // MARK: Cover + details header
                    Section {
                        VStack(spacing: 14) {
                            coverBlock

                            VStack(spacing: 4) {
                                Text(collection.title)
                                    .font(.title2)
                                    .fontWeight(.bold)
                                    .foregroundColor(Color(hex: "#f0f0f0"))
                                    .multilineTextAlignment(.center)

                                HStack(spacing: 6) {
                                    Text(collection.type.uppercased())
                                        .fontWeight(.semibold)
                                        .foregroundColor(Color(hex: "#2dd4bf"))
                                    Text("· \(items.count) track\(items.count == 1 ? "" : "s")")
                                        .foregroundColor(.gray)
                                    if let date = collection.releaseDate {
                                        Text("· \(date.formatted(date: .abbreviated, time: .omitted))")
                                            .foregroundColor(.gray)
                                    }
                                }
                                .font(.caption)
                            }

                            if let notes = collection.notes, !notes.isEmpty {
                                Text(notes)
                                    .font(.caption)
                                    .foregroundColor(.gray)
                                    .multilineTextAlignment(.center)
                                    .lineLimit(3)
                            }

                            // Play / Shuffle the whole collection
                            if !queueItems().isEmpty {
                                HStack(spacing: 12) {
                                    Button(action: { playAll(shuffled: false) }) {
                                        Label("Play", systemImage: "play.fill")
                                            .font(.subheadline).fontWeight(.semibold)
                                            .foregroundColor(Color(hex: "#080808"))
                                            .frame(maxWidth: .infinity)
                                            .padding(.vertical, 10)
                                            .background(Color(hex: "#2dd4bf"))
                                            .cornerRadius(10)
                                    }
                                    Button(action: { playAll(shuffled: true) }) {
                                        Label("Shuffle", systemImage: "shuffle")
                                            .font(.subheadline).fontWeight(.semibold)
                                            .foregroundColor(Color(hex: "#2dd4bf"))
                                            .frame(maxWidth: .infinity)
                                            .padding(.vertical, 10)
                                            .background(Color(hex: "#2dd4bf").opacity(0.15))
                                            .cornerRadius(10)
                                    }
                                }
                                .buttonStyle(.borderless)
                            }

                            if let errorMessage {
                                Text(errorMessage)
                                    .font(.caption)
                                    .foregroundColor(.red)
                                    .multilineTextAlignment(.center)
                            }
                        }
                        .frame(maxWidth: .infinity)
                        .listRowBackground(Color(hex: "#080808"))
                        .listRowSeparator(.hidden)
                    }

                    // MARK: Tracklist (tap → project editor, play button, reorder/remove)
                    Section {
                        ForEach(items) { item in
                            if let project = projectMap[item.projectId] {
                                trackRow(item: item, project: project)
                                    .listRowBackground(Color(hex: "#111111"))
                            }
                        }
                        .onMove(perform: moveItems)
                        .onDelete(perform: deleteItems)
                    } header: {
                        Text("Tracklist")
                            .foregroundColor(Color(hex: "#f0f0f0"))
                    }

                    // MARK: Add Track
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
                // The floating MiniPlayerBar (ContentView) overlays ~60pt of
                // content above the tab bar — without this inset it buries the
                // last row (Add Track) whenever something is playing.
                .safeAreaInset(edge: .bottom) {
                    if audioService.currentVersion != nil {
                        Color.clear.frame(height: 76)
                    }
                }
            }
        }
        .navigationTitle(collection.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarColorScheme(.dark, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                EditButton()
                    .foregroundColor(Color(hex: "#2dd4bf"))
            }
            ToolbarItem(placement: .navigationBarTrailing) {
                Menu {
                    Button(action: { showEditDetails = true }) {
                        Label("Edit Details", systemImage: "pencil")
                    }
                    if let shareURL {
                        ShareLink(item: shareURL) {
                            Label("Share Album", systemImage: "square.and.arrow.up")
                        }
                    } else {
                        Button(action: { Task { await mintShareLink() } }) {
                            Label("Create Share Link", systemImage: "link")
                        }
                    }
                    Divider()
                    Button(role: .destructive, action: { showDeleteConfirm = true }) {
                        Label("Delete Collection", systemImage: "trash")
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .foregroundColor(Color(hex: "#2dd4bf"))
                }
            }
        }
        .photosPicker(isPresented: $showPhotosPicker, selection: $coverPickerItem, matching: .images)
        .onChange(of: coverPickerItem) { _, newItem in
            guard let newItem else { return }
            uploadCover(from: newItem)
        }
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
        .sheet(isPresented: $showEditDetails) {
            EditCollectionSheet(collection: collection) { updated in
                collection = updated
                onUpdated(updated)
            }
        }
        .sheet(isPresented: $showCoverFromTracks) {
            CoverFromTracksSheet(projects: orderedProjects) { artworkUrl in
                setCover(artworkUrl)
            }
        }
        .confirmationDialog(
            "Delete \"\(collection.title)\"? Tracks themselves are not deleted.",
            isPresented: $showDeleteConfirm,
            titleVisibility: .visible
        ) {
            Button("Delete Collection", role: .destructive) { deleteCollection() }
        }
        .task {
            await loadItems()
        }
    }

    // MARK: - Cover block
    private var coverBlock: some View {
        ZStack(alignment: .bottomTrailing) {
            Group {
                if let cover = displayCoverUrl, let url = URL(string: cover) {
                    AsyncImage(url: url) { image in
                        image.resizable().aspectRatio(contentMode: .fill)
                    } placeholder: {
                        RoundedRectangle(cornerRadius: 16).fill(Color(hex: "#1a1a1a"))
                    }
                } else {
                    RoundedRectangle(cornerRadius: 16)
                        .fill(Color(hex: "#1a1a1a"))
                        .overlay(
                            Image(systemName: collection.type == "album" ? "opticaldisc" : collection.type == "ep" ? "square.stack" : "music.note.list")
                                .font(.system(size: 44))
                                .foregroundColor(Color(hex: "#2dd4bf").opacity(0.5))
                        )
                }
            }
            .frame(width: 180, height: 180)
            .clipShape(RoundedRectangle(cornerRadius: 16))
            .shadow(color: .black.opacity(0.5), radius: 18, y: 10)
            .overlay {
                if isSavingCover {
                    RoundedRectangle(cornerRadius: 16)
                        .fill(.black.opacity(0.55))
                    ProgressView().tint(Color(hex: "#2dd4bf"))
                }
            }

            // Edit-cover menu, riding the corner of the artwork
            Menu {
                Button(action: { showPhotosPicker = true }) {
                    Label("Upload from Photos", systemImage: "photo.on.rectangle")
                }
                if orderedProjects.contains(where: { $0.artworkUrl?.isEmpty == false }) {
                    Button(action: { showCoverFromTracks = true }) {
                        Label("Use a Track's Artwork", systemImage: "music.note.list")
                    }
                }
                if collection.coverUrl?.isEmpty == false {
                    Button(role: .destructive, action: { setCover(nil) }) {
                        Label("Remove Cover", systemImage: "trash")
                    }
                }
            } label: {
                ZStack {
                    Circle()
                        .fill(Color(hex: "#2dd4bf"))
                        .frame(width: 34, height: 34)
                    Image(systemName: "camera.fill")
                        .font(.system(size: 14))
                        .foregroundColor(Color(hex: "#080808"))
                }
                .shadow(color: .black.opacity(0.4), radius: 4, y: 2)
            }
            .offset(x: 8, y: 8)
            .disabled(isSavingCover)
        }
    }

    // MARK: - Track row
    @ViewBuilder
    private func trackRow(item: CollectionItem, project: Project) -> some View {
        NavigationLink(destination: ProjectDetailView(projectId: project.id)) {
            HStack(spacing: 12) {
                Text("\((items.firstIndex(where: { $0.id == item.id }) ?? 0) + 1)")
                    .font(.caption)
                    .fontWeight(.bold)
                    .foregroundColor(Color(hex: "#2dd4bf"))
                    .frame(width: 24)

                if let artworkUrl = project.artworkUrl, let url = URL(string: artworkUrl) {
                    AsyncImage(url: url) { image in
                        image.resizable().aspectRatio(contentMode: .fill)
                    } placeholder: {
                        RoundedRectangle(cornerRadius: 6).fill(Color(hex: "#1a1a1a"))
                    }
                    .frame(width: 44, height: 44)
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                } else {
                    RoundedRectangle(cornerRadius: 6)
                        .fill(Color(hex: "#1a1a1a"))
                        .frame(width: 44, height: 44)
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
                        .lineLimit(1)
                    HStack(spacing: 4) {
                        if let version = latestVersions[project.id] {
                            Text(version.displayName)
                        }
                        if let genre = project.genre {
                            Text(genre)
                        }
                    }
                    .font(.caption2)
                    .foregroundColor(.gray)
                }

                Spacer()

                if latestVersions[project.id] != nil {
                    Button(action: { playTrack(projectId: project.id) }) {
                        Image(systemName: isPlayingProject(project.id) ? "waveform.circle.fill" : "play.circle.fill")
                            .font(.title3)
                            .foregroundColor(Color(hex: "#2dd4bf"))
                    }
                    .buttonStyle(.borderless)
                }
            }
        }
    }

    private func isPlayingProject(_ projectId: UUID) -> Bool {
        audioService.currentVersion?.projectId == projectId && audioService.isPlaying
    }

    // MARK: - Playback

    // The collection as a playback queue, in tracklist order.
    private func queueItems() -> [QueueItem] {
        items.compactMap { item in
            guard let project = projectMap[item.projectId],
                  let version = latestVersions[item.projectId] else { return nil }
            return QueueItem(
                projectId: project.id,
                version: version,
                trackName: project.title,
                artworkUrl: project.artworkUrl,
                visualizerUrl: project.visualizerUrl
            )
        }
    }

    private func playAll(shuffled: Bool) {
        let queue = queueItems()
        guard !queue.isEmpty else { return }
        audioService.isShuffled = shuffled
        audioService.setQueue(queue)
        audioService.play(item: shuffled ? queue.randomElement()! : queue[0])
    }

    private func playTrack(projectId: UUID) {
        let queue = queueItems()
        guard let target = queue.first(where: { $0.projectId == projectId }) else { return }
        audioService.setQueue(queue)
        audioService.play(item: target)
    }

    // MARK: - Cover actions

    private func setCover(_ url: String?) {
        errorMessage = nil
        Task {
            do {
                try await SupabaseService.shared.updateCollectionFields(
                    id: collection.id,
                    fields: ["cover_url": url ?? NSNull()]
                )
                collection.coverUrl = url
                onUpdated(collection)
            } catch {
                errorMessage = "Couldn't update cover: \(error.localizedDescription)"
            }
        }
    }

    private func uploadCover(from pickerItem: PhotosPickerItem) {
        errorMessage = nil
        isSavingCover = true
        Task {
            do {
                guard let raw = try await pickerItem.loadTransferable(type: Data.self),
                      let image = UIImage(data: raw) else {
                    throw SupabaseError.decodingFailed("Couldn't read that image")
                }
                // Downscale + JPEG so a 20 MB HEIC doesn't get shipped as a cover.
                let jpeg = image.collectionCoverJPEG(maxDimension: 1600)
                let url = try await SupabaseService.shared.uploadCollectionCover(data: jpeg, collectionId: collection.id)
                try await SupabaseService.shared.updateCollectionFields(id: collection.id, fields: ["cover_url": url])
                collection.coverUrl = url
                onUpdated(collection)
            } catch {
                errorMessage = "Couldn't upload cover: \(error.localizedDescription)"
            }
            isSavingCover = false
            coverPickerItem = nil
        }
    }

    // MARK: - Share / delete

    private func mintShareLink() async {
        do {
            shareURL = try await MixbaseAPI.shared.collectionShareLink(collectionId: collection.id)
        } catch {
            errorMessage = "Couldn't create share link: \(error.localizedDescription)"
        }
    }

    private func deleteCollection() {
        Task {
            do {
                try await SupabaseService.shared.deleteCollection(id: collection.id)
                onDeleted(collection.id)
                dismiss()
            } catch {
                errorMessage = "Couldn't delete: \(error.localizedDescription)"
            }
        }
    }

    // MARK: - Data

    private func loadItems() async {
        isLoading = true
        do {
            items = try await SupabaseService.shared.fetchCollectionItems(collectionId: collection.id)
            onItemsChanged(collection.id, items)
        } catch {
            print("CollectionDetail: Failed to load items — \(error.localizedDescription)")
        }
        isLoading = false

        // Latest version per collection project — powers play buttons. Loaded
        // after the list renders so the tracklist never waits on it.
        let ids = items.map(\.projectId)
        latestVersions = await withTaskGroup(of: (UUID, Version?).self) { group in
            for id in ids {
                group.addTask {
                    let versions = (try? await SupabaseService.shared.fetchVersions(projectId: id)) ?? []
                    return (id, versions.max(by: { $0.versionNumber < $1.versionNumber }))
                }
            }
            var result: [UUID: Version] = [:]
            for await (id, latest) in group {
                if let latest { result[id] = latest }
            }
            return result
        }

        // Warm the share link so the Share Album menu item is ready to tap.
        if shareURL == nil {
            shareURL = try? await MixbaseAPI.shared.collectionShareLink(collectionId: collection.id)
        }
    }

    private func moveItems(from source: IndexSet, to destination: Int) {
        items.move(fromOffsets: source, toOffset: destination)
        for index in items.indices { items[index].position = index }
        onItemsChanged(collection.id, items)
        // Push the new order
        let snapshot = items
        Task {
            for item in snapshot {
                try? await SupabaseService.shared.updateCollectionItemPosition(
                    itemId: item.id,
                    position: item.position
                )
            }
        }
    }

    private func deleteItems(at offsets: IndexSet) {
        let toDelete = offsets.map { items[$0] }
        items.remove(atOffsets: offsets)
        onItemsChanged(collection.id, items)
        Task {
            for item in toDelete {
                try? await SupabaseService.shared.removeFromCollection(itemId: item.id)
            }
        }
    }
}

// MARK: - Edit Collection Sheet
// Rename, retype, set/clear the release date, and edit notes.

struct EditCollectionSheet: View {

    @Environment(\.dismiss) private var dismiss

    let collection: Collection
    var onSaved: (Collection) -> Void

    @State private var title: String
    @State private var type: String
    @State private var hasReleaseDate: Bool
    @State private var releaseDate: Date
    @State private var notes: String
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    init(collection: Collection, onSaved: @escaping (Collection) -> Void) {
        self.collection = collection
        self.onSaved = onSaved
        _title = State(initialValue: collection.title)
        _type = State(initialValue: collection.type)
        _hasReleaseDate = State(initialValue: collection.releaseDate != nil)
        _releaseDate = State(initialValue: collection.releaseDate ?? Date())
        _notes = State(initialValue: collection.notes ?? "")
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Color(hex: "#080808").ignoresSafeArea()

                Form {
                    Section {
                        TextField("Collection name", text: $title)
                            .foregroundColor(Color(hex: "#f0f0f0"))
                    } header: {
                        Text("Title *").foregroundColor(Color(hex: "#2dd4bf"))
                    }

                    Section {
                        Picker("Type", selection: $type) {
                            Text("Playlist").tag("playlist")
                            Text("EP").tag("ep")
                            Text("Album").tag("album")
                        }
                        .pickerStyle(.segmented)
                    } header: {
                        Text("Type").foregroundColor(.gray)
                    }

                    Section {
                        Toggle("Has release date", isOn: $hasReleaseDate)
                            .tint(Color(hex: "#2dd4bf"))
                        if hasReleaseDate {
                            DatePicker("Release date", selection: $releaseDate, displayedComponents: .date)
                        }
                    } header: {
                        Text("Release").foregroundColor(.gray)
                    }

                    Section {
                        TextField("Notes", text: $notes, axis: .vertical)
                            .lineLimit(3...6)
                            .foregroundColor(Color(hex: "#f0f0f0"))
                    } header: {
                        Text("Notes").foregroundColor(.gray)
                    }

                    if let errorMessage {
                        Section {
                            Text(errorMessage).foregroundColor(.red).font(.caption)
                        }
                    }

                    Section {
                        Button(action: save) {
                            if isSubmitting {
                                ProgressView().tint(Color(hex: "#2dd4bf"))
                            } else {
                                Text("Save")
                                    .fontWeight(.semibold)
                                    .foregroundColor(Color(hex: "#080808"))
                                    .frame(maxWidth: .infinity)
                            }
                        }
                        .listRowBackground(
                            title.trimmingCharacters(in: .whitespaces).isEmpty
                                ? Color.gray.opacity(0.3) : Color(hex: "#2dd4bf")
                        )
                        .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty || isSubmitting)
                    }
                }
                .scrollContentBackground(.hidden)
            }
            .navigationTitle("Edit Collection")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.foregroundColor(.gray)
                }
            }
        }
    }

    private func save() {
        let trimmedTitle = title.trimmingCharacters(in: .whitespaces)
        let trimmedNotes = notes.trimmingCharacters(in: .whitespacesAndNewlines)
        isSubmitting = true
        errorMessage = nil

        var fields: [String: Any] = ["title": trimmedTitle, "type": type]
        fields["notes"] = trimmedNotes.isEmpty ? NSNull() : trimmedNotes
        if hasReleaseDate {
            let formatter = DateFormatter()
            formatter.dateFormat = "yyyy-MM-dd"
            formatter.locale = Locale(identifier: "en_US_POSIX")
            fields["release_date"] = formatter.string(from: releaseDate)
        } else {
            fields["release_date"] = NSNull()
        }

        Task {
            do {
                try await SupabaseService.shared.updateCollectionFields(id: collection.id, fields: fields)
                var updated = collection
                updated.title = trimmedTitle
                updated.type = type
                updated.releaseDate = hasReleaseDate ? releaseDate : nil
                updated.notes = trimmedNotes.isEmpty ? nil : trimmedNotes
                updated.updatedAt = Date()
                onSaved(updated)
                dismiss()
            } catch {
                errorMessage = error.localizedDescription
                isSubmitting = false
            }
        }
    }
}

// MARK: - Cover From Tracks Sheet
// Pick one of the collection's track artworks as the cover.

struct CoverFromTracksSheet: View {

    @Environment(\.dismiss) private var dismiss

    let projects: [Project]
    var onPick: (String) -> Void

    private var withArtwork: [Project] {
        projects.filter { $0.artworkUrl?.isEmpty == false }
    }

    private let columns = [
        GridItem(.flexible(), spacing: 12),
        GridItem(.flexible(), spacing: 12),
        GridItem(.flexible(), spacing: 12)
    ]

    var body: some View {
        NavigationStack {
            ZStack {
                Color(hex: "#080808").ignoresSafeArea()

                ScrollView {
                    LazyVGrid(columns: columns, spacing: 12) {
                        ForEach(withArtwork) { project in
                            if let artworkUrl = project.artworkUrl, let url = URL(string: artworkUrl) {
                                Button(action: {
                                    onPick(artworkUrl)
                                    dismiss()
                                }) {
                                    VStack(spacing: 6) {
                                        AsyncImage(url: url) { image in
                                            image.resizable().aspectRatio(contentMode: .fill)
                                        } placeholder: {
                                            RoundedRectangle(cornerRadius: 10).fill(Color(hex: "#1a1a1a"))
                                        }
                                        .frame(height: 104)
                                        .frame(maxWidth: .infinity)
                                        .clipShape(RoundedRectangle(cornerRadius: 10))

                                        Text(project.title)
                                            .font(.caption2)
                                            .foregroundColor(.gray)
                                            .lineLimit(1)
                                    }
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                    .padding()
                }
            }
            .navigationTitle("Choose Artwork")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.foregroundColor(.gray)
                }
            }
        }
    }
}

// MARK: - Cover image processing
#if canImport(UIKit)
private extension UIImage {
    /// Downscale to a sensible cover size and re-encode as JPEG, so a 20 MB
    /// camera HEIC never ships as a collection cover. Renders at scale 1 —
    /// UIGraphicsImageRenderer's default device scale would triple the pixels.
    func collectionCoverJPEG(maxDimension: CGFloat) -> Data {
        let largest = max(size.width, size.height)
        let ratio = min(1, maxDimension / max(largest, 1))
        let target = CGSize(width: (size.width * ratio).rounded(), height: (size.height * ratio).rounded())
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        let renderer = UIGraphicsImageRenderer(size: target, format: format)
        let resized = renderer.image { _ in draw(in: CGRect(origin: .zero, size: target)) }
        return resized.jpegData(compressionQuality: 0.85)
            ?? jpegData(compressionQuality: 0.85)
            ?? Data()
    }
}
#else
private extension NSImage {
    /// macOS twin of the UIImage version above: downscale via a bitmap rep at
    /// 1x (NSImage.size is in points; drawing into an explicit pixel-sized rep
    /// sidesteps Retina scale doubling), then re-encode as JPEG.
    func collectionCoverJPEG(maxDimension: CGFloat) -> Data {
        let largest = max(size.width, size.height)
        let ratio = min(1, maxDimension / max(largest, 1))
        let target = CGSize(width: (size.width * ratio).rounded(), height: (size.height * ratio).rounded())

        let fallback = { () -> Data in
            guard let tiff = self.tiffRepresentation,
                  let rep = NSBitmapImageRep(data: tiff),
                  let jpeg = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.85])
            else { return Data() }
            return jpeg
        }

        guard target.width >= 1, target.height >= 1,
              let rep = NSBitmapImageRep(
                bitmapDataPlanes: nil,
                pixelsWide: Int(target.width),
                pixelsHigh: Int(target.height),
                bitsPerSample: 8,
                samplesPerPixel: 4,
                hasAlpha: true,
                isPlanar: false,
                colorSpaceName: .calibratedRGB,
                bytesPerRow: 0,
                bitsPerPixel: 0
              )
        else { return fallback() }

        rep.size = target
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        draw(in: CGRect(origin: .zero, size: target),
             from: .zero,
             operation: .copy,
             fraction: 1)
        NSGraphicsContext.restoreGraphicsState()

        return rep.representation(using: .jpeg, properties: [.compressionFactor: 0.85]) ?? fallback()
    }
}
#endif

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
