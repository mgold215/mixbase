import SwiftUI

// MARK: - PipelineView
// Shows a list of releases in the release pipeline.
// Each card displays: title, release date, linked project artwork, progress indicator.
// "New Release" button in toolbar. Tapping a release navigates to ReleaseDetailView.

struct PipelineView: View {

    // All releases fetched from Supabase
    @State private var releases: [Release] = []
    @State private var isLoading = true

    // Show the new release sheet (placeholder for now)
    @State private var showNewRelease = false

    var body: some View {
        NavigationStack {
            ZStack {
                // Dark background
                Color(hex: "#080808")
                    .ignoresSafeArea()

                ScrollView {
                    if isLoading {
                        ProgressView()
                            .tint(Color(hex: "#2dd4bf"))
                            .padding(.top, 60)
                    } else if releases.isEmpty {
                        // Empty state
                        VStack(spacing: 12) {
                            Image(systemName: "checklist")
                                .font(.system(size: 48))
                                .foregroundColor(.gray)
                            Text("No releases in pipeline")
                                .font(.headline)
                                .foregroundColor(.gray)
                            Text("Tap + to add a release")
                                .font(.subheadline)
                                .foregroundColor(.gray.opacity(0.6))
                        }
                        .padding(.top, 80)
                    } else {
                        // List of release cards
                        LazyVStack(spacing: 12) {
                            ForEach(releases) { release in
                                NavigationLink(destination: ReleaseDetailView(release: release)) {
                                    releaseCard(release: release)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(.horizontal)
                        .padding(.top, 12)
                        .padding(.bottom, 80) // Space for mini player
                    }
                }
            }
            .navigationTitle("Pipeline")
            .navigationBarTitleDisplayMode(.large)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbar {
                // "New Release" plus button
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button(action: { showNewRelease = true }) {
                        Image(systemName: "plus")
                            .foregroundColor(Color(hex: "#2dd4bf"))
                    }
                }
            }
            // Fetch releases when view appears
            .task {
                await loadReleases()
            }
        }
    }

    // MARK: - Release Card
    // A single card showing release info and progress
    @ViewBuilder
    private func releaseCard(release: Release) -> some View {
        HStack(spacing: 14) {
            // Project artwork thumbnail (if the release is linked to a project)
            // For now, show a placeholder since we don't have the project loaded here
            RoundedRectangle(cornerRadius: 8)
                .fill(Color(hex: "#1a1a1a"))
                .frame(width: 52, height: 52)
                .overlay(
                    Image(systemName: "music.note")
                        .foregroundColor(.gray.opacity(0.4))
                )

            // Title and release date
            VStack(alignment: .leading, spacing: 4) {
                Text(release.title)
                    .font(.subheadline)
                    .fontWeight(.semibold)
                    .foregroundColor(Color(hex: "#f0f0f0"))
                    .lineLimit(1)

                if let date = release.releaseDate {
                    Text(date, style: .date)
                        .font(.caption)
                        .foregroundColor(.gray)
                } else {
                    Text("No date set")
                        .font(.caption)
                        .foregroundColor(.gray.opacity(0.5))
                }
            }

            Spacer()

            // Progress indicator: "X/6 done" based on checklist items
            let done = checklistDoneCount(release)
            let total = 6 // Total checklist items
            VStack(spacing: 4) {
                // Circular progress ring
                ZStack {
                    Circle()
                        .stroke(Color(hex: "#222222"), lineWidth: 3)
                    Circle()
                        .trim(from: 0, to: CGFloat(done) / CGFloat(total))
                        .stroke(Color(hex: "#2dd4bf"), style: StrokeStyle(lineWidth: 3, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                }
                .frame(width: 32, height: 32)

                Text("\(done)/\(total)")
                    .font(.caption2)
                    .foregroundColor(.gray)
            }
        }
        .padding(14)
        .background(Color(hex: "#111111"))
        .cornerRadius(12)
    }

    // MARK: - Helpers

    // Count how many checklist items are done for a release
    private func checklistDoneCount(_ release: Release) -> Int {
        var count = 0
        if release.mixingDone { count += 1 }
        if release.masteringDone { count += 1 }
        if release.artworkReady { count += 1 }
        if release.dspSubmitted { count += 1 }
        if release.socialPostsDone { count += 1 }
        if release.pressReleaseDone { count += 1 }
        return count
    }

    // MARK: - Data Loading
    private func loadReleases() async {
        isLoading = true
        do {
            releases = try await SupabaseService.shared.fetchReleases()
        } catch {
            print("PipelineView: Failed to load releases — \(error.localizedDescription)")
        }
        isLoading = false
    }
}
