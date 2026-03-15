import SwiftUI

struct ChatView: View {
    @Environment(AppState.self) private var appState
    @State private var previewFile: FileAttachment?
    @State private var showPhoneCall = false

    var body: some View {
        VStack(spacing: 0) {
            if let session = appState.activeSession, !session.messages.isEmpty {
                messageList(session.messages)
            } else {
                EmptyStateView { hint in
                    appState.sendMessage(text: hint)
                }
            }

            InputBar()
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showPhoneCall = true
                } label: {
                    Image(systemName: "phone.fill")
                        .font(.system(size: 14))
                        .foregroundStyle(Color.accentColor)
                }
            }
        }
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
    }

    private func messageList(_ messages: [ChatMessage]) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(messages) { msg in
                        MessageBubble(
                            message: msg,
                            serverURL: appState.serverURL,
                            onFilePreview: { file in
                                previewFile = file
                            }
                        )
                        .id(msg.id)
                    }
                }
                .padding(.vertical, 8)
            }
            .onChange(of: messages.count) { _, _ in
                scrollToBottom(proxy: proxy, messages: messages)
            }
            .onChange(of: messages.last?.text) { _, _ in
                scrollToBottom(proxy: proxy, messages: messages)
            }
            .onAppear {
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
