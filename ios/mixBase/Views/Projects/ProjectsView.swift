import SwiftUI

// MARK: - ProjectsView
// Displays a grid of project cards (2 columns).
// Each card shows artwork, title, genre/BPM, version count, and a status badge.
// Tapping a card navigates to ProjectDetailView.
// A "+" button in the toolbar lets you create new projects.

struct ProjectsView: View {

    // All projects fetched from Supabase
    @State private var projects: [Project] = []

    // Show the New Project sheet
    @State private var showNewProject = false

    // Loading state
    @State private var isLoading = true

    // 2-column grid layout
    private let columns = [
        GridItem(.flexible(), spacing: 12),
        GridItem(.flexible(), spacing: 12)
    ]

    var body: some View {
        NavigationStack {
            ZStack {
                // Dark background
                Color(hex: "#080808")
                    .ignoresSafeArea()

                ScrollView {
                    if isLoading {
                        // Show a spinner while data is loading
                        ProgressView()
                            .tint(Color(hex: "#2dd4bf"))
                            .padding(.top, 60)
                    } else if projects.isEmpty {
                        // Empty state when no projects exist yet
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
                        // MARK: - Project Grid
                        LazyVGrid(columns: columns, spacing: 16) {
                            ForEach(projects) { project in
                                NavigationLink(destination: ProjectDetailView(projectId: project.id)) {
                                    projectCard(project: project)
                                }
                                .buttonStyle(.plain) // Remove default NavigationLink blue tint
                            }
                        }
                        .padding(.horizontal)
                        .padding(.top, 12)
                        .padding(.bottom, 80) // Space for mini player
                    }
                }
            }
            .navigationTitle("Projects")
            .navigationBarTitleDisplayMode(.large)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbar {
                // "New Project" plus button in the top right
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button(action: { showNewProject = true }) {
                        Image(systemName: "plus")
                            .foregroundColor(Color(hex: "#2dd4bf"))
                    }
                }
            }
            // Present NewProjectView as a sheet
            .sheet(isPresented: $showNewProject) {
                NewProjectView(onCreated: {
                    // Refresh the project list after a new one is created
                    Task { await loadProjects() }
                })
            }
            // Fetch projects when the view appears
            .task {
                await loadProjects()
            }
        }
    }

    // MARK: - Project Card
    // A single card in the grid showing the project info
    @ViewBuilder
    private func projectCard(project: Project) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            // Artwork image (or placeholder)
            if let artworkUrl = project.artworkUrl, let url = URL(string: artworkUrl) {
                AsyncImage(url: url) { image in
                    image
                        .resizable()
                        .aspectRatio(contentMode: .fill)
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

            // Project title
            Text(project.title)
                .font(.subheadline)
                .fontWeight(.semibold)
                .foregroundColor(Color(hex: "#f0f0f0"))
                .lineLimit(1)

            // Genre and BPM on one line
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

            // Status badge (using a default status for the project level)
            StatusBadge(status: "WIP")
        }
        .padding(10)
        .background(Color(hex: "#111111"))
        .cornerRadius(12)
    }

    // Placeholder artwork when no image URL exists
    private var artworkPlaceholder: some View {
        RoundedRectangle(cornerRadius: 10)
            .fill(Color(hex: "#1a1a1a"))
            .overlay(
                Image(systemName: "music.note")
                    .font(.title)
                    .foregroundColor(.gray.opacity(0.4))
            )
    }

    // MARK: - Data Loading
    private func loadProjects() async {
        isLoading = true
        do {
            projects = try await SupabaseService.shared.fetchProjects()
        } catch {
            print("ProjectsView: Failed to load projects — \(error.localizedDescription)")
        }
        isLoading = false
    }
}
