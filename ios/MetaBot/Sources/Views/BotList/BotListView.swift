import SwiftUI

struct BotListView: View {
    @Environment(AppState.self) private var appState
    @State private var showCreateGroup = false

    var body: some View {
        VStack(spacing: 0) {
            // "AGENTS" header with connection status
            HStack {
                Text("AGENTS")
                    .font(NexusTypography.jetBrainsMono(size: 9))
                    .foregroundStyle(NexusColors.text2)
                    .tracking(1.0)
                Spacer()
                HStack(spacing: 5) {
                    Circle()
                        .fill(appState.isConnected ? NexusColors.green : NexusColors.red)
                        .frame(width: 6, height: 6)
                        .shadow(
                            color: appState.isConnected ? NexusColors.green.opacity(0.5) : .clear,
                            radius: 4
                        )
                    Text(appState.isConnected ? "Live" : "Offline")
                        .font(NexusTypography.jetBrainsMono(size: 9))
                        .foregroundStyle(appState.isConnected ? NexusColors.green : NexusColors.red)
                        .tracking(1.0)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)

            // Bot list
            ScrollView {
                LazyVStack(spacing: 2) {
                    ForEach(appState.bots) { bot in
                        let botSessions = appState.sessions.values
                            .filter { $0.botName == bot.name && $0.groupId == nil }
                            .sorted(by: { $0.updatedAt > $1.updatedAt })

                        BotCard(
                            bot: bot,
                            sessions: botSessions,
                            activeSessionId: appState.activeSessionId,
                            latestSession: botSessions.first,
                            isActive: appState.activeBotName == bot.name,
                            onSelect: {
                                if let session = botSessions.first {
                                    appState.selectSession(session.id)
                                } else {
                                    _ = appState.getOrCreateSession(botName: bot.name)
                                }
                            },
                            onNewSession: {
                                _ = appState.createSession(botName: bot.name)
                            },
                            onSelectSession: { id in
                                appState.selectSession(id)
                            },
                            onDeleteSession: { id in
                                appState.deleteSession(id)
                            }
                        )
                    }

                    // Groups section
                    if !appState.groups.isEmpty {
                        groupsSection
                    }
                }
                .padding(.horizontal, 8)
            }
        }
        .background(listBackground)
        .overlay {
            if appState.bots.isEmpty {
                ContentUnavailableView {
                    Label("No Agents", systemImage: "person.3")
                } description: {
                    if appState.isConnected {
                        Text("No bots available on the server")
                    } else {
                        Text("Connecting to server...")
                    }
                }
            }
        }
        .toolbar {
            if appState.bots.count >= 2 {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showCreateGroup = true
                    } label: {
                        Image(systemName: "person.3.fill")
                            .font(.system(size: 14))
                            .foregroundStyle(NexusColors.accent)
                    }
                }
            }
        }
        .sheet(isPresented: $showCreateGroup) {
            GroupCreateDialog()
                .environment(appState)
        }
    }

    /// On iOS 26+, use clear background for Liquid Glass compatibility.
    private var listBackground: Color {
        if #available(iOS 26, *) {
            return Color.clear
        }
        return NexusColors.surface0
    }

    // MARK: - Groups Section

    private var groupsSection: some View {
        Group {
            HStack {
                Text("GROUPS")
                    .font(NexusTypography.jetBrainsMono(size: 9))
                    .foregroundStyle(NexusColors.text2)
                    .tracking(1.0)
                Spacer()
            }
            .padding(.horizontal, 14)
            .padding(.top, 12)
            .padding(.bottom, 4)

            ForEach(appState.groups) { group in
                groupCard(group)
            }
        }
    }

    private func groupCard(_ group: ChatGroup) -> some View {
        let latestSession = appState.sessions.values
            .filter { $0.groupId == group.id }
            .sorted(by: { $0.updatedAt > $1.updatedAt })
            .first

        return HStack(spacing: 12) {
            // Group avatar
            ZStack {
                Circle()
                    .fill(NexusColors.accentSofter)
                    .frame(width: 44, height: 44)
                Image(systemName: "person.3.fill")
                    .font(.system(size: 14))
                    .foregroundStyle(NexusColors.accentText)
            }

            VStack(alignment: .leading, spacing: 3) {
                Text(group.name)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(NexusColors.text0)
                Text(group.members.joined(separator: ", "))
                    .font(.system(size: 12.5))
                    .foregroundStyle(NexusColors.text2)
                    .lineLimit(1)
            }

            Spacer()

            // Delete button
            Button {
                appState.deleteGroup(group.id)
            } label: {
                Image(systemName: "trash")
                    .font(.caption)
                    .foregroundStyle(NexusColors.red.opacity(0.6))
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(Color.clear)
        .clipShape(RoundedRectangle(cornerRadius: NexusRadius.lg))
        .contentShape(Rectangle())
        .onTapGesture {
            if let session = latestSession {
                appState.selectSession(session.id)
            } else {
                _ = appState.createGroupSession(group: group)
            }
        }
    }
}
