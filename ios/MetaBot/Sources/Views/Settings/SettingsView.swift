import SwiftUI

struct SettingsView: View {
    @Environment(AppState.self) private var appState

    @State private var showClearConfirm = false

    /// On iOS 26+, use clear background for Liquid Glass compatibility.
    private static var settingsBackground: Color {
        if #available(iOS 26, *) {
            return Color.clear
        }
        return NexusColors.surface0
    }

    var body: some View {
        @Bindable var appState = appState

        NavigationStack {
            List {
                // Connection
                Section {
                    HStack {
                        Text("Status")
                            .foregroundStyle(NexusColors.text0)
                        Spacer()
                        HStack(spacing: 6) {
                            Circle()
                                .fill(appState.isConnected ? NexusColors.green : NexusColors.text2)
                                .frame(width: 8, height: 8)
                            Text(appState.isConnected ? "Connected" : "Disconnected")
                                .foregroundStyle(NexusColors.text1)
                        }
                    }
                    .listRowBackground(NexusColors.surface1)

                    HStack {
                        Text("Server")
                            .foregroundStyle(NexusColors.text0)
                        Spacer()
                        Text(appState.serverURL)
                            .foregroundStyle(NexusColors.text1)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    .listRowBackground(NexusColors.surface1)

                    if let token = appState.auth.token {
                        HStack {
                            Text("Token")
                                .foregroundStyle(NexusColors.text0)
                            Spacer()
                            Text(String(token.prefix(6)) + "------")
                                .foregroundStyle(NexusColors.text1)
                                .font(NexusTypography.codeBody)
                        }
                        .listRowBackground(NexusColors.surface1)
                    }
                } header: {
                    Text("Connection")
                        .font(NexusTypography.label)
                        .foregroundStyle(NexusColors.text2)
                        .textCase(.uppercase)
                }

                // Appearance
                Section {
                    Picker("Theme", selection: $appState.colorScheme) {
                        Text("System").tag(Optional<ColorScheme>.none)
                        Text("Light").tag(Optional<ColorScheme>.some(.light))
                        Text("Dark").tag(Optional<ColorScheme>.some(.dark))
                    }
                    .foregroundStyle(NexusColors.text0)
                    .listRowBackground(NexusColors.surface1)

                    Picker("Font Size", selection: $appState.fontScale) {
                        Text("Small").tag(0.9)
                        Text("Normal").tag(1.0)
                        Text("Large").tag(1.1)
                        Text("Extra Large").tag(1.25)
                    }
                    .pickerStyle(.menu)
                    .foregroundStyle(NexusColors.text0)
                    .listRowBackground(NexusColors.surface1)
                } header: {
                    Text("Appearance")
                        .font(NexusTypography.label)
                        .foregroundStyle(NexusColors.text2)
                        .textCase(.uppercase)
                }

                // Agents
                Section {
                    if appState.bots.isEmpty {
                        Text("No bots available")
                            .foregroundStyle(NexusColors.text2)
                            .listRowBackground(NexusColors.surface1)
                    } else {
                        ForEach(appState.bots) { bot in
                            HStack(spacing: 12) {
                                GradientAvatar(name: bot.name, size: 32)
                                VStack(alignment: .leading) {
                                    Text(bot.name)
                                        .font(NexusTypography.body)
                                        .foregroundStyle(NexusColors.text0)
                                    if let platform = bot.platform {
                                        Text(platform)
                                            .font(NexusTypography.caption)
                                            .foregroundStyle(NexusColors.text1)
                                    }
                                }
                            }
                            .listRowBackground(NexusColors.surface1)
                        }
                    }
                } header: {
                    Text("Agents (\(appState.bots.count))")
                        .font(NexusTypography.label)
                        .foregroundStyle(NexusColors.text2)
                        .textCase(.uppercase)
                }

                // Groups
                if !appState.groups.isEmpty {
                    Section {
                        ForEach(appState.groups) { group in
                            HStack(spacing: 12) {
                                Image(systemName: "person.3.fill")
                                    .foregroundStyle(NexusColors.accent)
                                    .frame(width: 32, height: 32)
                                VStack(alignment: .leading) {
                                    Text(group.name)
                                        .font(NexusTypography.body)
                                        .foregroundStyle(NexusColors.text0)
                                    Text(group.members.joined(separator: ", "))
                                        .font(NexusTypography.caption)
                                        .foregroundStyle(NexusColors.text1)
                                }
                            }
                            .listRowBackground(NexusColors.surface1)
                        }
                    } header: {
                        Text("Groups (\(appState.groups.count))")
                            .font(NexusTypography.label)
                            .foregroundStyle(NexusColors.text2)
                            .textCase(.uppercase)
                    }
                }

                // Data
                Section {
                    HStack {
                        Text("Chat History")
                            .foregroundStyle(NexusColors.text0)
                        Spacer()
                        Text("\(appState.sessions.count) conversation(s)")
                            .foregroundStyle(NexusColors.text1)
                    }
                    .listRowBackground(NexusColors.surface1)

                    Button("Clear All Conversations", role: .destructive) {
                        showClearConfirm = true
                    }
                    .foregroundStyle(NexusColors.red)
                    .listRowBackground(NexusColors.surface1)
                } header: {
                    Text("Data")
                        .font(NexusTypography.label)
                        .foregroundStyle(NexusColors.text2)
                        .textCase(.uppercase)
                }

                // Account
                Section {
                    Button("Disconnect", role: .destructive) {
                        appState.disconnect()
                        appState.auth.logout()
                    }
                    .foregroundStyle(NexusColors.red)
                    .listRowBackground(NexusColors.surface1)
                }

                // About
                Section {
                    HStack {
                        Spacer()
                        Text("MetaBot iOS -- Built with Claude Code Agent SDK")
                            .font(NexusTypography.label)
                            .foregroundStyle(NexusColors.text2)
                        Spacer()
                    }
                    .listRowBackground(Color.clear)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Self.settingsBackground)
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
