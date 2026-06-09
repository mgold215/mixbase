import Foundation

// Mirrors GET /api/infra/supabase.
struct SupabaseStatus: Decodable {
    let configured: Bool
    let managementConfigured: Bool
    let projectRef: String?
    let tables: [TableCount]
    let storage: Storage
    let db: DB
    let scalingSignals: [ScalingSignal]
    let error: String?

    struct TableCount: Decodable, Identifiable {
        let table: String
        let rowCount: Int?
        let error: String?
        var id: String { table }
    }

    struct Storage: Decodable {
        let buckets: [Bucket]
        let totalUsedBytes: Int?
    }

    struct Bucket: Decodable, Identifiable {
        let id: String
        let name: String
        let isPublic: Bool
        let fileSizeLimit: Int?
        let objectCount: Int?
        let usedBytes: Int?

        enum CodingKeys: String, CodingKey {
            case id, name, fileSizeLimit, objectCount, usedBytes
            case isPublic = "public"
        }
    }

    struct DB: Decodable {
        let sizeBytes: Int?
        let migrations: [Migration]?
    }

    struct Migration: Decodable, Identifiable {
        let version: String
        let name: String?
        var id: String { version }
    }

    struct ScalingSignal: Decodable, Identifiable {
        let id: String
        let label: String
        let usedBytes: Int
        let limitBytes: Int
        let pct: Double
        let severity: String
    }
}

// Mirrors POST /api/infra/chat.
struct ChatResponse: Decodable {
    let text: String
    let toolLog: [ToolLog]

    struct ToolLog: Decodable {
        let tool: String
        let result: String
    }
}
