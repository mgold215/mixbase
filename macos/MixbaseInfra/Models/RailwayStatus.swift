import Foundation

// Mirrors GET /api/infra/railway.
struct RailwayStatus: Decodable {
    let configured: Bool
    let project: Project?
    let environments: [Environment]
    let error: String?

    struct Project: Decodable {
        let id: String
        let name: String
    }

    struct Environment: Decodable, Identifiable {
        let name: String
        let url: String
        let health: Health
        let deployment: Deployment?
        var id: String { name }
    }

    struct Health: Decodable {
        let ok: Bool
        let db: String
        let httpStatus: Int?
        let latencyMs: Int?
        let error: String?
    }

    struct Deployment: Decodable {
        let status: String?
        let url: String?
        let createdAt: String?
    }
}
