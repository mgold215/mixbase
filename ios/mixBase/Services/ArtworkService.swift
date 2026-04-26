import Foundation

// MARK: - ArtworkService
// Handles AI-powered artwork generation for your tracks.
// Uses two APIs:
// 1. Anthropic Claude — to generate a creative visual prompt from track metadata
// 2. Replicate FLUX — to turn that prompt into actual images
// This is an ObservableObject so SwiftUI can show loading states.

class ArtworkService: ObservableObject {

    // The single shared instance
    static let shared = ArtworkService()

    // MARK: - Published Properties

    /// True while images are being generated (used to show a loading spinner in the UI)
    @Published var isGenerating: Bool = false

    // Private init — singleton pattern
    private init() {}

    // MARK: - Generate Artwork Images

    /// Sends a text prompt to Replicate's FLUX model and returns generated image URLs.
    /// - Parameters:
    ///   - prompt: A description of what the artwork should look like
    ///   - style: An optional style modifier (e.g. "minimalist", "abstract")
    /// - Returns: An array of image URLs (typically 2-4 images)
    func generateArtwork(prompt: String, style: String) async throws -> [String] {
        // Mark that we're generating (UI can show a spinner)
        await MainActor.run { isGenerating = true }

        // Make sure we reset the flag when we're done, even if there's an error
        defer {
            Task { @MainActor in isGenerating = false }
        }

        // Combine the prompt with the style for a richer result
        let fullPrompt = style.isEmpty ? prompt : "\(prompt). Style: \(style)"

        // MARK: Step 1 — Start the prediction on Replicate
        // This sends the prompt to the FLUX model and gets back a prediction ID.
        // The images aren't ready yet — Replicate processes them asynchronously.

        let createURL = URL(string: "https://api.replicate.com/v1/predictions")!
        var createRequest = URLRequest(url: createURL)
        createRequest.httpMethod = "POST"
        createRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        createRequest.setValue("Token \(Config.replicateAPIKey)", forHTTPHeaderField: "Authorization")

        // The request body tells Replicate which model to use and what to generate
        let requestBody: [String: Any] = [
            "version": "5599ed30703defd1d160a25a63321b4dec97101d98b4674bcc56e41f62f35637",
            "input": [
                "prompt": fullPrompt,
                "num_outputs": 4,           // Generate 4 image options
                "aspect_ratio": "1:1",      // Square — standard for album art
                "output_format": "png",
                "output_quality": 90
            ]
        ]

        createRequest.httpBody = try JSONSerialization.data(withJSONObject: requestBody)

        let (createData, createResponse) = try await URLSession.shared.data(for: createRequest)
        try validateResponse(createResponse)

        // Parse the response to get the prediction ID
        guard let createResult = try JSONSerialization.jsonObject(with: createData) as? [String: Any],
              let predictionId = createResult["id"] as? String else {
            throw ArtworkError.invalidResponse("Failed to start image generation")
        }

        // MARK: Step 2 — Poll until the prediction is complete
        // Replicate processes images asynchronously, so we check every 2 seconds
        // until the status changes to "succeeded" or "failed".

        let pollURL = URL(string: "https://api.replicate.com/v1/predictions/\(predictionId)")!
        var imageURLs: [String] = []

        // Try for up to 60 seconds (30 polls x 2 seconds each)
        for _ in 0..<30 {
            // Wait 2 seconds between polls
            try await Task.sleep(nanoseconds: 2_000_000_000)

            var pollRequest = URLRequest(url: pollURL)
            pollRequest.setValue("Token \(Config.replicateAPIKey)", forHTTPHeaderField: "Authorization")

            let (pollData, pollResponse) = try await URLSession.shared.data(for: pollRequest)
            try validateResponse(pollResponse)

            guard let pollResult = try JSONSerialization.jsonObject(with: pollData) as? [String: Any],
                  let status = pollResult["status"] as? String else {
                continue
            }

            switch status {
            case "succeeded":
                // Images are ready — extract the URLs from the "output" array
                if let output = pollResult["output"] as? [String] {
                    imageURLs = output
                }
                return imageURLs

            case "failed", "canceled":
                // Something went wrong on Replicate's side
                let errorMessage = pollResult["error"] as? String ?? "Unknown error"
                throw ArtworkError.generationFailed(errorMessage)

            default:
                // Still processing — keep polling
                continue
            }
        }

        // If we get here, 60 seconds passed without completion
        throw ArtworkError.timeout
    }

    // MARK: - Auto-Generate a Prompt Using Claude

    /// Uses Anthropic's Claude to create a visual artwork prompt
    /// from basic track metadata (title, genre, BPM).
    /// This saves you from having to write prompts yourself.
    /// - Returns: A 1-2 sentence visual prompt ready for image generation
    func autoGeneratePrompt(title: String, genre: String?, bpm: Int?) async throws -> String {
        let apiURL = URL(string: "https://api.anthropic.com/v1/messages")!
        var request = URLRequest(url: apiURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(Config.anthropicAPIKey, forHTTPHeaderField: "x-api-key")
        request.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")

        // Build a description of the track for Claude to work with
        var trackDescription = "Track title: \"\(title)\""
        if let genre = genre { trackDescription += ", Genre: \(genre)" }
        if let bpm = bpm { trackDescription += ", BPM: \(bpm)" }

        // The request body tells Claude what we want:
        // - A system prompt explaining its role
        // - A user message with the track details
        let requestBody: [String: Any] = [
            "model": "claude-sonnet-4-20250514",
            "max_tokens": 200,
            "system": "You are a creative director for album artwork. Given a track title, genre, and BPM, write a concise visual prompt (1-2 sentences) for an AI image generator. Focus on mood, color palette, and composition. Do not mention text or typography.",
            "messages": [
                [
                    "role": "user",
                    "content": trackDescription
                ]
            ]
        ]

        request.httpBody = try JSONSerialization.data(withJSONObject: requestBody)

        let (data, response) = try await URLSession.shared.data(for: request)
        try validateResponse(response)

        // Parse Claude's response to extract the generated prompt text
        guard let result = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let content = result["content"] as? [[String: Any]],
              let firstBlock = content.first,
              let text = firstBlock["text"] as? String else {
            throw ArtworkError.invalidResponse("Failed to parse Claude response")
        }

        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: - Auto-Generate Prompt by Project ID
    // Convenience method: fetches the project from Supabase, then calls the
    // title/genre/bpm version above.

    func autoGeneratePrompt(projectId: UUID) async throws -> String {
        let project = try await SupabaseService.shared.fetchProject(id: projectId)
        return try await autoGeneratePrompt(title: project.title, genre: project.genre, bpm: project.bpm)
    }

    // MARK: - Apply Artwork to a Project
    // Downloads the generated image, uploads it to Supabase Storage,
    // and updates the project's artwork_url field.

    func applyArtwork(imageUrl: String, projectId: UUID) async throws {
        // Download the image from the Replicate URL
        guard let url = URL(string: imageUrl) else {
            throw ArtworkError.invalidResponse("Invalid image URL")
        }
        let (imageData, _) = try await URLSession.shared.data(from: url)

        // Upload to Supabase Storage (mf-artwork bucket)
        let filename = "\(projectId.uuidString)/\(Int(Date().timeIntervalSince1970)).png"
        let publicUrl = try await SupabaseService.shared.uploadArtwork(data: imageData, filename: filename)

        // Update the project's artwork_url
        var project = try await SupabaseService.shared.fetchProject(id: projectId)
        project.artworkUrl = publicUrl
        try await SupabaseService.shared.updateProject(project)
    }

    // MARK: - Response Validation

    /// Check that the HTTP response code is in the success range (200-299)
    private func validateResponse(_ response: URLResponse) throws {
        guard let httpResponse = response as? HTTPURLResponse else {
            throw ArtworkError.invalidResponse("Not an HTTP response")
        }
        guard (200...299).contains(httpResponse.statusCode) else {
            throw ArtworkError.httpError(statusCode: httpResponse.statusCode)
        }
    }
}

// MARK: - ArtworkError
// Custom error types for artwork generation failures.

enum ArtworkError: LocalizedError {
    case invalidResponse(String)
    case generationFailed(String)
    case httpError(statusCode: Int)
    case timeout

    var errorDescription: String? {
        switch self {
        case .invalidResponse(let message):
            return "Invalid response: \(message)"
        case .generationFailed(let message):
            return "Generation failed: \(message)"
        case .httpError(let code):
            return "HTTP error: \(code)"
        case .timeout:
            return "Image generation timed out after 60 seconds"
        }
    }
}
