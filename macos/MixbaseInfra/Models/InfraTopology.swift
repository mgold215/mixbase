import Foundation

// Mirrors GET /api/infra/topology. Enum-ish fields are decoded as String so a
// new backend value never breaks decoding; the UI interprets them.

struct InfraTopology: Decodable {
    let nodes: [InfraNode]
    let edges: [InfraEdge]
    let layerOrder: [String]
    let sources: Sources
    let generatedAt: String

    struct Sources: Decodable {
        let railway: ProviderSource
        let supabase: SupabaseSource
        let github: ConfiguredSource?
        let stripe: ConfiguredSource?
        let sentry: ConfiguredSource?
    }
    struct ProviderSource: Decodable {
        let configured: Bool
        let error: String?
    }
    struct SupabaseSource: Decodable {
        let configured: Bool
        let managementConfigured: Bool
    }
    struct ConfiguredSource: Decodable {
        let configured: Bool
    }
}

struct InfraNode: Decodable, Identifiable, Equatable {
    let id: String
    let type: String
    let provider: String
    let label: String
    let layer: String
    let statusSource: String
    let detail: String?
    let status: String
    let metric: String?

    enum CodingKeys: String, CodingKey {
        case id, type, provider, label, layer, statusSource, status, metric
        case detail = "description"
    }
}

struct InfraEdge: Decodable, Identifiable {
    let from: String
    let to: String
    let label: String?
    let kind: String?
    var id: String { "\(from)->\(to)" }
}
