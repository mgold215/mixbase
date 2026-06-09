import SwiftUI

struct QueryBarView: View {
    @EnvironmentObject var client: InfraAPIClient
    @State private var query = ""
    @State private var answer: String?
    @State private var tools: [String] = []
    @State private var busy = false
    @State private var expanded = false

    var body: some View {
        VStack(spacing: 0) {
            if expanded, let answer = answer {
                ScrollView {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(answer)
                            .font(.system(size: 12))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        if !tools.isEmpty {
                            Text("tools: " + tools.joined(separator: ", "))
                                .font(.system(size: 10))
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(10)
                }
                .frame(maxHeight: 150)
                .background(Palette.panel)
            }
            HStack(spacing: 8) {
                Image(systemName: "sparkles").foregroundStyle(Palette.accent)
                TextField("Ask about your infra…  e.g. how full is mf-audio? which tables are biggest?", text: $query)
                    .textFieldStyle(.plain)
                    .onSubmit(send)
                if busy { ProgressView().controlSize(.small) }
                if expanded {
                    Button { expanded = false } label: { Image(systemName: "chevron.down") }
                        .buttonStyle(.plain).foregroundStyle(.secondary)
                }
                Button("Ask", action: send)
                    .disabled(busy || query.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .padding(10)
            .background(Palette.bar)
        }
    }

    private func send() {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty, !busy else { return }
        busy = true
        expanded = true
        answer = nil
        Task {
            do {
                let resp: ChatResponse = try await client.postJSON(
                    "/api/infra/chat",
                    body: ["messages": [["role": "user", "content": q]]]
                )
                answer = resp.text
                tools = resp.toolLog.map { $0.tool }
            } catch {
                answer = "Query failed: \(error.localizedDescription)"
                tools = []
            }
            busy = false
            query = ""
        }
    }
}
