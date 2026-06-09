import Foundation

@MainActor
final class TopologyViewModel: ObservableObject {
    @Published var topology: InfraTopology?
    @Published var railway: RailwayStatus?
    @Published var supabase: SupabaseStatus?
    @Published var github: GithubStatus?
    @Published var stripe: StripeStatus?
    @Published var sentry: SentryStatus?
    @Published var isLoading = false
    @Published var errorMessage: String?
    @Published var notAuthorized = false
    @Published var selectedNodeId: String?
    @Published var lastUpdated: Date?

    let client: InfraAPIClient

    init(client: InfraAPIClient) { self.client = client }

    var selectedNode: InfraNode? {
        guard let id = selectedNodeId else { return nil }
        return topology?.nodes.first { $0.id == id }
    }

    func loadAll() async {
        isLoading = true
        errorMessage = nil
        notAuthorized = false
        defer { isLoading = false }
        do {
            async let topo: InfraTopology = client.get("/api/infra/topology")
            async let rail: RailwayStatus = client.get("/api/infra/railway")
            async let supa: SupabaseStatus = client.get("/api/infra/supabase")
            async let gh: GithubStatus = client.get("/api/infra/github")
            async let st: StripeStatus = client.get("/api/infra/stripe")
            async let se: SentryStatus = client.get("/api/infra/sentry")
            topology = try await topo
            railway = try await rail
            supabase = try await supa
            github = try await gh
            stripe = try await st
            sentry = try await se
            lastUpdated = Date()
        } catch InfraAPIClient.APIError.unauthorized {
            notAuthorized = true
            errorMessage = "This account isn't an admin, or the session expired. Sign out and back in."
        } catch {
            errorMessage = "Failed to load infra status: \(error.localizedDescription)"
        }
    }

    /// The Railway environment matching a railway node (railway-prod / railway-staging).
    func railwayEnvironment(for node: InfraNode) -> RailwayStatus.Environment? {
        let target = node.id == "railway-prod" ? "production" : node.id == "railway-staging" ? "staging" : nil
        guard let target = target else { return nil }
        return railway?.environments.first { $0.name == target }
    }
}
