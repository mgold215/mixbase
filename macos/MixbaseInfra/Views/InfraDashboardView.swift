import SwiftUI

struct InfraDashboardView: View {
    @EnvironmentObject var auth: AuthViewModel
    @EnvironmentObject var client: InfraAPIClient
    @EnvironmentObject var vm: TopologyViewModel

    var body: some View {
        VStack(spacing: 0) {
            toolbar
            content
        }
        .background(Palette.background)
        .task { if vm.topology == nil { await vm.loadAll() } }
    }

    // MARK: - Toolbar

    private var toolbar: some View {
        HStack(spacing: 12) {
            Image(systemName: "point.3.connected.trianglepath.dotted").foregroundStyle(Palette.accent)
            Text("mixBase Infra").font(.system(size: 14, weight: .bold))
            Text(client.environment.label.uppercased())
                .font(.system(size: 9, weight: .bold))
                .padding(.horizontal, 6).padding(.vertical, 2)
                .background(Capsule().fill(Palette.accent.opacity(0.18)))
                .foregroundStyle(Palette.accent)

            if let s = vm.topology?.sources {
                sourcePill("Railway", configured: s.railway.configured)
                sourcePill("Supabase", configured: s.supabase.configured)
                if !s.supabase.managementConfigured { sourcePill("Mgmt API", configured: false) }
                if let st = s.stripe { sourcePill("Stripe", configured: st.configured) }
                if let se = s.sentry { sourcePill("Sentry", configured: se.configured) }
            }

            Spacer()

            if let updated = vm.lastUpdated {
                Text("Updated \(updated.formatted(date: .omitted, time: .shortened))")
                    .font(.system(size: 10)).foregroundStyle(.secondary)
            }
            Button { Task { await vm.loadAll() } } label: {
                Image(systemName: "arrow.clockwise")
            }
            .disabled(vm.isLoading)
            .help("Refresh")

            Button("Sign Out") { Task { await auth.logout() } }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(Palette.bar)
    }

    private func sourcePill(_ label: String, configured: Bool) -> some View {
        HStack(spacing: 4) {
            Circle().fill(configured ? Color(hex: "34d399") : Color(hex: "9ca3af")).frame(width: 6, height: 6)
            Text(label).font(.system(size: 9, weight: .medium)).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 6).padding(.vertical, 2)
        .background(Capsule().fill(Color.white.opacity(0.05)))
    }

    // MARK: - Content

    @ViewBuilder
    private var content: some View {
        if vm.isLoading && vm.topology == nil {
            centered { ProgressView("Loading infra…") }
        } else if let topology = vm.topology {
            HSplitView {
                VStack(spacing: 0) {
                    GraphCanvasView(topology: topology, selectedNodeId: $vm.selectedNodeId)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                    QueryBarView()
                }
                InspectorView()
                    .frame(minWidth: 300, idealWidth: 350, maxWidth: 480)
            }
        } else {
            centered {
                VStack(spacing: 10) {
                    Image(systemName: "exclamationmark.triangle").font(.largeTitle).foregroundStyle(.orange)
                    Text(vm.errorMessage ?? "No data").foregroundStyle(.secondary).multilineTextAlignment(.center)
                    if vm.notAuthorized {
                        Button("Sign Out") { Task { await auth.logout() } }
                    } else {
                        Button("Retry") { Task { await vm.loadAll() } }
                    }
                }
                .padding(40)
            }
        }
    }

    private func centered<C: View>(@ViewBuilder _ c: () -> C) -> some View {
        VStack { Spacer(); c(); Spacer() }.frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
