import SwiftUI

struct InputBar: View {
    @Environment(AppState.self) private var appState
    @State private var text = ""
    @FocusState private var isFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            Divider()
            HStack(alignment: .bottom, spacing: 8) {
                // Text field
                TextField("Ask anything...", text: $text, axis: .vertical)
                    .lineLimit(1...6)
                    .font(.body)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(.quaternary)
                    .clipShape(RoundedRectangle(cornerRadius: 20))
                    .focused($isFocused)
                    .submitLabel(.send)
                    .onSubmit { send() }

                // Send / Stop button
                if appState.isRunning {
                    Button {
                        appState.stopTask()
                    } label: {
                        Image(systemName: "stop.fill")
                            .font(.system(size: 14))
                            .foregroundStyle(.white)
                            .frame(width: 36, height: 36)
                            .background(.red)
                            .clipShape(Circle())
                    }
                } else {
                    Button {
                        send()
                    } label: {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(.white)
                            .frame(width: 36, height: 36)
                            .background(
                                text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                ? Color.gray
                                : Color.accentColor
                            )
                            .clipShape(Circle())
                    }
                    .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !appState.isConnected)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .padding(.bottom, 4)
        }
        .background(.bar)
    }

    private func send() {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        appState.sendMessage(text: trimmed)
        text = ""
    }
}
