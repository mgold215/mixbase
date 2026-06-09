import SwiftUI

struct RootView: View {
    @EnvironmentObject var auth: AuthViewModel

    var body: some View {
        Group {
            if auth.isChecking {
                VStack(spacing: 12) {
                    ProgressView()
                    Text("Connecting…").foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Palette.background)
            } else if auth.isAuthenticated {
                InfraDashboardView()
            } else {
                LoginView()
            }
        }
        .frame(minWidth: 980, minHeight: 640)
        .task { await auth.restore() }
    }
}
