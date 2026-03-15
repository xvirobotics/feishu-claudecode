import SwiftUI

struct MainTabView: View {
    @Environment(AppState.self) private var appState
    @State private var selectedSidebarItem: SidebarItem? = .chats

    enum SidebarItem: Hashable {
        case chats
        case memory
        case settings
    }

    var body: some View {
        NavigationSplitView {
            List(selection: $selectedSidebarItem) {
                Section {
                    NavigationLink(value: SidebarItem.chats) {
                        Label("Chats", systemImage: "bubble.left.and.bubble.right")
                    }
                    NavigationLink(value: SidebarItem.memory) {
                        Label("Memory", systemImage: "book")
                    }
                    NavigationLink(value: SidebarItem.settings) {
                        Label("Settings", systemImage: "gearshape")
                    }
                }
            }
            .navigationTitle("MetaBot")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    connectionDot
                }
            }
        } content: {
            switch selectedSidebarItem {
            case .chats, .none:
                BotListView()
                    .navigationTitle("Chats")
            case .memory:
                MemoryView()
            case .settings:
                SettingsView()
            }
        } detail: {
            if selectedSidebarItem == .chats || selectedSidebarItem == nil {
                if appState.activeSession != nil {
                    ChatView()
                        .toolbar {
                            ToolbarItem(placement: .principal) {
                                if let bot = appState.activeBot {
                                    HStack(spacing: 8) {
                                        GradientAvatar(name: bot.name, size: 28)
                                        Text(bot.name)
                                            .font(.headline)
                                    }
                                }
                            }
                        }
                } else {
                    ContentUnavailableView {
                        Label("Select a Chat", systemImage: "bubble.left.and.bubble.right")
                    } description: {
                        Text("Choose an agent from the sidebar to start chatting")
                    }
                }
            } else {
                ContentUnavailableView {
                    Label("", systemImage: "")
                }
                .hidden()
            }
        }
    }

    private var connectionDot: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(appState.isConnected ? .green : .gray)
                .frame(width: 8, height: 8)
            Text(appState.isConnected ? "Live" : "Offline")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}

// MARK: - Phone layout (TabView)

struct MobileTabView: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        if appState.showingChat, appState.activeSession != nil {
            // Full-screen chat
            NavigationStack {
                ChatView()
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .topBarLeading) {
                            Button {
                                appState.showingChat = false
                            } label: {
                                HStack(spacing: 4) {
                                    Image(systemName: "chevron.left")
                                    Text("Back")
                                }
                            }
                        }
                        ToolbarItem(placement: .principal) {
                            if let bot = appState.activeBot {
                                HStack(spacing: 8) {
                                    GradientAvatar(name: bot.name, size: 26)
                                    Text(bot.name)
                                        .font(.headline)
                                    Circle()
                                        .fill(appState.isConnected ? .green : .gray)
                                        .frame(width: 8, height: 8)
                                }
                            }
                        }
                    }
            }
        } else {
            TabView(selection: Binding(
                get: { appState.activeTab },
                set: { appState.activeTab = $0 }
            )) {
                NavigationStack {
                    BotListView()
                        .navigationTitle("Chats")
                        .toolbar {
                            ToolbarItem(placement: .topBarTrailing) {
                                HStack(spacing: 4) {
                                    Circle()
                                        .fill(appState.isConnected ? .green : .gray)
                                        .frame(width: 8, height: 8)
                                    Text(appState.isConnected ? "Live" : "Offline")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                }
                .tabItem {
                    Label("Chats", systemImage: "bubble.left.and.bubble.right")
                }
                .tag(AppTab.chats)

                MemoryView()
                    .tabItem {
                        Label("Memory", systemImage: "book")
                    }
                    .tag(AppTab.memory)

                SettingsView()
                    .tabItem {
                        Label("Settings", systemImage: "gearshape")
                    }
                    .tag(AppTab.settings)
            }
            .tint(.accentColor)
        }
    }
}
