import SwiftUI

struct SettingsView: View {
    @Environment(AppState.self) private var appState

    @State private var showClearConfirm = false

    var body: some View {
        NavigationStack {
            List {
                // Connection
                Section("Connection") {
                    HStack {
                        Text("Status")
                        Spacer()
                        HStack(spacing: 6) {
                            Circle()
                                .fill(appState.isConnected ? .green : .gray)
                                .frame(width: 8, height: 8)
                            Text(appState.isConnected ? "Connected" : "Disconnected")
                                .foregroundStyle(.secondary)
                        }
                    }

                    HStack {
                        Text("Server")
                        Spacer()
                        Text(appState.serverURL)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }

                    if let token = appState.auth.token {
                        HStack {
                            Text("Token")
                            Spacer()
                            Text(String(token.prefix(6)) + "••••••")
                                .foregroundStyle(.secondary)
                                .font(.system(.body, design: .monospaced))
                        }
                    }
                }

                // Appearance
                Section("Appearance") {
                    Picker("Theme", selection: Binding(
                        get: { appState.colorScheme },
                        set: { appState.colorScheme = $0 }
                    )) {
                        Text("System").tag(Optional<ColorScheme>.none)
                        Text("Light").tag(Optional<ColorScheme>.some(.light))
                        Text("Dark").tag(Optional<ColorScheme>.some(.dark))
                    }
                }

                // Agents
                Section("Agents (\(appState.bots.count))") {
                    if appState.bots.isEmpty {
                        Text("No bots available")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(appState.bots) { bot in
                            HStack(spacing: 12) {
                                GradientAvatar(name: bot.name, size: 32)
                                VStack(alignment: .leading) {
                                    Text(bot.name)
                                        .font(.subheadline.bold())
                                    if let platform = bot.platform {
                                        Text(platform)
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                            }
                        }
                    }
                }

                // Groups
                if !appState.groups.isEmpty {
                    Section("Groups (\(appState.groups.count))") {
                        ForEach(appState.groups) { group in
                            HStack(spacing: 12) {
                                Image(systemName: "person.3.fill")
                                    .foregroundStyle(Color.accentColor)
                                    .frame(width: 32, height: 32)
                                VStack(alignment: .leading) {
                                    Text(group.name)
                                        .font(.subheadline.bold())
                                    Text(group.members.joined(separator: ", "))
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }

                // Data
                Section("Data") {
                    HStack {
                        Text("Chat History")
                        Spacer()
                        Text("\(appState.sessions.count) conversation(s)")
                            .foregroundStyle(.secondary)
                    }

                    Button("Clear All Conversations", role: .destructive) {
                        showClearConfirm = true
                    }
                }

                // Account
                Section {
                    Button("Disconnect", role: .destructive) {
                        appState.disconnect()
                        appState.auth.logout()
                    }
                }

                // About
                Section {
                    HStack {
                        Spacer()
                        Text("MetaBot iOS · Built with Claude Code Agent SDK")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                        Spacer()
                    }
                    .listRowBackground(Color.clear)
                }
            }
            .navigationTitle("Settings")
            .alert("Clear All Conversations?", isPresented: $showClearConfirm) {
                Button("Cancel", role: .cancel) {}
                Button("Clear All", role: .destructive) {
                    appState.clearAllSessions()
                }
            } message: {
                Text("This will delete all local chat history. This cannot be undone.")
            }
        }
    }
}
