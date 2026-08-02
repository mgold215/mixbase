import SwiftUI

// MARK: - ArtworkLibraryView
// The Artwork tab — iOS version of the web Media Library (/media): every piece
// of artwork across the catalog (uploaded or AI-generated, i.e. each track's
// artwork and each collection's cover) plus the saved visualizer videos.
// Sortable (newest / oldest / A–Z) and filterable, including "Assigned to
// Track". Tap any image to reassign it to another track, set it as a
// collection cover, or spin it into a visualizer.

struct ArtworkLibraryView: View {

    // MARK: Filters & sorting

    enum LibraryFilter: String, CaseIterable {
        case all = "All"
        case tracks = "Assigned to Track"
        case covers = "Collection Covers"
        case videos = "Videos"
    }

    enum LibrarySort: String, CaseIterable {
        case newest = "Newest"
        case oldest = "Oldest"
        case title = "A–Z"
    }

    // MARK: One unified item for the grid

    struct ArtworkItem: Identifiable {
        let id: String
        let imageUrl: String
        let title: String
        let isCover: Bool          // true = collection cover, false = track artwork
        let projectId: UUID?       // set for track artwork
        let date: Date
    }

    // MARK: State

    @State private var projects: [Project] = []
    @State private var collections: [Collection] = []
    @State private var visualizers: [Visualizer] = []
    @State private var isLoading = true
    @State private var loadFailed = false

    @State private var filter: LibraryFilter = .all
    @State private var sort: LibrarySort = .newest

    @State private var selectedItem: ArtworkItem?
    @State private var previewVideo: Visualizer?

    private let columns = [
        GridItem(.flexible(), spacing: 8),
        GridItem(.flexible(), spacing: 8),
        GridItem(.flexible(), spacing: 8),
    ]

    // MARK: Derived data

    private var allItems: [ArtworkItem] {
        let trackArt: [ArtworkItem] = projects.compactMap { project in
            guard let url = project.artworkUrl else { return nil }
            return ArtworkItem(
                id: "p-\(project.id.uuidString)",
                imageUrl: url,
                title: project.title,
                isCover: false,
                projectId: project.id,
                date: project.updatedAt
            )
        }
        let covers: [ArtworkItem] = collections.compactMap { collection in
            guard let url = collection.coverUrl ?? collection.artworkUrl else { return nil }
            return ArtworkItem(
                id: "c-\(collection.id.uuidString)",
                imageUrl: url,
                title: collection.title,
                isCover: true,
                projectId: nil,
                date: collection.updatedAt
            )
        }
        return trackArt + covers
    }

    private var shownItems: [ArtworkItem] {
        let filtered: [ArtworkItem]
        switch filter {
        case .all, .videos: filtered = allItems
        case .tracks: filtered = allItems.filter { !$0.isCover }
        case .covers: filtered = allItems.filter { $0.isCover }
        }
        switch sort {
        case .newest: return filtered.sorted { $0.date > $1.date }
        case .oldest: return filtered.sorted { $0.date < $1.date }
        case .title: return filtered.sorted { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }
        }
    }

    private var showsArtworkGrid: Bool { filter != .videos }
    private var showsVideos: Bool { filter == .all || filter == .videos }

    var body: some View {
        NavigationStack {
            ZStack {
                Color(hex: "#080808").ignoresSafeArea()

                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        // MARK: Filter chips
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 8) {
                                ForEach(LibraryFilter.allCases, id: \.self) { f in
                                    Button(action: { filter = f }) {
                                        Text(f.rawValue)
                                            .font(.caption)
                                            .fontWeight(.medium)
                                            .padding(.horizontal, 14)
                                            .padding(.vertical, 8)
                                            .foregroundColor(filter == f ? Color(hex: "#080808") : Color(hex: "#f0f0f0"))
                                            .background(filter == f ? Color(hex: "#2dd4bf") : Color(hex: "#222222"))
                                            .clipShape(Capsule())
                                    }
                                }
                            }
                            .padding(.horizontal)
                        }

                        if isLoading && allItems.isEmpty && visualizers.isEmpty {
                            HStack { Spacer(); ProgressView().tint(Color(hex: "#2dd4bf")); Spacer() }
                                .padding(.vertical, 60)
                        } else if loadFailed && allItems.isEmpty && visualizers.isEmpty {
                            VStack(spacing: 10) {
                                Text("Couldn't load your media library")
                                    .font(.subheadline)
                                    .foregroundColor(Color(hex: "#f0f0f0"))
                                Button("Retry") { Task { await loadLibrary() } }
                                    .font(.subheadline).fontWeight(.semibold)
                                    .foregroundColor(Color(hex: "#2dd4bf"))
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 60)
                        } else {
                            // MARK: Artwork grid
                            if showsArtworkGrid {
                                if shownItems.isEmpty && !isLoading {
                                    Text("No artwork yet — generate or upload some from a project.")
                                        .font(.subheadline)
                                        .foregroundColor(.gray)
                                        .padding(.horizontal)
                                        .padding(.vertical, 24)
                                } else {
                                    LazyVGrid(columns: columns, spacing: 8) {
                                        ForEach(shownItems) { item in
                                            artworkCell(item)
                                        }
                                    }
                                    .padding(.horizontal)
                                }
                            }

                            // MARK: Videos
                            if showsVideos && !visualizers.isEmpty {
                                Text("Videos")
                                    .font(.headline)
                                    .foregroundColor(Color(hex: "#f0f0f0"))
                                    .padding(.horizontal)
                                    .padding(.top, filter == .all ? 8 : 0)

                                ForEach(visualizers) { visualizer in
                                    videoRow(visualizer)
                                }
                            }
                        }

                        Spacer(minLength: 100)
                    }
                    .padding(.top, 8)
                }
                .refreshable { await loadLibrary() }
            }
            .navigationTitle("Artwork")
            .navigationBarTitleDisplayMode(.large)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Menu {
                        Picker("Sort", selection: $sort) {
                            ForEach(LibrarySort.allCases, id: \.self) { s in
                                Text(s.rawValue).tag(s)
                            }
                        }
                    } label: {
                        Image(systemName: "arrow.up.arrow.down")
                            .foregroundColor(Color(hex: "#2dd4bf"))
                    }
                }
            }
            .task { await loadLibrary() }
            .sheet(item: $selectedItem) { item in
                ArtworkDetailSheet(
                    item: item,
                    projects: projects,
                    collections: collections,
                    onChanged: { Task { await loadLibrary() } }
                )
            }
            .sheet(item: $previewVideo) { visualizer in
                VideoPreviewSheet(visualizer: visualizer)
            }
        }
    }

    // MARK: - Artwork Cell
    @ViewBuilder
    private func artworkCell(_ item: ArtworkItem) -> some View {
        Button(action: { selectedItem = item }) {
            ZStack(alignment: .bottomLeading) {
                if let url = URL(string: item.imageUrl) {
                    AsyncImage(url: url) { image in
                        image.resizable().aspectRatio(contentMode: .fill)
                    } placeholder: {
                        Rectangle().fill(Color(hex: "#1a1a1a"))
                    }
                }

                LinearGradient(colors: [.clear, .black.opacity(0.65)], startPoint: .center, endPoint: .bottom)

                VStack(alignment: .leading, spacing: 1) {
                    Text(item.title)
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(.white)
                        .lineLimit(1)
                    Text(item.isCover ? "Cover" : "Track")
                        .font(.system(size: 8))
                        .foregroundColor(.white.opacity(0.65))
                }
                .padding(6)
            }
            .aspectRatio(1, contentMode: .fit)
            .clipShape(RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
    }

    // MARK: - Video Row
    @ViewBuilder
    private func videoRow(_ visualizer: Visualizer) -> some View {
        HStack(spacing: 12) {
            Button(action: { previewVideo = visualizer }) {
                ZStack {
                    if let source = visualizer.sourceImageUrl, let url = URL(string: source) {
                        AsyncImage(url: url) { image in
                            image.resizable().aspectRatio(contentMode: .fill)
                        } placeholder: {
                            RoundedRectangle(cornerRadius: 8).fill(Color(hex: "#1a1a1a"))
                        }
                        .frame(width: 52, height: 52)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                    } else {
                        RoundedRectangle(cornerRadius: 8)
                            .fill(Color(hex: "#1a1a1a"))
                            .frame(width: 52, height: 52)
                    }
                    Image(systemName: "play.circle.fill")
                        .font(.title3)
                        .foregroundColor(.white.opacity(0.9))
                        .shadow(radius: 3)
                }
            }
            .buttonStyle(.plain)

            VStack(alignment: .leading, spacing: 3) {
                Text(visualizer.title ?? "Visualizer")
                    .font(.subheadline)
                    .fontWeight(.medium)
                    .foregroundColor(Color(hex: "#f0f0f0"))
                    .lineLimit(1)
                HStack(spacing: 6) {
                    Text(kindLabel(visualizer.kind))
                        .font(.caption2)
                        .foregroundColor(Color(hex: "#2dd4bf"))
                    Text(visualizer.createdAt, style: .date)
                        .font(.caption2)
                        .foregroundColor(.gray)
                }
            }

            Spacer()

            Button(action: { Task { await deleteVideo(visualizer) } }) {
                Image(systemName: "trash")
                    .font(.caption)
                    .foregroundColor(.gray)
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 5)
    }

    private func kindLabel(_ kind: String?) -> String {
        switch kind {
        case "ai": return "AI Loop"
        case "youtube": return "YouTube Render"
        case "shorts": return "Shorts Render"
        case "canvas": return "Canvas"
        default: return "Video"
        }
    }

    // MARK: - Data

    private func loadLibrary() async {
        isLoading = true
        do {
            async let fetchedProjects = SupabaseService.shared.fetchProjects()
            async let fetchedCollections = SupabaseService.shared.fetchCollections()
            projects = try await fetchedProjects
            collections = try await fetchedCollections
            loadFailed = false
        } catch {
            loadFailed = true
            print("ArtworkLibrary: load failed — \(error.localizedDescription)")
        }
        // Videos come from the web API — a failure here shouldn't blank the grid
        do {
            visualizers = try await MixbaseAPI.shared.fetchVisualizers()
        } catch {
            print("ArtworkLibrary: visualizers load failed — \(error.localizedDescription)")
        }
        isLoading = false
    }

    private func deleteVideo(_ visualizer: Visualizer) async {
        do {
            try await MixbaseAPI.shared.deleteVisualizer(id: visualizer.id)
            visualizers.removeAll { $0.id == visualizer.id }
        } catch {
            print("ArtworkLibrary: delete failed — \(error.localizedDescription)")
        }
    }
}

// MARK: - ArtworkDetailSheet
// Web Media Library's assignment panel: preview the selected artwork, assign it
// to a track, set it as a collection cover, or make a visualizer from it.

struct ArtworkDetailSheet: View {

    let item: ArtworkLibraryView.ArtworkItem
    let projects: [Project]
    let collections: [Collection]
    var onChanged: () -> Void

    @Environment(\.dismiss) private var dismiss

    @State private var isWorking = false
    @State private var confirmation: String?
    @State private var errorMessage: String?
    @State private var showVisualizer = false

    var body: some View {
        NavigationStack {
            ZStack {
                Color(hex: "#080808").ignoresSafeArea()

                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        // Preview
                        if let url = URL(string: item.imageUrl) {
                            AsyncImage(url: url) { image in
                                image.resizable().aspectRatio(contentMode: .fit)
                            } placeholder: {
                                RoundedRectangle(cornerRadius: 14)
                                    .fill(Color(hex: "#1a1a1a"))
                                    .aspectRatio(1, contentMode: .fit)
                            }
                            .clipShape(RoundedRectangle(cornerRadius: 14))
                            .padding(.horizontal)
                        }

                        Text(item.title)
                            .font(.headline)
                            .foregroundColor(Color(hex: "#f0f0f0"))
                            .padding(.horizontal)

                        if let confirmation {
                            Label(confirmation, systemImage: "checkmark.circle.fill")
                                .font(.subheadline)
                                .foregroundColor(Color(hex: "#2dd4bf"))
                                .padding(.horizontal)
                        }
                        if let errorMessage {
                            Text(errorMessage)
                                .font(.caption)
                                .foregroundColor(.red)
                                .padding(.horizontal)
                        }

                        // Make a visualizer from this image (track artwork only —
                        // generation needs a project to bill/attach to)
                        if item.projectId != nil {
                            Button(action: { showVisualizer = true }) {
                                Label("Make Visualizer", systemImage: "sparkles.tv")
                                    .font(.subheadline).fontWeight(.semibold)
                                    .foregroundColor(Color(hex: "#080808"))
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 12)
                                    .background(Color(hex: "#2dd4bf"))
                                    .cornerRadius(10)
                            }
                            .padding(.horizontal)
                        }

                        // Assign to a track
                        let otherProjects = projects.filter { $0.id != item.projectId }
                        if !otherProjects.isEmpty {
                            assignSection(title: "Set as track artwork") {
                                ForEach(otherProjects) { project in
                                    assignRow(label: project.title) {
                                        await assign({
                                            try await MixbaseAPI.shared.assignArtworkToProject(
                                                projectId: project.id, artworkUrl: item.imageUrl)
                                        }, confirmationText: "Set as artwork for \(project.title)")
                                    }
                                }
                            }
                        }

                        // Set as collection cover
                        if !collections.isEmpty {
                            assignSection(title: "Set as collection cover") {
                                ForEach(collections) { collection in
                                    assignRow(label: collection.title) {
                                        await assign({
                                            try await MixbaseAPI.shared.setCollectionCover(
                                                collectionId: collection.id, coverUrl: item.imageUrl)
                                        }, confirmationText: "Set as cover for \(collection.title)")
                                    }
                                }
                            }
                        }

                        Spacer(minLength: 40)
                    }
                    .padding(.top, 12)
                }
            }
            .navigationTitle(item.isCover ? "Collection Cover" : "Track Artwork")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                        .foregroundColor(Color(hex: "#2dd4bf"))
                }
            }
            .sheet(isPresented: $showVisualizer) {
                if let projectId = item.projectId {
                    NavigationStack {
                        VisualizerView(
                            projectId: projectId,
                            projectTitle: item.title,
                            artworkUrl: item.imageUrl,
                            pinnedUrl: nil
                        )
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func assignSection<Content: View>(title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title.uppercased())
                .font(.caption2)
                .fontWeight(.semibold)
                .foregroundColor(.gray)
                .padding(.horizontal)
            VStack(spacing: 0) {
                content()
            }
            .background(Color(hex: "#111111"))
            .cornerRadius(10)
            .padding(.horizontal)
        }
    }

    @ViewBuilder
    private func assignRow(label: String, action: @escaping () async -> Void) -> some View {
        Button(action: { Task { await action() } }) {
            HStack {
                Text(label)
                    .font(.subheadline)
                    .foregroundColor(Color(hex: "#f0f0f0"))
                    .lineLimit(1)
                Spacer()
                Image(systemName: "arrow.right.circle")
                    .font(.caption)
                    .foregroundColor(Color(hex: "#2dd4bf"))
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 11)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isWorking)
        .overlay(Divider().background(Color(hex: "#222222")), alignment: .bottom)
    }

    private func assign(_ work: @escaping () async throws -> Void, confirmationText: String) async {
        isWorking = true
        errorMessage = nil
        do {
            try await work()
            confirmation = confirmationText
            onChanged()
        } catch {
            errorMessage = error.localizedDescription
        }
        isWorking = false
    }
}

// MARK: - VideoPreviewSheet
// Full-width looping preview of a saved visualizer video.

struct VideoPreviewSheet: View {

    let visualizer: Visualizer

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ZStack {
                Color(hex: "#080808").ignoresSafeArea()
                if let url = URL(string: visualizer.videoUrl) {
                    LoopingVideoPlayer(url: url)
                        .ignoresSafeArea(edges: .bottom)
                }
            }
            .navigationTitle(visualizer.title ?? "Visualizer")
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
}
