import SwiftUI

// MARK: - ArtworkGeneratorView
// Flow for generating AI artwork for a project — matching the web Artwork tab:
// 1. Describe the artwork (or tap "Auto" to build a prompt from track metadata)
// 2. Pick an image model (FLUX Ultra, Seedream, Imagen, Recraft, ...)
// 3. Optionally toggle "Vary the look" for a randomized photographic treatment
// 4. Generate — the server creates the image AND applies it to the project
// Generation is tier-gated server-side; limit errors surface with upgrade copy.

struct ArtworkGeneratorView: View {

    // The project this artwork will be applied to
    let projectId: UUID

    // Lets the presenting screen update its artwork immediately on success
    var onGenerated: ((String) -> Void)? = nil

    @Environment(\.dismiss) private var dismiss

    // The prompt description text
    @State private var prompt = ""

    // Selected image model (ids mirror the server registry)
    @State private var selectedModelId = MixbaseAPI.imageModels[0].id

    // Randomized photographic look (lens/light/weather/mood) on top of the prompt
    @State private var varyLook = false

    // The artwork the server generated and applied
    @State private var generatedArtworkUrl: String?

    @State private var isGenerating = false
    @State private var isAutoPrompting = false
    @State private var errorMessage: String?

    var body: some View {
        ZStack {
            Color(hex: "#080808")
                .ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    // MARK: - Prompt Section
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Describe your artwork")
                            .font(.headline)
                            .foregroundColor(Color(hex: "#f0f0f0"))

                        HStack(spacing: 8) {
                            TextField("e.g. Neon city skyline at night, vinyl textures...", text: $prompt, axis: .vertical)
                                .foregroundColor(Color(hex: "#f0f0f0"))
                                .padding(12)
                                .background(Color(hex: "#161616"))
                                .cornerRadius(10)
                                .lineLimit(3...6)

                            // "Auto" — builds a prompt from the track's title/genre/BPM
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

                    // MARK: - Model Picker
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Model")
                            .font(.headline)
                            .foregroundColor(Color(hex: "#f0f0f0"))
                            .padding(.horizontal)

                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 8) {
                                ForEach(MixbaseAPI.imageModels) { model in
                                    Button(action: { selectedModelId = model.id }) {
                                        Text(model.label)
                                            .font(.caption)
                                            .fontWeight(.medium)
                                            .padding(.horizontal, 14)
                                            .padding(.vertical, 8)
                                            .foregroundColor(
                                                selectedModelId == model.id
                                                    ? Color(hex: "#080808")
                                                    : Color(hex: "#f0f0f0")
                                            )
                                            .background(
                                                selectedModelId == model.id
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

                    // MARK: - Vary Toggle
                    Toggle(isOn: $varyLook) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Vary the look")
                                .font(.subheadline)
                                .fontWeight(.medium)
                                .foregroundColor(Color(hex: "#f0f0f0"))
                            Text("Adds a randomized lens, light and mood treatment")
                                .font(.caption2)
                                .foregroundColor(.gray)
                        }
                    }
                    .tint(Color(hex: "#2dd4bf"))
                    .padding(.horizontal)

                    // MARK: - Generate Button
                    Button(action: generateArtwork) {
                        HStack {
                            if isGenerating {
                                ProgressView()
                                    .tint(Color(hex: "#080808"))
                            } else {
                                Image(systemName: "paintbrush.pointed")
                                Text(generatedArtworkUrl == nil ? "Generate" : "Generate Another")
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

                    // MARK: - Error Message (incl. tier-limit upgrade copy)
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
                            Text("Generating artwork — this can take up to a minute...")
                                .font(.subheadline)
                                .foregroundColor(.gray)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 40)
                    }

                    // MARK: - Result
                    // The server already applied this as the project artwork.
                    if let urlString = generatedArtworkUrl, let url = URL(string: urlString) {
                        VStack(alignment: .leading, spacing: 12) {
                            HStack(spacing: 6) {
                                Image(systemName: "checkmark.circle.fill")
                                    .foregroundColor(Color(hex: "#2dd4bf"))
                                Text("Applied as project artwork")
                                    .font(.subheadline)
                                    .fontWeight(.medium)
                                    .foregroundColor(Color(hex: "#f0f0f0"))
                            }
                            .padding(.horizontal)

                            AsyncImage(url: url) { image in
                                image
                                    .resizable()
                                    .aspectRatio(contentMode: .fit)
                            } placeholder: {
                                RoundedRectangle(cornerRadius: 12)
                                    .fill(Color(hex: "#1a1a1a"))
                                    .aspectRatio(1, contentMode: .fit)
                                    .overlay(ProgressView().tint(.gray))
                            }
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                            .padding(.horizontal)

                            Button(action: { dismiss() }) {
                                Text("Done")
                                    .font(.headline)
                                    .foregroundColor(Color(hex: "#080808"))
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 14)
                                    .background(Color(hex: "#2dd4bf"))
                                    .cornerRadius(12)
                            }
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
    // Builds a prompt from the track's metadata — instant, no API call.
    private func autoGeneratePrompt() {
        isAutoPrompting = true
        errorMessage = nil

        Task {
            do {
                prompt = try await ArtworkService.shared.autoGeneratePrompt(projectId: projectId)
            } catch {
                errorMessage = "Failed to auto-generate prompt: \(error.localizedDescription)"
            }
            isAutoPrompting = false
        }
    }

    // MARK: - Generate Artwork
    // One server call generates the image, saves it and applies it to the project.
    private func generateArtwork() {
        isGenerating = true
        errorMessage = nil

        Task {
            do {
                let artworkUrl = try await ArtworkService.shared.generateArtwork(
                    projectId: projectId,
                    prompt: prompt,
                    model: selectedModelId,
                    vary: varyLook
                )
                generatedArtworkUrl = artworkUrl
                onGenerated?(artworkUrl)
            } catch {
                errorMessage = error.localizedDescription
            }
            isGenerating = false
        }
    }
}
