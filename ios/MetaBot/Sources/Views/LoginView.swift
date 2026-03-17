import SwiftUI

struct LoginView: View {
    @Environment(AppState.self) private var appState

    @State private var tokenInput = ""
    @State private var serverInput = ""
    @State private var errorMessage: String?
    @State private var isLoading = false

    var body: some View {
        ZStack {
            // NEXUS background
            NexusColors.void.ignoresSafeArea()
            RadialGradient(
                colors: [NexusColors.accent.opacity(0.08), .clear],
                center: .top,
                startRadius: 0,
                endRadius: 400
            )
            .ignoresSafeArea()

            VStack(spacing: 0) {
                Spacer()

                // Logo
                VStack(spacing: 16) {
                    ZStack {
                        Circle()
                            .stroke(NexusColors.accent.opacity(0.2), lineWidth: 1.5)
                            .frame(width: 88, height: 88)
                        Circle()
                            .fill(NexusColors.accentSoft)
                            .frame(width: 72, height: 72)
                        Text("M")
                            .font(.system(size: 32, weight: .bold, design: .rounded))
                            .foregroundStyle(NexusColors.accent)
                    }

                    Text("MetaBot")
                        .font(NexusTypography.title)
                        .foregroundStyle(NexusColors.text0)

                    Text("Claude Code Agent, Anywhere")
                        .font(NexusTypography.body)
                        .foregroundStyle(NexusColors.text2)
                }
                .padding(.bottom, 48)

                // Form
                VStack(spacing: 20) {
                    // Server URL field
                    VStack(alignment: .leading, spacing: 6) {
                        Text("SERVER URL")
                            .font(NexusTypography.jetBrainsMono(size: 10))
                            .foregroundStyle(NexusColors.text2)
                            .tracking(1)
                        TextField("https://metabot.example.com", text: $serverInput)
                            .font(NexusTypography.body)
                            .foregroundStyle(NexusColors.text0)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 12)
                            .background(NexusColors.surface1)
                            .clipShape(RoundedRectangle(cornerRadius: NexusRadius.md))
                            .overlay {
                                RoundedRectangle(cornerRadius: NexusRadius.md)
                                    .stroke(NexusColors.glassBorder, lineWidth: 1)
                            }
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .keyboardType(.URL)
                    }

                    // API Token field
                    VStack(alignment: .leading, spacing: 6) {
                        Text("API TOKEN")
                            .font(NexusTypography.jetBrainsMono(size: 10))
                            .foregroundStyle(NexusColors.text2)
                            .tracking(1)
                        SecureField("Enter your API token", text: $tokenInput)
                            .font(NexusTypography.body)
                            .foregroundStyle(NexusColors.text0)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 12)
                            .background(NexusColors.surface1)
                            .clipShape(RoundedRectangle(cornerRadius: NexusRadius.md))
                            .overlay {
                                RoundedRectangle(cornerRadius: NexusRadius.md)
                                    .stroke(NexusColors.glassBorder, lineWidth: 1)
                            }
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }

                    // Error message
                    if let errorMessage {
                        Text(errorMessage)
                            .font(NexusTypography.caption)
                            .foregroundStyle(NexusColors.red)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }

                    // Connect button
                    Button {
                        Task { await login() }
                    } label: {
                        if isLoading {
                            ProgressView()
                                .tint(.white)
                        } else {
                            Text("Connect")
                                .font(NexusTypography.spaceGrotesk(size: 16, weight: .semibold))
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .frame(height: 50)
                    .foregroundStyle(.white)
                    .background(NexusColors.accent)
                    .clipShape(RoundedRectangle(cornerRadius: NexusRadius.md))
                    .shadow(color: NexusColors.accent.opacity(0.3), radius: 12, x: 0, y: 4)
                    .disabled(tokenInput.isEmpty || isLoading)
                    .opacity(tokenInput.isEmpty ? 0.5 : 1)
                }
                .frame(maxWidth: 400)
                .padding(.horizontal, 32)

                Spacer()
            }
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
