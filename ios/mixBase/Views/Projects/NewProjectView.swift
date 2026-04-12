import SwiftUI

// MARK: - NewProjectView
// A simple form for creating a new project.
// Fields: Title (required), Genre (optional), BPM (optional).
// On submit, calls SupabaseService.createProject and dismisses the sheet.

struct NewProjectView: View {

    // Dismiss this sheet when done
    @Environment(\.dismiss) private var dismiss

    // Callback to tell the parent view to refresh its project list
    var onCreated: () -> Void

    // Form field values
    @State private var title = ""
    @State private var genre = ""
    @State private var bpmText = ""

    // UI state
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            ZStack {
                // Dark background
                Color(hex: "#080808")
                    .ignoresSafeArea()

                Form {
                    // MARK: - Title Field (required)
                    Section {
                        TextField("Project title", text: $title)
                            .foregroundColor(Color(hex: "#f0f0f0"))
                    } header: {
                        Text("Title *")
                            .foregroundColor(Color(hex: "#2dd4bf"))
                    }

                    // MARK: - Genre Field (optional)
                    Section {
                        TextField("e.g. House, Hip-Hop, Ambient", text: $genre)
                            .foregroundColor(Color(hex: "#f0f0f0"))
                    } header: {
                        Text("Genre")
                            .foregroundColor(.gray)
                    }

                    // MARK: - BPM Field (optional, numbers only)
                    Section {
                        TextField("e.g. 128", text: $bpmText)
                            .foregroundColor(Color(hex: "#f0f0f0"))
                            .keyboardType(.numberPad)
                    } header: {
                        Text("BPM")
                            .foregroundColor(.gray)
                    }

                    // MARK: - Error Message
                    if let errorMessage {
                        Section {
                            Text(errorMessage)
                                .foregroundColor(.red)
                                .font(.caption)
                        }
                    }

                    // MARK: - Create Button
                    Section {
                        Button(action: createProject) {
                            if isSubmitting {
                                ProgressView()
                                    .tint(Color(hex: "#2dd4bf"))
                            } else {
                                Text("Create")
                                    .fontWeight(.semibold)
                                    .foregroundColor(Color(hex: "#080808"))
                                    .frame(maxWidth: .infinity)
                            }
                        }
                        .listRowBackground(
                            title.isEmpty
                                ? Color.gray.opacity(0.3)
                                : Color(hex: "#2dd4bf")
                        )
                        .disabled(title.isEmpty || isSubmitting)
                    }
                }
                .scrollContentBackground(.hidden) // Hide default white form background
            }
            .navigationTitle("New Project")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbar {
                // Cancel button to dismiss without saving
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .foregroundColor(.gray)
                }
            }
        }
    }

    // MARK: - Create Project
    // Validate the title, build the project, send it to Supabase
    private func createProject() {
        // Title is required
        guard !title.trimmingCharacters(in: .whitespaces).isEmpty else {
            errorMessage = "Title is required"
            return
        }

        isSubmitting = true
        errorMessage = nil

        // Parse BPM from text (nil if empty or not a valid number)
        let bpm = Int(bpmText)

        Task {
            do {
                _ = try await SupabaseService.shared.createProject(
                    title: title.trimmingCharacters(in: .whitespaces),
                    genre: genre.isEmpty ? nil : genre,
                    bpm: bpm
                )
                // Success — notify parent and dismiss
                onCreated()
                dismiss()
            } catch {
                errorMessage = "Failed to create project: \(error.localizedDescription)"
                isSubmitting = false
            }
        }
    }
}
