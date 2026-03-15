import SwiftUI

struct BotListView: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 0) {
                ForEach(appState.bots) { bot in
                    let latestSession = appState.sessions.values
                        .filter { $0.botName == bot.name }
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
    }
}
