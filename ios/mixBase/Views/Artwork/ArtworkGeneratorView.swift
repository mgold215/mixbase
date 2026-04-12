import SwiftUI

// MARK: - ArtworkGeneratorView
// Flow for generating AI artwork for a project.
// 1. Enter a prompt description (or tap "Auto" to generate one with Claude)
// 2. Pick a style (Photographic, Abstract, Illustration, Minimal, Cinematic)
// 3. Tap "Generate" to create artwork via Replicate/FLUX
// 4. Browse results in a horizontal scroll
// 5. Tap to select, then "Apply" to set it as the project artwork

struct ArtworkGeneratorView: View {

    // The project this artwork will be applied to
    let projectId: UUID

    // Dismiss the view after applying artwork
    @Environment(\.dismiss) private var dismiss

    // The prompt description text
    @State private var prompt = ""

    // Available style options for the segmented control
    private let styles = ["Photographic", "Abstract", "Illustration", "Minimal", "Cinematic"]

    // Currently selected style index
    @State private var selectedStyleIndex = 0

    // Generated image URLs from the AI service
    @State private var generatedImageUrls: [String] = []

    // Which generated image the user has selected (by index)
    @State private var selectedImageIndex: Int?

    // Loading state while generating
    @State private var isGenerating = false

    // Loading state while applying (uploading + updating project)
    @State private var isApplying = false

    // Error message to display
    @State private var errorMessage: String?

    // Whether auto-prompt is loading
    @State private var isAutoPrompting = false

    var body: some View {
        ZStack {
            // Dark background
            Color(hex: "#080808")
                .ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    // MARK: - Prompt Section
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Describe your artwork")
                            .font(.headline)
                            .foregroundColor(Color(hex: "#f0f0f0"))

                        // Text field for the prompt with an "Auto" button
                        HStack(spacing: 8) {
                            TextField("e.g. Neon city skyline at night, vinyl textures...", text: $prompt, axis: .vertical)
                                .foregroundColor(Color(hex: "#f0f0f0"))
                                .padding(12)
                                .background(Color(hex: "#161616"))
                                .cornerRadius(10)
                                .lineLimit(3...6)

                            // "Auto" button — uses Claude to generate a prompt
                            Button(action: autoGeneratePrompt) {
                                if isAutoPrompting {
                                    ProgressView()
                                        .tint(Color(hex: "#2dd4bf"))
                                        .frame(width: 50, height: 44)
                                } else {
                                    Text("Auto")
                                        .font(.caption)
                                        .fontWeight(.bold)
                                        .foregroundColor(Color(hex: "#080808"))
                                        .frame(width: 50, height: 44)
                                        .background(Color(hex: "#2dd4bf"))
                                        .cornerRadius(8)
                                }
                            }
                            .disabled(isAutoPrompting)
                        }
                    }
                    .padding(.horizontal)

                    // MARK: - Style Picker
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Style")
                            .font(.headline)
                            .foregroundColor(Color(hex: "#f0f0f0"))
                            .padding(.horizontal)

                        // Segmented control for style selection
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 8) {
                                ForEach(0..<styles.count, id: \.self) { index in
                                    Button(action: { selectedStyleIndex = index }) {
                                        Text(styles[index])
                                            .font(.caption)
                                            .fontWeight(.medium)
                                            .padding(.horizontal, 14)
                                            .padding(.vertical, 8)
                                            .foregroundColor(
                                                selectedStyleIndex == index
                                                    ? Color(hex: "#080808")
                                                    : Color(hex: "#f0f0f0")
                                            )
                                            .background(
                                                selectedStyleIndex == index
                                                    ? Color(hex: "#2dd4bf")
                                                    : Color(hex: "#222222")
                                            )
                                            .clipShape(Capsule())
                                    }
                                }
                            }
                            .padding(.horizontal)
                        }
                    }

                    // MARK: - Generate Button
                    Button(action: generateArtwork) {
                        HStack {
                            if isGenerating {
                                ProgressView()
                                    .tint(Color(hex: "#080808"))
                            } else {
                                Image(systemName: "paintbrush.pointed")
                                Text("Generate")
                            }
                        }
                        .font(.headline)
                        .foregroundColor(Color(hex: "#080808"))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(
                            prompt.isEmpty || isGenerating
                                ? Color.gray.opacity(0.4)
                                : Color(hex: "#2dd4bf")
                        )
                        .cornerRadius(12)
                    }
                    .disabled(prompt.isEmpty || isGenerating)
                    .padding(.horizontal)

                    // MARK: - Error Message
                    if let errorMessage {
                        Text(errorMessage)
                            .font(.caption)
                            .foregroundColor(.red)
                            .padding(.horizontal)
                    }

                    // MARK: - Loading State
                    if isGenerating {
                        VStack(spacing: 12) {
                            ProgressView()
                                .tint(Color(hex: "#2dd4bf"))
                                .scaleEffect(1.5)
                            Text("Generating artwork...")
                                .font(.subheadline)
                                .foregroundColor(.gray)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 40)
                    }

                    // MARK: - Generated Results
                    if !generatedImageUrls.isEmpty {
                        VStack(alignment: .leading, spacing: 12) {
                            Text("Results")
                                .font(.headline)
                                .foregroundColor(Color(hex: "#f0f0f0"))
                                .padding(.horizontal)

                            // Horizontal scroll of generated images
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 12) {
                                    ForEach(0..<generatedImageUrls.count, id: \.self) { index in
                                        if let url = URL(string: generatedImageUrls[index]) {
                                            AsyncImage(url: url) { image in
                                                image
                                                    .resizable()
                                                    .aspectRatio(contentMode: .fill)
                                            } placeholder: {
                                                RoundedRectangle(cornerRadius: 12)
                                                    .fill(Color(hex: "#1a1a1a"))
                                                    .overlay(ProgressView().tint(.gray))
                                            }
                                            .frame(width: 200, height: 200)
                                            .clipShape(RoundedRectangle(cornerRadius: 12))
                                            // Teal border on the selected image
                                            .overlay(
                                                RoundedRectangle(cornerRadius: 12)
                                                    .stroke(
                                                        selectedImageIndex == index
                                                            ? Color(hex: "#2dd4bf")
                                                            : Color.clear,
                                                        lineWidth: 3
                                                    )
                                            )
                                            .onTapGesture {
                                                selectedImageIndex = index
                                            }
                                        }
                                    }
                                }
                                .padding(.horizontal)
                            }
                        }

                        // MARK: - Apply Button
                        if selectedImageIndex != nil {
                            Button(action: applyArtwork) {
                                HStack {
                                    if isApplying {
                                        ProgressView()
                                            .tint(Color(hex: "#080808"))
                                    } else {
                                        Image(systemName: "checkmark.circle")
                                        Text("Apply")
                                    }
                                }
                                .font(.headline)
                                .foregroundColor(Color(hex: "#080808"))
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 14)
                                .background(Color(hex: "#2dd4bf"))
                                .cornerRadius(12)
                            }
                            .disabled(isApplying)
                            .padding(.horizontal)
                        }
                    }

                    Spacer(minLength: 80)
                }
                .padding(.top, 16)
            }
        }
        .navigationTitle("Generate Artwork")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarColorScheme(.dark, for: .navigationBar)
    }

    // MARK: - Auto Generate Prompt
    // Uses Claude (via ArtworkService) to create a descriptive prompt automatically
    private func autoGeneratePrompt() {
        isAutoPrompting = true
        errorMessage = nil

        Task {
            do {
                let autoPrompt = try await ArtworkService.shared.autoGeneratePrompt(projectId: projectId)
                prompt = autoPrompt
            } catch {
                errorMessage = "Failed to auto-generate prompt: \(error.localizedDescription)"
            }
            isAutoPrompting = false
        }
    }

    // MARK: - Generate Artwork
    // Calls ArtworkService to generate images using the prompt + selected style
    private func generateArtwork() {
        isGenerating = true
        errorMessage = nil
        generatedImageUrls = []
        selectedImageIndex = nil

        Task {
            do {
                let style = styles[selectedStyleIndex]
                let urls = try await ArtworkService.shared.generateArtwork(
                    prompt: prompt,
                    style: style
                )
                generatedImageUrls = urls
            } catch {
                errorMessage = "Failed to generate artwork: \(error.localizedDescription)"
            }
            isGenerating = false
        }
    }

    // MARK: - Apply Artwork
    // Uploads the selected image and updates the project's artwork_url
    private func applyArtwork() {
        guard let index = selectedImageIndex, index < generatedImageUrls.count else { return }

        isApplying = true
        errorMessage = nil

        Task {
            do {
                let imageUrl = generatedImageUrls[index]
                try await ArtworkService.shared.applyArtwork(
                    imageUrl: imageUrl,
                    projectId: projectId
                )
                // Success — go back to the project detail
                dismiss()
            } catch {
                errorMessage = "Failed to apply artwork: \(error.localizedDescription)"
            }
            isApplying = false
        }
    }
}
