import SwiftUI

// MARK: - HomeView
// A music-forward home: at-a-glance stats, a tappable Now Playing card, a
// "Your Tracks" quick-play carousel so you can start listening right away, and
// Recent Activity as a secondary feed below. The carousel and the Now Playing
// card both jump straight into the Player tab.

struct HomeView: View {

    @EnvironmentObject var audioService: AudioService

    // Lets the Now Playing card / "See all" jump to other tabs.
    @Binding var selectedTab: Int

    @Environment(\.scenePhase) private var scenePhase

    @State private var projects: [Project] = []
    @State private var releases: [Release] = []
    @State private var activities: [Activity] = []
    @State private var isLoading = true
    @State private var loadFailed = false

    // Latest versions per project — powers the quick-play carousel + activity rows
    @State private var latestVersions: [UUID: Version] = [:]

    // Map project IDs to projects for activity rows
    private var projectMap: [UUID: Project] {
        Dictionary(uniqueKeysWithValues: projects.map { ($0.id, $0) })
    }

    // Most recently updated projects that actually have audio to play
    private var recentTracks: [Project] {
        Array(projects.filter { latestVersions[$0.id] != nil }.prefix(8))
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Color(hex: "#080808")
                    .ignoresSafeArea()
                ambientBackdrop

                ScrollView {
                    VStack(alignment: .leading, spacing: 24) {
                        // MARK: - Brand header
                        HStack(alignment: .firstTextBaseline, spacing: 1) {
                            Text("mix")
                                .font(.system(size: 28, weight: .bold))
                                .foregroundColor(Color(hex: "#f0f0f0"))
                            Text("BASE")
                                .font(.system(size: 28, weight: .bold))
                                .foregroundColor(Color(hex: "#2dd4bf"))
                        }
                        .padding(.horizontal)

                        // MARK: - Load Error Banner
                        // Shown when the initial load failed (e.g. network not up yet
                        // on cold launch) so the user is never stuck on an empty home.
                        if loadFailed && projects.isEmpty && !isLoading {
                            loadErrorBanner
                        }

                        // MARK: - Stats Row (each card jumps to its tab)
                        HStack(spacing: 12) {
                            Button(action: { selectedTab = 1 }) {
                                StatCard(value: projects.count, label: "Projects", color: Color(hex: "#f0f0f0"))
                            }
                            Button(action: { selectedTab = 1 }) {
                                StatCard(value: mixingCount, label: "Mixing", color: .yellow)
                            }
                            Button(action: { selectedTab = 4 }) {
                                StatCard(value: releases.count, label: "Pipeline", color: Color(hex: "#2dd4bf"))
                            }
                        }
                        .buttonStyle(.plain)
                        .padding(.horizontal)

                        // (No Now Playing card here — the floating mini player
                        // above the tab bar already covers it on every tab.)

                        // MARK: - Your Tracks (quick-play carousel)
                        if !recentTracks.isEmpty {
                            yourTracksSection
                        }

                        // MARK: - Recent Activity
                        VStack(alignment: .leading, spacing: 12) {
                            Text("Recent Activity")
                                .font(.headline)
                                .foregroundColor(Color(hex: "#f0f0f0"))
                                .padding(.horizontal)

                            if isLoading && activities.isEmpty {
                                HStack {
                                    Spacer()
                                    ProgressView()
                                        .tint(Color(hex: "#2dd4bf"))
                                    Spacer()
                                }
                                .padding(.vertical, 24)
                            } else if activities.isEmpty {
                                Text("No recent activity")
                                    .font(.subheadline)
                                    .foregroundColor(.gray)
                                    .padding(.horizontal)
                                    .padding(.vertical, 20)
                            } else {
                                ForEach(activities) { activity in
                                    activityRow(activity: activity)
                                }
                            }
                        }

                        Spacer(minLength: 80)
                    }
                    .padding(.top, 16)
                }
                // Pull down to refresh projects, releases and activity.
                .refreshable {
                    await loadDashboardData()
                }
            }
            // No leading toolbar item: iOS 26 collapses non-interactive leading
            // items into a dead "…" glass button. The brand lives in the content
            // header instead; only the (working) settings gear stays up top.
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    NavigationLink(destination: SettingsView()) {
                        Image(systemName: "gear")
                            .foregroundColor(Color(hex: "#f0f0f0"))
                    }
                }
            }
            .toolbarColorScheme(.dark, for: .navigationBar)
            .task {
                await loadDashboardData()
            }
            // A failed cold-launch load (radio not up yet, token mid-refresh)
            // retries automatically when the app becomes active again instead of
            // waiting for a manual pull-to-refresh.
            .onChange(of: scenePhase) { _, phase in
                if phase == .active && (loadFailed || projects.isEmpty) && !isLoading {
                    Task { await loadDashboardData() }
                }
            }
        }
    }

    // MARK: - Load Error Banner
    private var loadErrorBanner: some View {
        VStack(spacing: 10) {
            Image(systemName: "wifi.exclamationmark")
                .font(.title2)
                .foregroundColor(.gray)
            Text("Couldn't load your dashboard")
                .font(.subheadline)
                .foregroundColor(Color(hex: "#f0f0f0"))
            Button(action: { Task { await loadDashboardData() } }) {
                Text("Retry")
                    .font(.subheadline)
                    .fontWeight(.semibold)
                    .foregroundColor(Color(hex: "#080808"))
                    .padding(.horizontal, 24)
                    .padding(.vertical, 8)
                    .background(Color(hex: "#2dd4bf"))
                    .clipShape(Capsule())
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 16)
        .background(Color(hex: "#111111"))
        .cornerRadius(12)
        .padding(.horizontal)
    }

    private var mixingCount: Int {
        projects.filter { $0.genre != nil }.count
    }

    // MARK: - Ambient Backdrop
    // Soft, blurred artwork of the current track glows behind the whole home feed
    // (matching the Now Playing screen) so Home feels alive when music is playing.
    @ViewBuilder
    private var ambientBackdrop: some View {
        if let artworkUrl = audioService.currentArtworkUrl,
           let url = URL(string: artworkUrl) {
            GeometryReader { geo in
                AsyncImage(url: url) { image in
                    image
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                        .frame(width: geo.size.width, height: geo.size.height * 0.6)
                        .clipped()
                        .blur(radius: 80)
                        .opacity(0.4)
                } placeholder: {
                    Color.clear
                }
            }
            .ignoresSafeArea()
            .overlay(
                LinearGradient(
                    colors: [Color(hex: "#080808").opacity(0.4), Color(hex: "#080808")],
                    startPoint: .top,
                    endPoint: .center
                )
                .ignoresSafeArea()
            )
            .animation(.easeInOut(duration: 0.6), value: audioService.currentArtworkUrl)
        }
    }

    // MARK: - Your Tracks Carousel
    private var yourTracksSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Your Tracks")
                    .font(.headline)
                    .foregroundColor(Color(hex: "#f0f0f0"))
                Spacer()
                Button(action: { selectedTab = 1 }) {  // Open the Projects tab
                    Text("See all")
                        .font(.caption)
                        .foregroundColor(Color(hex: "#2dd4bf"))
                }
            }
            .padding(.horizontal)

            ScrollView(.horizontal, showsIndicators: false) {
                // Top-aligned so cards with and without a genre line don't
                // vertically drift against each other.
                HStack(alignment: .top, spacing: 12) {
                    ForEach(recentTracks) { project in
                        trackCard(project: project)
                    }
                }
                .padding(.horizontal)
            }
        }
    }

    @ViewBuilder
    private func trackCard(project: Project) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            ZStack(alignment: .bottomTrailing) {
                Group {
                    if let artworkUrl = project.artworkUrl, let url = URL(string: artworkUrl) {
                        AsyncImage(url: url) { image in
                            image.resizable().aspectRatio(contentMode: .fill)
                        } placeholder: { trackArtworkPlaceholder }
                    } else {
                        trackArtworkPlaceholder
                    }
                }
                .frame(width: 140, height: 140)
                .clipShape(RoundedRectangle(cornerRadius: 10))

                if let version = latestVersions[project.id] {
                    Button(action: {
                        audioService.play(
                            version: version,
                            trackName: project.title,
                            artworkUrl: project.artworkUrl
                        )
                        selectedTab = 2  // Jump to the Player
                    }) {
                        let isThisPlaying = audioService.currentVersion?.projectId == project.id && audioService.isPlaying
                        Circle()
                            .fill(Color(hex: "#2dd4bf"))
                            .frame(width: 34, height: 34)
                            .overlay(
                                Image(systemName: isThisPlaying ? "waveform" : "play.fill")
                                    .font(.system(size: 13))
                                    .foregroundColor(Color(hex: "#080808"))
                            )
                            .shadow(color: .black.opacity(0.3), radius: 4, y: 2)
                    }
                    .padding(8)
                }
            }

            Text(project.title)
                .font(.subheadline)
                .fontWeight(.semibold)
                .foregroundColor(Color(hex: "#f0f0f0"))
                .lineLimit(1)
                .frame(width: 140, alignment: .leading)

            // Always one genre line (blank when unset) so every card is the
            // same height and the row lines up evenly.
            Text(project.genre ?? " ")
                .font(.caption2)
                .foregroundColor(.gray)
                .lineLimit(1)
                .frame(width: 140, alignment: .leading)
        }
    }

    private var trackArtworkPlaceholder: some View {
        RoundedRectangle(cornerRadius: 10)
            .fill(
                LinearGradient(
                    colors: [Color(hex: "#1a1a1a"), Color(hex: "#111111")],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
            )
            .overlay(
                Image(systemName: "music.note")
                    .font(.title)
                    .foregroundColor(.gray.opacity(0.3))
            )
    }

    // MARK: - Activity Row
    @ViewBuilder
    private func activityRow(activity: Activity) -> some View {
        HStack(spacing: 12) {
            Image(systemName: iconForActivityType(activity.type))
                .foregroundColor(Color(hex: "#2dd4bf"))
                .frame(width: 28, height: 28)
                .background(Color(hex: "#2dd4bf").opacity(0.15))
                .clipShape(Circle())

            VStack(alignment: .leading, spacing: 3) {
                Text(activity.description ?? "Activity")
                    .font(.subheadline)
                    .foregroundColor(Color(hex: "#f0f0f0"))
                    .lineLimit(2)

                HStack(spacing: 8) {
                    if let project = projectMap[activity.projectId] {
                        Text(project.title)
                            .font(.caption2)
                            .fontWeight(.medium)
                            .foregroundColor(Color(hex: "#2dd4bf"))
                    }

                    Text(activity.createdAt, style: .relative)
                        .font(.caption2)
                        .foregroundColor(.gray)

                    Text("·")
                        .font(.caption2)
                        .foregroundColor(.gray.opacity(0.5))

                    Text(activity.createdAt, format: .dateTime.month(.abbreviated).day().hour().minute())
                        .font(.caption2)
                        .foregroundColor(.gray.opacity(0.6))
                }
            }

            Spacer()

            if let version = latestVersions[activity.projectId],
               let project = projectMap[activity.projectId] {
                Button(action: {
                    audioService.play(
                        version: version,
                        trackName: project.title,
                        artworkUrl: project.artworkUrl
                    )
                }) {
                    Image(systemName: audioService.currentVersion?.projectId == activity.projectId && audioService.isPlaying
                        ? "waveform.circle.fill"
                        : "play.circle.fill")
                        .font(.title3)
                        .foregroundColor(Color(hex: "#2dd4bf"))
                }
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 4)
    }

    private func iconForActivityType(_ type: String) -> String {
        switch type {
        case "version_created": return "plus.circle"
        case "release_updated": return "arrow.triangle.2.circlepath"
        case "feedback_added": return "bubble.left"
        case "project_created": return "folder.badge.plus"
        default: return "bell"
        }
    }

    // MARK: - Data Loading
    private func loadDashboardData() async {
        isLoading = true

        // Make sure the access token is usable BEFORE the first fetch. On a cold
        // launch the restored token may be expired with the refresh still in
        // flight; awaiting here (refreshes are coalesced in AuthService) means
        // the requests below never race a stale token.
        await AuthService.shared.ensureFreshToken()

        do {
            async let fetchedProjects = SupabaseService.shared.fetchProjects()
            async let fetchedReleases = SupabaseService.shared.fetchReleases()
            async let fetchedActivities = SupabaseService.shared.fetchActivities()

            projects = try await fetchedProjects
            releases = try await fetchedReleases
            activities = try await fetchedActivities

            // Latest version per project (quick-play carousel + activity rows),
            // fetched concurrently — serially this was the slowest part of load.
            let projectIds = projects.map(\.id)
            latestVersions = await withTaskGroup(of: (UUID, Version?).self) { group in
                for id in projectIds {
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
            loadFailed = false
        } catch {
            // Keep whatever data we already have; only flag the failure so the
            // banner shows when the screen would otherwise be empty.
            loadFailed = true
            print("HomeView: Failed to load dashboard data — \(error.localizedDescription)")
        }
        isLoading = false
    }
}
