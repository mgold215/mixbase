import SwiftUI

// MARK: - HomeView
// Dashboard: stats, now playing card, recent activity with timestamps and listen links.

struct HomeView: View {

    @EnvironmentObject var audioService: AudioService

    @State private var projects: [Project] = []
    @State private var releases: [Release] = []
    @State private var activities: [Activity] = []
    @State private var isLoading = true
    @State private var showSettings = false

    // Map project IDs to projects for activity rows
    private var projectMap: [UUID: Project] {
        Dictionary(uniqueKeysWithValues: projects.map { ($0.id, $0) })
    }

    // Latest versions per project for play buttons in activity
    @State private var latestVersions: [UUID: Version] = [:]

    var body: some View {
        NavigationStack {
            ZStack {
                Color(hex: "#080808")
                    .ignoresSafeArea()

                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        // MARK: - Stats Row
                        HStack(spacing: 12) {
                            StatCard(
                                value: projects.count,
                                label: "Projects",
                                color: Color(hex: "#f0f0f0")
                            )
                            StatCard(
                                value: mixingCount,
                                label: "Mixing",
                                color: .yellow
                            )
                            StatCard(
                                value: releases.count,
                                label: "Pipeline",
                                color: Color(hex: "#2dd4bf")
                            )
                        }
                        .padding(.horizontal)

                        // MARK: - Now Playing Card
                        if let version = audioService.currentVersion {
                            nowPlayingCard(version: version)
                                .padding(.horizontal)
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
                // Custom title with teal color
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
                            .overlay(
                                Image(systemName: "music.note")
                                    .foregroundColor(.gray)
                            )
                    }
                    .frame(width: 56, height: 56)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                }

                VStack(alignment: .leading, spacing: 4) {
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
    }

    private var progress: CGFloat {
        guard audioService.duration > 0 else { return 0 }
        return CGFloat(audioService.currentTime / audioService.duration)
    }

    // MARK: - Activity Row
    // Shows icon, description, track name, timestamp, and listen button
    @ViewBuilder
    private func activityRow(activity: Activity) -> some View {
        HStack(spacing: 12) {
            // Activity type icon
            Image(systemName: iconForActivityType(activity.type))
                .foregroundColor(Color(hex: "#2dd4bf"))
                .frame(width: 28, height: 28)
                .background(Color(hex: "#2dd4bf").opacity(0.15))
                .clipShape(Circle())

            VStack(alignment: .leading, spacing: 3) {
                // Description
                Text(activity.description ?? "Activity")
                    .font(.subheadline)
                    .foregroundColor(Color(hex: "#f0f0f0"))
                    .lineLimit(2)

                HStack(spacing: 8) {
                    // Track name (linked to project)
                    if let project = projectMap[activity.projectId] {
                        Text(project.title)
                            .font(.caption2)
                            .fontWeight(.medium)
                            .foregroundColor(Color(hex: "#2dd4bf"))
                    }

                    // Timestamp
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

            // Play button — plays the latest version of the related project
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

            // Fetch latest versions for play buttons in activity rows
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
