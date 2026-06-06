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

    @State private var projects: [Project] = []
    @State private var releases: [Release] = []
    @State private var activities: [Activity] = []
    @State private var isLoading = true

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

                ScrollView {
                    VStack(alignment: .leading, spacing: 24) {
                        // MARK: - Stats Row
                        HStack(spacing: 12) {
                            StatCard(value: projects.count, label: "Projects", color: Color(hex: "#f0f0f0"))
                            StatCard(value: mixingCount, label: "Mixing", color: .yellow)
                            StatCard(value: releases.count, label: "Pipeline", color: Color(hex: "#2dd4bf"))
                        }
                        .padding(.horizontal)

                        // MARK: - Now Playing Card (taps through to the Player tab)
                        if let version = audioService.currentVersion {
                            nowPlayingCard(version: version)
                                .padding(.horizontal)
                        }

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

                            if activities.isEmpty && !isLoading {
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
            }
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Text("mixBase")
                        .font(.system(size: 28, weight: .bold))
                        .foregroundColor(Color(hex: "#2dd4bf"))
                }
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
        }
    }

    private var mixingCount: Int {
        projects.filter { $0.genre != nil }.count
    }

    // MARK: - Now Playing Card
    @ViewBuilder
    private func nowPlayingCard(version: Version) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                if let artworkUrl = audioService.currentArtworkUrl,
                   let url = URL(string: artworkUrl) {
                    AsyncImage(url: url) { image in
                        image.resizable().aspectRatio(contentMode: .fill)
                    } placeholder: {
                        RoundedRectangle(cornerRadius: 8)
                            .fill(Color(hex: "#222222"))
                            .overlay(Image(systemName: "music.note").foregroundColor(.gray))
                    }
                    .frame(width: 56, height: 56)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                }

                VStack(alignment: .leading, spacing: 4) {
                    Text("NOW PLAYING")
                        .font(.caption2)
                        .fontWeight(.semibold)
                        .foregroundColor(.gray)
                    Text(audioService.currentTrackName ?? "Unknown Track")
                        .font(.subheadline)
                        .fontWeight(.semibold)
                        .foregroundColor(Color(hex: "#f0f0f0"))
                        .lineLimit(1)
                    Text("v\(version.versionNumber) \(version.label ?? "")")
                        .font(.caption)
                        .foregroundColor(Color(hex: "#2dd4bf"))
                }

                Spacer()

                // Play/pause stays an explicit control; tapping the card opens the player.
                Button(action: { audioService.togglePlayPause() }) {
                    Image(systemName: audioService.isPlaying ? "pause.circle.fill" : "play.circle.fill")
                        .font(.system(size: 36))
                        .foregroundColor(Color(hex: "#2dd4bf"))
                }
            }

            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 2)
                        .fill(Color(hex: "#333333"))
                        .frame(height: 4)
                    RoundedRectangle(cornerRadius: 2)
                        .fill(Color(hex: "#2dd4bf"))
                        .frame(width: geo.size.width * progress, height: 4)
                }
            }
            .frame(height: 4)
        }
        .padding(16)
        .background(Color(hex: "#111111"))
        .cornerRadius(12)
        .contentShape(Rectangle())
        .onTapGesture { selectedTab = 2 }  // Open the Player tab
    }

    private var progress: CGFloat {
        guard audioService.duration > 0 else { return 0 }
        return CGFloat(audioService.currentTime / audioService.duration)
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
                HStack(spacing: 12) {
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

            if let genre = project.genre {
                Text(genre)
                    .font(.caption2)
                    .foregroundColor(.gray)
                    .lineLimit(1)
                    .frame(width: 140, alignment: .leading)
            }
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
        do {
            async let fetchedProjects = SupabaseService.shared.fetchProjects()
            async let fetchedReleases = SupabaseService.shared.fetchReleases()
            async let fetchedActivities = SupabaseService.shared.fetchActivities()

            projects = try await fetchedProjects
            releases = try await fetchedReleases
            activities = try await fetchedActivities

            // Fetch latest versions for quick-play carousel + activity rows
            var versions: [UUID: Version] = [:]
            for project in projects {
                let projectVersions = try await SupabaseService.shared.fetchVersions(projectId: project.id)
                if let latest = projectVersions.max(by: { $0.versionNumber < $1.versionNumber }) {
                    versions[project.id] = latest
                }
            }
            latestVersions = versions
        } catch {
            print("HomeView: Failed to load dashboard data — \(error.localizedDescription)")
        }
        isLoading = false
    }
}
