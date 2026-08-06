import Foundation
import Photos

// MARK: - PhotoLibrarySaver
// Downloads a remote video (visualizer loop or finished render) and adds it to
// the user's Photos library — the iOS equivalent of the web app's share-sheet
// "Save Video". Uses add-only photo access so the permission prompt asks for
// the narrowest thing possible; URLSession.download streams to disk, so even a
// full-length 1080p render never has to fit in memory.

enum PhotoSaveError: LocalizedError {
    case invalidURL
    case downloadFailed
    case permissionDenied
    case saveFailed

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "That video link is invalid."
        case .downloadFailed:
            return "Could not download the video. Check your connection and try again."
        case .permissionDenied:
            return "Allow photo access for mixBase in Settings to save videos to your Photos library."
        case .saveFailed:
            return "Could not save the video to your Photos library."
        }
    }
}

enum PhotoLibrarySaver {

    /// Download the video at `urlString` and save it into the Photos library.
    static func saveVideo(from urlString: String) async throws {
        guard let url = URL(string: urlString) else { throw PhotoSaveError.invalidURL }

        // Ask for permission BEFORE downloading so a denial doesn't waste the
        // transfer. .addOnly means the prompt is "Add Photos Only" — the app
        // never asks to read the library here.
        let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
        guard status == .authorized || status == .limited else {
            throw PhotoSaveError.permissionDenied
        }

        let tempUrl: URL
        do {
            let (downloaded, response) = try await URLSession.shared.download(from: url)
            guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
                try? FileManager.default.removeItem(at: downloaded)
                throw PhotoSaveError.downloadFailed
            }
            tempUrl = downloaded
        } catch let error as PhotoSaveError {
            throw error
        } catch {
            throw PhotoSaveError.downloadFailed
        }

        // URLSession's temp file has a ".tmp" name; Photos identifies the
        // container by extension, so give it the real one before handing it over.
        let ext = url.pathExtension.isEmpty ? "mp4" : url.pathExtension
        let localUrl = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension(ext)
        do {
            try FileManager.default.moveItem(at: tempUrl, to: localUrl)
        } catch {
            try? FileManager.default.removeItem(at: tempUrl)
            throw PhotoSaveError.saveFailed
        }
        defer { try? FileManager.default.removeItem(at: localUrl) }

        do {
            try await PHPhotoLibrary.shared().performChanges {
                PHAssetChangeRequest.creationRequestForAssetFromVideo(atFileURL: localUrl)
            }
        } catch {
            throw PhotoSaveError.saveFailed
        }
    }
}
