import SwiftUI

// MARK: - HomeView
// The dashboard / home screen of the app. Shows:
// 1. Stats row (Total Projects, Mixing, In Pipeline)
// 2. Now Playing card (if something is playing)
// 3. Recent Activity list

struct HomeView: View {

    // Access the shared audio service for the Now Playing card
    @EnvironmentObject var audioService: AudioService

    // Dashboard data loaded from Supabase
    @State private var projects: [Project] = []
    @State private var releases: [Release] = []
    @State private var activities: [Activity] = []
    @State private var isLoading = true

    // Navigate to settings when gear icon is tapped
    @State private var showSettings = false

    var body: some View {
        NavigationStack {
            ZStack {
                // Dark background
                Color(hex: "#080808")
                    .ignoresSafeArea()

                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        // MARK: - Stats Row
                        // Three cards showing key numbers at a glance
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
                        // Only shows when audioService has a current version loaded
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
                                // Empty state
                                Text("No recent activity")
                                    .font(.subheadline)
                                    .foregroundColor(.gray)
                                    .padding(.horizontal)
                                    .padding(.vertical, 20)
                            } else {
                                // List of activity items
                                ForEach(activities) { activity in
                                    activityRow(activity: activity)
                                }
                            }
                        }

                        Spacer(minLength: 80) // Extra space for mini player
                    }
                    .padding(.top, 16)
                }
            }
            // Navigation bar with title and settings gear icon
            .navigationTitle("mixBase")
            .navigationBarTitleDisplayMode(.large)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    NavigationLink(destination: SettingsView()) {
                        Image(systemName: "gear")
                            .foregroundColor(Color(hex: "#f0f0f0"))
                    }
                }
            }
            // Fetch data from Supabase when the view first appears
            .task {
                await loadDashboardData()
            }
        }
    }

    // MARK: - Computed Properties

    // Count how many projects have at least one version with "WIP" or "Mixing" status
    private var mixingCount: Int {
        // For now, count projects as a simple placeholder.
        // A real implementation would check version statuses.
        projects.filter { $0.genre != nil }.count
    }

    // MARK: - Now Playing Card
    // Shows the currently playing track with artwork, name, progress, and controls
    @ViewBuilder
    private func nowPlayingCard(version: Version) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                // Artwork thumbnail
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

                // Track name and version
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

                // Play/Pause button
                Button(action: { audioService.togglePlayPause() }) {
                    Image(systemName: audioService.isPlaying ? "pause.circle.fill" : "play.circle.fill")
                        .font(.system(size: 36))
                        .foregroundColor(Color(hex: "#2dd4bf"))
                }
            }

            // Progress bar showing playback position
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    // Background track
                    RoundedRectangle(cornerRadius: 2)
                        .fill(Color(hex: "#333333"))
                        .frame(height: 4)

                    // Filled portion based on current progress
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

    // Calculate playback progress as a fraction (0.0 to 1.0)
    private var progress: CGFloat {
        guard audioService.duration > 0 else { return 0 }
        return CGFloat(audioService.currentTime / audioService.duration)
    }

    // MARK: - Activity Row
    // A single row in the Recent Activity list
    @ViewBuilder
    private func activityRow(activity: Activity) -> some View {
        HStack(spacing: 12) {
            // Icon based on the activity type
            Image(systemName: iconForActivityType(activity.type))
                .foregroundColor(Color(hex: "#2dd4bf"))
                .frame(width: 28, height: 28)
                .background(Color(hex: "#2dd4bf").opacity(0.15))
                .clipShape(Circle())

            // Description text
            VStack(alignment: .leading, spacing: 2) {
                Text(activity.description ?? "Activity")
                    .font(.subheadline)
                    .foregroundColor(Color(hex: "#f0f0f0"))
                    .lineLimit(2)

                // Time ago (simplified — just shows the date)
                Text(activity.createdAt, style: .relative)
                    .font(.caption2)
                    .foregroundColor(.gray)
            }

            Spacer()
        }
        .padding(.horizontal)
        .padding(.vertical, 4)
    }

    // Map activity type strings to SF Symbol icon names
    private func iconForActivityType(_ type: String) -> String {
        switch type {
        case "version_created":
            return "plus.circle"
        case "release_updated":
            return "arrow.triangle.2.circlepath"
        case "feedback_added":
            return "bubble.left"
        case "project_created":
            return "folder.badge.plus"
        default:
            return "bell"
        }
    }

    // MARK: - Data Loading
    // Fetch projects, releases, and activities from Supabase
    private func loadDashboardData() async {
        isLoading = true
        do {
            // Load all three data sets concurrently
            async let fetchedProjects = SupabaseService.shared.fetchProjects()
            async let fetchedReleases = SupabaseService.shared.fetchReleases()
            async let fetchedActivities = SupabaseService.shared.fetchActivities()

            projects = try await fetchedProjects
            releases = try await fetchedReleases
            activities = try await fetchedActivities
        } catch {
            // If fetching fails, just show empty data
            print("HomeView: Failed to load dashboard data — \(error.localizedDescription)")
        }
        isLoading = false
    }
}
