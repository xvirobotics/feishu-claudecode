import SwiftUI

struct MainTabView: View {
    @Environment(AppState.self) private var appState
    @State private var selectedSidebarItem: SidebarItem? = .chats
    @State private var showIncomingCall = false
    @State private var incomingCall: IncomingVoiceCall?

    enum SidebarItem: Hashable {
        case chats
        case team
        case memory
        case settings
    }

    var body: some View {
        NavigationSplitView {
            sidebarList
        } content: {
            switch selectedSidebarItem {
            case .chats, .none:
                BotListView()
                    .navigationTitle("Chats")
            case .team:
                TeamDashboardView()
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
                                            .font(NexusTypography.heading)
                                            .foregroundStyle(NexusColors.text0)
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
        // Global incoming call listener (iPad)
        .onChange(of: appState.incomingVoiceCall?.sessionId) { _, newValue in
            if let call = appState.incomingVoiceCall, newValue != nil {
                incomingCall = call
                appState.incomingVoiceCall = nil
                showIncomingCall = true
            }
        }
        .fullScreenCover(isPresented: $showIncomingCall) {
            if let call = incomingCall {
                RtcCallView(
                    botName: call.botName,
                    chatId: call.chatId,
                    incoming: call
                )
                .environment(appState)
                .onDisappear { incomingCall = nil }
            }
        }
    }

    private var sidebarList: some View {
        VStack(spacing: 0) {
            List(selection: $selectedSidebarItem) {
                Section {
                    NavigationLink(value: SidebarItem.chats) {
                        Label("Chats", systemImage: "bubble.left.and.bubble.right")
                    }
                } header: {
                    Text("Navigation")
                        .font(NexusTypography.label)
                        .foregroundStyle(NexusColors.text2)
                        .textCase(.uppercase)
                }
            }
            .scrollContentBackground(.hidden)

            Spacer()

            // Bottom nav buttons matching web design
            HStack(spacing: 0) {
                sidebarBottomButton(item: .team, icon: "person.3", label: "TEAM")
                sidebarBottomButton(item: .memory, icon: "book", label: "MEMORY")
                sidebarBottomButton(item: .settings, icon: "gearshape", label: "SETTINGS")
            }
            .padding(.horizontal, NexusSpacing.sm)
            .padding(.bottom, NexusSpacing.sm)
        }
        .background(sidebarBackground)
        .navigationTitle("MetaBot")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                connectionDot
            }
        }
    }

    private func sidebarBottomButton(item: SidebarItem, icon: String, label: String) -> some View {
        let isActive = selectedSidebarItem == item
        return Button {
            selectedSidebarItem = item
        } label: {
            VStack(spacing: 3) {
                Image(systemName: icon)
                    .font(.system(size: 16))
                Text(label)
                    .font(.system(size: 9, design: .monospaced))
                    .tracking(1)
            }
            .foregroundStyle(isActive ? NexusColors.accentText : NexusColors.text2)
            .frame(maxWidth: .infinity)
            .padding(.vertical, NexusSpacing.sm)
            .background(
                RoundedRectangle(cornerRadius: NexusRadius.sm)
                    .fill(isActive ? NexusColors.accentSofter : Color.clear)
            )
        }
        .buttonStyle(.plain)
    }

    /// On iOS 26+, use clear background to let Liquid Glass shine through.
    /// On earlier versions, use the opaque surface color.
    private var sidebarBackground: Color {
        if #available(iOS 26, *) {
            return Color.clear
        }
        return NexusColors.surface0
    }

    private var connectionDot: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(appState.isConnected ? NexusColors.green : NexusColors.text2)
                .frame(width: 8, height: 8)
            Text(appState.isConnected ? "Live" : "Offline")
                .font(NexusTypography.label)
                .foregroundStyle(NexusColors.text2)
        }
    }
}

// MARK: - Phone layout (TabView)

struct MobileTabView: View {
    @Environment(AppState.self) private var appState
    @State private var showIncomingCall = false
    @State private var incomingCall: IncomingVoiceCall?

    var body: some View {
        Group {
            if appState.showingChat, appState.activeSession != nil {
                fullScreenChat
            } else {
                if #available(iOS 26, *) {
                    liquidGlassTabView
                } else {
                    legacyTabView
                }
            }
        }
        // Global incoming call listener — works from any tab/screen
        .onChange(of: appState.incomingVoiceCall?.sessionId) { _, newValue in
            if let call = appState.incomingVoiceCall, newValue != nil {
                appState.incomingVoiceCall = nil
                // Don't accept if already in a call
                guard !showIncomingCall else { return }
                incomingCall = call
                showIncomingCall = true
            }
        }
        .fullScreenCover(isPresented: $showIncomingCall) {
            if let call = incomingCall {
                RtcCallView(
                    botName: call.botName ?? appState.activeBotName ?? "Voice Call",
                    chatId: call.chatId ?? appState.activeSessionId ?? "call_\(UUID().uuidString.prefix(8))",
                    incoming: call
                )
                .environment(appState)
                .onDisappear { incomingCall = nil }
            }
        }
    }

    // MARK: - Full-screen Chat

    private var fullScreenChat: some View {
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
                            .foregroundStyle(NexusColors.accent)
                        }
                    }
                    ToolbarItem(placement: .principal) {
                        if let bot = appState.activeBot {
                            HStack(spacing: 8) {
                                GradientAvatar(name: bot.name, size: 26)
                                Text(bot.name)
                                    .font(NexusTypography.heading)
                                    .foregroundStyle(NexusColors.text0)
                                Circle()
                                    .fill(appState.isConnected ? NexusColors.green : NexusColors.text2)
                                    .frame(width: 8, height: 8)
                            }
                        }
                    }
                }
        }
    }

    // MARK: - Chats Content (shared between tab layouts)

    private var chatsContent: some View {
        NavigationStack {
            BotListView()
                .navigationTitle("Chats")
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        HStack(spacing: 4) {
                            Circle()
                                .fill(appState.isConnected ? NexusColors.green : NexusColors.text2)
                                .frame(width: 8, height: 8)
                            Text(appState.isConnected ? "Live" : "Offline")
                                .font(NexusTypography.label)
                                .foregroundStyle(NexusColors.text2)
                        }
                    }
                }
        }
    }

    // MARK: - iOS 26+ Liquid Glass Tab API

    @available(iOS 26, *)
    private var liquidGlassTabView: some View {
        TabView(selection: Binding(
            get: { appState.activeTab },
            set: { appState.activeTab = $0 }
        )) {
            Tab("Chats", systemImage: "bubble.left.and.bubble.right", value: AppTab.chats) {
                chatsContent
            }
            Tab("Team", systemImage: "person.3", value: AppTab.team) {
                TeamDashboardView()
            }
            Tab("Memory", systemImage: "brain", value: AppTab.memory) {
                MemoryView()
            }
            Tab("Settings", systemImage: "gear", value: AppTab.settings) {
                SettingsView()
            }
        }
        .tint(NexusColors.accent)
    }

    // MARK: - Legacy TabView (iOS 17-25)

    private var legacyTabView: some View {
        TabView(selection: Binding(
            get: { appState.activeTab },
            set: { appState.activeTab = $0 }
        )) {
            chatsContent
                .tabItem {
                    Label("Chats", systemImage: "bubble.left.and.bubble.right")
                }
                .tag(AppTab.chats)

            TeamDashboardView()
                .tabItem {
                    Label("Team", systemImage: "person.3")
                }
                .tag(AppTab.team)

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
        .tint(NexusColors.accent)
    }
}
