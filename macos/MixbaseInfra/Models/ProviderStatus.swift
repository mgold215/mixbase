import Foundation

// Mirrors GET /api/infra/github.
struct GithubStatus: Decodable {
    let configured: Bool
    let authenticated: Bool
    let repo: String
    let runs: [Run]
    let error: String?

    struct Run: Decodable, Identifiable {
        let branch: String
        let status: String?
        let conclusion: String?
        let title: String
        let url: String
        let createdAt: String?
        var id: String { branch }
    }
}

// Mirrors GET /api/infra/stripe.
struct StripeStatus: Decodable {
    let configured: Bool
    let tierCounts: [String: Int]
    let estimatedMrrCents: Int
    let activeSubscriptions: Int?
    let error: String?
}

// Mirrors GET /api/infra/sentry.
struct SentryStatus: Decodable {
    let configured: Bool
    let org: String
    let project: String
    let shownIssues: Int?
    let recentIssues: [Issue]?
    let error: String?

    struct Issue: Decodable, Identifiable {
        let title: String
        let culprit: String?
        let count: String
        let lastSeen: String?
        let permalink: String?
        var id: String { title + (lastSeen ?? "") }
    }
}

// Mirrors POST /api/infra/actions.
struct ActionResult: Decodable {
    let ok: Bool
    let message: String
}
