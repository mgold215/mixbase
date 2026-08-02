import Foundation

// MARK: - ArtworkService
// AI artwork generation for your tracks. All paid AI calls run SERVER-SIDE via
// the web app's authenticated /api/generate-artwork route (see MixbaseAPI) —
// the server holds the Replicate key, enforces the monthly tier limits, uploads
// the image to storage and applies it to the project in one call. Nothing paid
// or secret ships in the app binary.

class ArtworkService: ObservableObject {

    // The single shared instance
    static let shared = ArtworkService()

    /// True while an image is being generated (UI shows a spinner)
    @Published var isGenerating: Bool = false

    private init() {}

    // MARK: - Generate + Apply Artwork

    /// Generate artwork for a project and apply it as the project's cover.
    /// The server does generation, storage upload and the DB update atomically.
    /// - Returns: the public URL of the newly applied artwork
    func generateArtwork(projectId: UUID, prompt: String, model: String, vary: Bool) async throws -> String {
        await MainActor.run { isGenerating = true }
        defer { Task { @MainActor in isGenerating = false } }

        return try await MixbaseAPI.shared.generateArtwork(
            projectId: projectId,
            prompt: prompt,
            model: model,
            vary: vary
        )
    }

    // MARK: - Auto-Generate a Prompt
    // Builds a rich visual prompt from the track's metadata locally — no API
    // call, instant, and works offline. Genre drives the palette/mood, BPM
    // drives the energy, and a rotating set of compositions keeps repeat taps
    // from producing the same prompt twice.

    func autoGeneratePrompt(projectId: UUID) async throws -> String {
        let project = try await SupabaseService.shared.fetchProject(id: projectId)
        return buildPrompt(title: project.title, genre: project.genre, bpm: project.bpm)
    }

    func buildPrompt(title: String, genre: String?, bpm: Int?) -> String {
        let normalizedGenre = (genre ?? "").lowercased()

        // Palette + scene keyed off genre families
        let look: (palette: String, scene: String)
        switch normalizedGenre {
        case let g where g.contains("house") || g.contains("techno") || g.contains("edm") || g.contains("dance"):
            look = ("neon teal and magenta against deep black", "an abstract nightclub lightscape with volumetric beams and haze")
        case let g where g.contains("hip") || g.contains("rap") || g.contains("trap"):
            look = ("high-contrast gold and charcoal", "a moody urban scene at night, wet streets reflecting city lights")
        case let g where g.contains("ambient") || g.contains("chill") || g.contains("lo-fi") || g.contains("lofi"):
            look = ("soft pastel gradients of dusk blue and warm peach", "a dreamlike minimal landscape dissolving into fog")
        case let g where g.contains("rock") || g.contains("metal") || g.contains("punk"):
            look = ("gritty monochrome with a single blood-red accent", "raw textured surfaces, torn paper and analog grain")
        case let g where g.contains("jazz") || g.contains("soul") || g.contains("funk"):
            look = ("rich amber, burgundy and brass tones", "a smoky intimate stage lit by a single warm spotlight")
        case let g where g.contains("pop"):
            look = ("vivid candy colors with glossy highlights", "a bold playful studio set with clean geometric shapes")
        case let g where g.contains("folk") || g.contains("acoustic") || g.contains("country"):
            look = ("earthy ochre, sage and cream", "golden-hour light over an open natural landscape")
        default:
            look = ("a striking duotone palette", "an evocative abstract composition with strong depth")
        }

        // Energy from BPM
        let energy: String
        switch bpm ?? 0 {
        case 1..<90: energy = "slow, contemplative atmosphere"
        case 90..<120: energy = "steady, confident energy"
        case 120..<140: energy = "driving, kinetic energy"
        case 140...: energy = "frenetic, high-voltage intensity"
        default: energy = "balanced, cinematic mood"
        }

        // Rotate composition so repeat taps feel fresh
        let compositions = [
            "centered symmetrical composition with generous negative space",
            "dramatic low-angle perspective with strong leading lines",
            "extreme close-up with shallow depth of field",
            "wide establishing shot with a lone focal subject",
            "overhead top-down composition with graphic repetition",
        ]
        let composition = compositions.randomElement() ?? compositions[0]

        return "Album artwork evoking \"\(title)\": \(look.scene), \(look.palette), \(energy), \(composition). No text or typography."
    }
}
