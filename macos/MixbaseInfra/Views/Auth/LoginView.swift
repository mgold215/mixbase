import SwiftUI

struct LoginView: View {
    @EnvironmentObject var auth: AuthViewModel
    @EnvironmentObject var client: InfraAPIClient
    @State private var password = ""

    var body: some View {
        VStack(spacing: 18) {
            Image(systemName: "point.3.connected.trianglepath.dotted")
                .font(.system(size: 44))
                .foregroundStyle(Palette.accent)
            Text("mixBase Infra").font(.system(size: 28, weight: .bold))
            Text("Sign in with your admin account").foregroundStyle(.secondary)

            Picker("Environment", selection: Binding(
                get: { client.environment },
                set: { client.setEnvironment($0) }
            )) {
                ForEach(InfraEnvironment.allCases) { Text($0.label).tag($0) }
            }
            .pickerStyle(.segmented)
            .frame(width: 280)
            .labelsHidden()

            TextField("Email", text: $auth.email)
                .textFieldStyle(.roundedBorder)
                .frame(width: 300)
            SecureField("Password", text: $password)
                .textFieldStyle(.roundedBorder)
                .frame(width: 300)
                .onSubmit { Task { await auth.login(password: password) } }

            if let err = auth.errorMessage {
                Text(err).foregroundStyle(.red).font(.caption)
            }

            Button {
                Task { await auth.login(password: password) }
            } label: {
                Text(auth.busy ? "Signing in…" : "Sign In")
                    .frame(width: 300)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(auth.busy || auth.email.isEmpty || password.isEmpty)
        }
        .padding(48)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Palette.background)
    }
}
