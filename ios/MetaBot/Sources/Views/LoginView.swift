import SwiftUI

struct LoginView: View {
    @Environment(AppState.self) private var appState

    @State private var tokenInput = ""
    @State private var serverInput = ""
    @State private var errorMessage: String?
    @State private var isLoading = false

    var body: some View {
        VStack(spacing: 0) {
            Spacer()

            // Logo
            VStack(spacing: 12) {
                ZStack {
                    Circle()
                        .fill(Color.accentColor.opacity(0.15))
                        .frame(width: 80, height: 80)
                    Text("M")
                        .font(.system(size: 36, weight: .bold, design: .rounded))
                        .foregroundStyle(Color.accentColor)
                }

                Text("MetaBot")
                    .font(.system(size: 28, weight: .bold, design: .rounded))
                    .foregroundStyle(.primary)

                Text("Claude Code Agent, Anywhere")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            .padding(.bottom, 48)

            // Form
            VStack(spacing: 16) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Server URL")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    TextField("https://metabot.example.com", text: $serverInput)
                        .textFieldStyle(.roundedBorder)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                }

                VStack(alignment: .leading, spacing: 6) {
                    Text("API Token")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    SecureField("Enter your API token", text: $tokenInput)
                        .textFieldStyle(.roundedBorder)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }

                if let errorMessage {
                    Text(errorMessage)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                Button {
                    Task { await login() }
                } label: {
                    if isLoading {
                        ProgressView()
                            .tint(.white)
                    } else {
                        Text("Connect")
                            .fontWeight(.semibold)
                    }
                }
                .frame(maxWidth: .infinity)
                .frame(height: 48)
                .background(Color.accentColor)
                .foregroundStyle(.white)
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .disabled(tokenInput.isEmpty || isLoading)
                .opacity(tokenInput.isEmpty ? 0.5 : 1)
            }
            .padding(.horizontal, 32)

            Spacer()
            Spacer()
        }
        .onAppear {
            serverInput = appState.serverURL
        }
    }

    private func login() async {
        isLoading = true
        errorMessage = nil

        let url = serverInput.trimmingCharacters(in: .whitespacesAndNewlines)
        let token = tokenInput.trimmingCharacters(in: .whitespacesAndNewlines)

        guard !url.isEmpty else {
            errorMessage = "Please enter server URL"
            isLoading = false
            return
        }

        appState.serverURL = url
        let success = await appState.auth.login(token: token, serverURL: url)

        if success {
            appState.connect()
        } else {
            errorMessage = appState.auth.validationError ?? "Connection failed"
        }

        isLoading = false
    }
}
