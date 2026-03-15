import SwiftUI

struct BotListView: View {
    @Environment(AppState.self) private var appState
    @State private var showCreateGroup = false

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 0) {
                // Bots section
                ForEach(appState.bots) { bot in
                    let latestSession = appState.sessions.values
                        .filter { $0.botName == bot.name && $0.groupId == nil }
                        .sorted(by: { $0.updatedAt > $1.updatedAt })
                        .first

                    BotCard(
                        bot: bot,
                        latestSession: latestSession,
                        isActive: appState.activeBotName == bot.name,
                        onTap: {
                            if let session = latestSession {
                                appState.selectSession(session.id)
                            } else {
                                _ = appState.getOrCreateSession(botName: bot.name)
                            }
                        },
                        onNewSession: {
                            _ = appState.createSession(botName: bot.name)
                        }
                    )

                    Divider()
                        .padding(.leading, 76)
                }

                // Groups section
                if !appState.groups.isEmpty {
                    HStack {
                        Text("Groups")
                            .font(.caption.bold())
                            .foregroundStyle(.secondary)
                            .textCase(.uppercase)
                        Spacer()
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 20)
                    .padding(.bottom, 8)

                    ForEach(appState.groups) { group in
                        groupCard(group)
                        Divider()
                            .padding(.leading, 76)
                    }
                }
            }
        }
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
                    }
                }
            }
        }
        .sheet(isPresented: $showCreateGroup) {
            GroupCreateDialog()
                .environment(appState)
        }
    }

    private func groupCard(_ group: ChatGroup) -> some View {
        let latestSession = appState.sessions.values
            .filter { $0.groupId == group.id }
            .sorted(by: { $0.updatedAt > $1.updatedAt })
            .first

        return Button {
            if let session = latestSession {
                appState.selectSession(session.id)
            } else {
                _ = appState.createGroupSession(group: group)
            }
        } label: {
            HStack(spacing: 12) {
                // Group avatar
                ZStack {
                    Circle()
                        .fill(Color.accentColor.opacity(0.15))
                        .frame(width: 48, height: 48)
                    Image(systemName: "person.3.fill")
                        .font(.system(size: 16))
                        .foregroundStyle(Color.accentColor)
                }

                VStack(alignment: .leading, spacing: 3) {
                    Text(group.name)
                        .font(.subheadline.bold())
                        .foregroundStyle(.primary)
                    Text(group.members.joined(separator: ", "))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                Spacer()

                // Delete
                Button {
                    appState.deleteGroup(group.id)
                } label: {
                    Image(systemName: "trash")
                        .font(.caption)
                        .foregroundStyle(.red.opacity(0.6))
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
