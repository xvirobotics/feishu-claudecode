import SwiftUI

struct ChatView: View {
    @Environment(AppState.self) private var appState

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
    }

    private func messageList(_ messages: [ChatMessage]) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(messages) { msg in
                        MessageBubble(message: msg, serverURL: appState.serverURL)
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
