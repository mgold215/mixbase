import SwiftUI

// Phase-3 safe, reversible control actions surfaced per node. Every action goes
// through a confirmation dialog before hitting POST /api/infra/actions.
struct NodeActionsView: View {
    let node: InfraNode
    @EnvironmentObject var client: InfraAPIClient

    @State private var busy = false
    @State private var result: String?
    @State private var pending: Action?

    struct Action: Identifiable {
        let id = UUID()
        let label: String
        let confirmTitle: String
        let body: [String: Any]
    }

    private var actions: [Action] {
        switch node.id {
        case "railway-prod", "railway-staging":
            let env = node.id == "railway-prod" ? "production" : "staging"
            return [
                Action(label: "Restart service", confirmTitle: "Restart \(env)?",
                       body: ["provider": "railway", "action": "restart", "environment": env, "confirm": true]),
                Action(label: "Redeploy latest", confirmTitle: "Redeploy \(env)?",
                       body: ["provider": "railway", "action": "redeploy", "environment": env, "confirm": true]),
            ]
        case "github":
            return [
                Action(label: "Re-run CI (tst)", confirmTitle: "Re-run latest CI on tst?",
                       body: ["provider": "github", "action": "rerun-ci", "branch": "tst", "confirm": true]),
            ]
        default:
            return []
        }
    }

    var body: some View {
        if !actions.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("ACTIONS")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(.secondary)
                ForEach(actions) { action in
                    Button {
                        pending = action
                    } label: {
                        Text(action.label).frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .disabled(busy)
                }
                if busy { ProgressView().controlSize(.small) }
                if let result = result {
                    Text(result).font(.system(size: 10)).foregroundStyle(.secondary)
                }
                Text("Reversible operations only. Each runs against live infra after you confirm.")
                    .font(.system(size: 9))
                    .foregroundStyle(.secondary)
            }
            .confirmationDialog(
                pending?.confirmTitle ?? "",
                isPresented: Binding(get: { pending != nil }, set: { if !$0 { pending = nil } }),
                presenting: pending
            ) { action in
                Button(action.label, role: .destructive) { run(action) }
                Button("Cancel", role: .cancel) { pending = nil }
            }
        }
    }

    private func run(_ action: Action) {
        busy = true
        result = nil
        pending = nil
        Task {
            do {
                let res: ActionResult = try await client.postJSON("/api/infra/actions", body: action.body)
                result = res.message
            } catch {
                result = "Failed: \(error.localizedDescription)"
            }
            busy = false
        }
    }
}
