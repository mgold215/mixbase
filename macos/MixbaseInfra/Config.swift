import Foundation

// Target environment for the backend the app talks to. The infra endpoints live
// in the deployed Next.js app, so we just point at prod or staging.
enum InfraEnvironment: String, CaseIterable, Identifiable {
    case production
    case staging

    var id: String { rawValue }
    var label: String { self == .production ? "Production" : "Staging" }

    var baseURL: URL {
        switch self {
        case .production: return URL(string: "https://mixbase.app")!
        case .staging:    return URL(string: "https://mixbase-staging.up.railway.app")!
        }
    }
}

enum Config {
    static let keychainService = "com.moodmixformat.mixbase.infra"
}
