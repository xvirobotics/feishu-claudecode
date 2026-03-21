import SwiftUI

struct ChatView: View {
    @Environment(AppState.self) private var appState
    @State private var previewFile: FileAttachment?
    @State private var showPhoneCall = false
    @State private var showRtcCall = false

    // Session header dialogs
    @State private var showRenameDialog = false
    @State private var showClearConfirm = false
    @State private var showDeleteConfirm = false
    @State private var renameText = ""

    // Task 5a: Message appear animation
    @State private var seenMessageIds: Set<String> = []

    // Task 5b: Scroll-to-bottom FAB
    @State private var showScrollToBottom = false

    // Task 5c & 5d: Track previous status for haptic feedback
    @State private var lastObservedStatus: MessageStatus?

    var body: some View {
        VStack(spacing: 0) {
            if let session = appState.activeSession, !session.messages.isEmpty {
                messageList(session.messages)
            } else {
                EmptyStateView(botName: appState.activeBotName)
                    .frame(maxHeight: .infinity)
            }

            InputBar()
                .frame(maxWidth: 740)
                .frame(maxWidth: .infinity)
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 1) {
                    Text(appState.activeSession?.displayTitle ?? "Chat")
                        .font(NexusTypography.body)
                        .fontWeight(.semibold)
                        .foregroundStyle(NexusColors.text0)
                        .lineLimit(1)
                    if let bot = appState.activeBotName {
                        Text(bot)
                            .font(NexusTypography.jetBrainsMono(size: 10))
                            .foregroundStyle(NexusColors.text2)
                    }
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                HStack(spacing: 12) {
                    Button {
                        if appState.rtcAvailable {
                            showRtcCall = true
                        } else {
                            showPhoneCall = true
                        }
                    } label: {
                        Image(systemName: "phone.fill")
                            .font(.system(size: 14))
                            .foregroundStyle(Color.accentColor)
                    }
                    .accessibilityLabel("Call")
                    Menu {
                        Button {
                            showRenameDialog = true
                        } label: {
                            Label("Rename", systemImage: "pencil")
                        }

                        Button {
                            _ = appState.createSession(botName: appState.activeBotName ?? "")
                        } label: {
                            Label("New Chat", systemImage: "plus.bubble")
                        }

                        Divider()

                        Button(role: .destructive) {
                            showClearConfirm = true
                        } label: {
                            Label("Clear Messages", systemImage: "trash")
                        }

                        Button(role: .destructive) {
                            showDeleteConfirm = true
                        } label: {
                            Label("Delete Session", systemImage: "xmark.circle")
                        }
                    } label: {
                        Image(systemName: "ellipsis")
                            .font(.system(size: 16))
                            .foregroundStyle(NexusColors.text1)
                            .frame(width: 32, height: 32)
                    }
                    .accessibilityLabel("Options")
                }
            }
        }
        // Task 5c: Disconnection banner
        .overlay(alignment: .top) {
            if !appState.isConnected {
                HStack(spacing: NexusSpacing.sm) {
                    NexusThinkingDots()
                    Text("Reconnecting...")
                        .font(NexusTypography.caption)
                        .foregroundStyle(NexusColors.red)
                }
                .padding(.horizontal, NexusSpacing.lg)
                .padding(.vertical, NexusSpacing.sm)
                .background(NexusColors.red.opacity(0.12))
                .clipShape(Capsule())
                .nexusGlassBorder(radius: NexusRadius.full)
                .padding(.top, 8)
                .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(NexusMotion.base, value: appState.isConnected)
        .sheet(item: $previewFile) { file in
            FilePreviewSheet(file: file, serverURL: appState.serverURL)
        }
        .fullScreenCover(isPresented: $showPhoneCall) {
            if let botName = appState.activeBotName {
                let chatId = appState.activeSessionId ?? "call_\(UUID().uuidString.prefix(8))"
                PhoneCallView(botName: botName, chatId: chatId)
                    .environment(appState)
            }
        }
        .fullScreenCover(isPresented: $showRtcCall) {
            if let botName = appState.activeBotName {
                let chatId = appState.activeSessionId ?? "call_\(UUID().uuidString.prefix(8))"
                RtcCallView(botName: botName, chatId: chatId, incoming: nil)
                    .environment(appState)
            }
        }
        // Task 5d: Haptics on task complete / error
        .onChange(of: appState.activeSession?.messages.last?.state?.status) { oldStatus, newStatus in
            if newStatus == .complete && oldStatus != .complete {
                Haptics.success()
            } else if newStatus == .error && oldStatus != .error {
                Haptics.error()
            }
        }
        // Session header dialogs
        .onChange(of: showRenameDialog) { _, showing in
            if showing {
                renameText = appState.activeSession?.displayTitle ?? ""
            }
        }
        .alert("Rename Chat", isPresented: $showRenameDialog) {
            TextField("Session name", text: $renameText)
            Button("Rename") {
                if !renameText.isEmpty {
                    appState.renameSession(id: appState.activeSessionId ?? "", title: renameText)
                }
            }
            Button("Cancel", role: .cancel) { }
        } message: { }
        .confirmationDialog("Clear all messages?", isPresented: $showClearConfirm, titleVisibility: .visible) {
            Button("Clear Messages", role: .destructive) {
                if let id = appState.activeSessionId {
                    appState.clearSessionMessages(id: id)
                }
            }
            Button("Cancel", role: .cancel) { }
        }
        .confirmationDialog("Delete this session?", isPresented: $showDeleteConfirm, titleVisibility: .visible) {
            Button("Delete Session", role: .destructive) {
                if let id = appState.activeSessionId {
                    appState.deleteSession(id: id)
                }
            }
            Button("Cancel", role: .cancel) { }
        }
    }

    private func messageList(_ messages: [ChatMessage]) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(Array(messages.enumerated()), id: \.element.id) { index, msg in
                        let prevType = index > 0 ? messages[index - 1].type : nil
                        let spacingTop: CGFloat = prevType == msg.type ? 4 : 12

                        MessageBubble(
                            message: msg,
                            serverURL: appState.serverURL,
                            botName: appState.activeBotName,
                            onFilePreview: { file in
                                previewFile = file
                            },
                            onDelete: {
                                if let session = appState.activeSession {
                                    appState.deleteMessage(sessionId: session.id, messageId: msg.id)
                                }
                            },
                            onRetry: {
                                if let prompt = msg.state?.userPrompt, !prompt.isEmpty {
                                    appState.sendMessage(text: prompt)
                                }
                            }
                        )
                        .padding(.top, index == 0 ? 0 : spacingTop)
                        .id(msg.id)
                        // D5: Fade-up appear animation (easeOut 0.28s, 8pt offset, staggered)
                        .opacity(seenMessageIds.contains(msg.id) ? 1 : 0)
                        .offset(y: seenMessageIds.contains(msg.id) ? 0 : 8)
                        .onAppear {
                            if !seenMessageIds.contains(msg.id) {
                                let delay = min(Double(index) * 0.05, 0.3)
                                withAnimation(.easeOut(duration: 0.28).delay(delay)) {
                                    seenMessageIds.insert(msg.id)
                                }
                            }
                        }
                    }

                    // Task 5b: Sentinel view for scroll-to-bottom detection
                    GeometryReader { geo in
                        Color.clear.preference(
                            key: BottomVisibilityKey.self,
                            value: geo.frame(in: .named("chatScrollView")).maxY < 0
                        )
                    }
                    .frame(height: 1)
                    .id("bottom")
                }
                .padding(.top, 36)
                .padding(.horizontal, 28)
                .padding(.bottom, 24)
                .frame(maxWidth: 740)
                .frame(maxWidth: .infinity)
            }
            .scrollIndicators(.hidden)
            .coordinateSpace(name: "chatScrollView")
            .onPreferenceChange(BottomVisibilityKey.self) { isHidden in
                withAnimation(NexusMotion.base) { showScrollToBottom = isHidden }
            }
            // Task 5b: Scroll-to-bottom FAB overlay
            .overlay(alignment: .bottomTrailing) {
                if showScrollToBottom {
                    Button {
                        withAnimation(NexusMotion.base) {
                            proxy.scrollTo("bottom", anchor: .bottom)
                        }
                    } label: {
                        ZStack {
                            Circle()
                                .fill(NexusColors.surface2)
                                .frame(width: 40, height: 40)
                                .nexusGlassBorder(radius: 20)
                                .nexusShadowMd()
                            Image(systemName: "chevron.down")
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(NexusColors.text1)
                        }
                    }
                    .transition(.scale.combined(with: .opacity))
                    .padding(.trailing, 16)
                    .padding(.bottom, 8)
                }
            }
            .onChange(of: messages.count) { _, _ in
                scrollToBottom(proxy: proxy, messages: messages)
            }
            .onChange(of: messages.last?.text) { _, _ in
                scrollToBottom(proxy: proxy, messages: messages)
            }
            .onAppear {
                // Pre-seed existing messages so they don't animate on first load
                for msg in messages {
                    seenMessageIds.insert(msg.id)
                }
                scrollToBottom(proxy: proxy, messages: messages, animated: false)
            }
        }
    }

    private func scrollToBottom(proxy: ScrollViewProxy, messages: [ChatMessage], animated: Bool = true) {
        guard let lastId = messages.last?.id else { return }
        if animated {
            withAnimation(.easeOut(duration: 0.2)) {
                proxy.scrollTo(lastId, anchor: .bottom)
            }
        } else {
            proxy.scrollTo(lastId, anchor: .bottom)
        }
    }
}

// MARK: - Preference Key for scroll-to-bottom detection

private struct BottomVisibilityKey: PreferenceKey {
    static var defaultValue = false
    static func reduce(value: inout Bool, nextValue: () -> Bool) { value = nextValue() }
}
