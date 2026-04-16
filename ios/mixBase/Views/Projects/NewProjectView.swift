import SwiftUI
import UniformTypeIdentifiers

// MARK: - NewProjectView
// Create a new project and upload a track in one step.
// Fields: Title (required), Genre, BPM, Audio file.
// On submit, creates the project, uploads audio, and creates v1.

struct NewProjectView: View {

    @Environment(\.dismiss) private var dismiss
    var onCreated: () -> Void

    // Form fields
    @State private var title = ""
    @State private var genre = ""
    @State private var bpmText = ""
    @State private var label = ""

    // Audio file selection
    @State private var showFilePicker = false
    @State private var selectedFileURL: URL?
    @State private var selectedFileName: String?

    // UI state
    @State private var isSubmitting = false
    @State private var uploadProgress: String?
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            ZStack {
                Color(hex: "#080808")
                    .ignoresSafeArea()

                Form {
                    // MARK: - Title (required)
                    Section {
                        TextField("Project title", text: $title)
                            .foregroundColor(Color(hex: "#f0f0f0"))
                    } header: {
                        Text("Title *")
                            .foregroundColor(Color(hex: "#2dd4bf"))
                    }

                    // MARK: - Audio File
                    Section {
                        Button(action: { showFilePicker = true }) {
                            HStack {
                                Image(systemName: selectedFileURL != nil ? "checkmark.circle.fill" : "doc.badge.plus")
                                    .foregroundColor(selectedFileURL != nil ? Color(hex: "#2dd4bf") : .gray)
                                if let name = selectedFileName {
                                    Text(name)
                                        .foregroundColor(Color(hex: "#f0f0f0"))
                                        .lineLimit(1)
                                } else {
                                    Text("Choose audio file")
                                        .foregroundColor(.gray)
                                }
                                Spacer()
                                Image(systemName: "folder")
                                    .foregroundColor(.gray)
                            }
                        }
                    } header: {
                        Text("Audio File")
                            .foregroundColor(Color(hex: "#2dd4bf"))
                    } footer: {
                        Text("MP3, WAV, M4A, FLAC, AAC")
                            .foregroundColor(.gray.opacity(0.5))
                    }

                    // MARK: - Version Label
                    Section {
                        TextField("e.g. Rough Mix, Demo, Final", text: $label)
                            .foregroundColor(Color(hex: "#f0f0f0"))
                    } header: {
                        Text("Version Label")
                            .foregroundColor(.gray)
                    }

                    // MARK: - Genre
                    Section {
                        TextField("e.g. House, Hip-Hop, Ambient", text: $genre)
                            .foregroundColor(Color(hex: "#f0f0f0"))
                    } header: {
                        Text("Genre")
                            .foregroundColor(.gray)
                    }

                    // MARK: - BPM
                    Section {
                        TextField("e.g. 128", text: $bpmText)
                            .foregroundColor(Color(hex: "#f0f0f0"))
                            .keyboardType(.numberPad)
                    } header: {
                        Text("BPM")
                            .foregroundColor(.gray)
                    }

                    // MARK: - Error / Progress
                    if let errorMessage {
                        Section {
                            Text(errorMessage)
                                .foregroundColor(.red)
                                .font(.caption)
                        }
                    }

                    if let uploadProgress {
                        Section {
                            HStack {
                                ProgressView()
                                    .tint(Color(hex: "#2dd4bf"))
                                Text(uploadProgress)
                                    .font(.caption)
                                    .foregroundColor(.gray)
                            }
                        }
                    }

                    // MARK: - Create Button
                    Section {
                        Button(action: createProjectWithTrack) {
                            if isSubmitting {
                                ProgressView()
                                    .tint(Color(hex: "#2dd4bf"))
                            } else {
                                Text("Create Project")
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
                .scrollContentBackground(.hidden)
            }
            .navigationTitle("New Project")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .foregroundColor(.gray)
                }
            }
            // File picker for audio files
            .fileImporter(
                isPresented: $showFilePicker,
                allowedContentTypes: [.audio, .mp3, .wav, .aiff, .mpeg4Audio],
                allowsMultipleSelection: false
            ) { result in
                switch result {
                case .success(let urls):
                    if let url = urls.first {
                        selectedFileURL = url
                        selectedFileName = url.lastPathComponent
                    }
                case .failure(let error):
                    errorMessage = "Failed to select file: \(error.localizedDescription)"
                }
            }
        }
    }

    // MARK: - Create Project + Upload Track
    private func createProjectWithTrack() {
        guard !title.trimmingCharacters(in: .whitespaces).isEmpty else {
            errorMessage = "Title is required"
            return
        }

        isSubmitting = true
        errorMessage = nil
        let bpm = Int(bpmText)

        Task {
            do {
                // Step 1: Create the project
                uploadProgress = "Creating project..."
                let project = try await SupabaseService.shared.createProject(
                    title: title.trimmingCharacters(in: .whitespaces),
                    genre: genre.isEmpty ? nil : genre,
                    bpm: bpm
                )

                // Step 2: Upload audio file if one was selected
                if let fileURL = selectedFileURL {
                    // Start accessing the security-scoped resource
                    guard fileURL.startAccessingSecurityScopedResource() else {
                        errorMessage = "Cannot access the selected file"
                        isSubmitting = false
                        uploadProgress = nil
                        return
                    }
                    defer { fileURL.stopAccessingSecurityScopedResource() }

                    uploadProgress = "Uploading audio..."
                    let audioData = try Data(contentsOf: fileURL)
                    let ext = fileURL.pathExtension.lowercased()
                    let filename = "\(project.id.uuidString)-v1.\(ext)"

                    let audioPublicUrl = try await SupabaseService.shared.uploadAudio(
                        data: audioData,
                        filename: filename
                    )

                    // Step 3: Create version 1
                    uploadProgress = "Creating version..."
                    _ = try await SupabaseService.shared.createVersion(
                        projectId: project.id,
                        versionNumber: 1,
                        audioUrl: audioPublicUrl,
                        label: label.isEmpty ? nil : label
                    )
                }

                uploadProgress = nil
                onCreated()
                dismiss()
            } catch {
                errorMessage = "Failed: \(error.localizedDescription)"
                isSubmitting = false
                uploadProgress = nil
            }
        }
    }
}
