import SwiftUI
import MarkdownUI

struct MessageBubble: View {
    let message: ChatMessage
    let serverURL: String
    var onFilePreview: ((FileAttachment) -> Void)?

    var body: some View {
        switch message.type {
        case .user:
            userBubble
        case .assistant:
            assistantBubble
        case .system:
            systemBubble
        }
    }

    // MARK: - User Bubble

    private var userBubble: some View {
        HStack {
            Spacer(minLength: 60)
            VStack(alignment: .trailing, spacing: 6) {
                // File attachments
                if let attachments = message.attachments, !attachments.isEmpty {
                    ForEach(attachments) { file in
                        FileCardView(file: file, serverURL: serverURL)
                            .onTapGesture { onFilePreview?(file) }
                    }
                }
                // Text
                if !message.text.isEmpty {
                    Text(message.text)
                        .font(.body)
                        .foregroundStyle(.white)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                        .background(Color.accentColor)
                        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 2)
        .contextMenu {
            if !message.text.isEmpty {
                Button {
                    UIPasteboard.general.string = message.text
                } label: {
                    Label("Copy", systemImage: "doc.on.doc")
                }
                ShareLink(item: message.text) {
                    Label("Share", systemImage: "square.and.arrow.up")
                }
            }
        }
    }

    // MARK: - Assistant Bubble

    private var assistantBubble: some View {
        VStack(alignment: .leading, spacing: 4) {
            // Status indicator
            statusHeader

            // Tool calls
            if let tools = message.state?.toolCalls, !tools.isEmpty {
                ToolCallView(toolCalls: tools)
            }

            // Pending question
            if message.state?.status == .waitingForInput, let q = message.state?.pendingQuestion {
                PendingQuestionView(question: q)
            }

            // Markdown content
            if !message.text.isEmpty {
                Markdown(message.text)
                    .markdownTheme(.metabot)
                    .textSelection(.enabled)
            }

            // Cost / duration
            if message.state?.status == .complete {
                HStack(spacing: 4) {
                    if let cost = message.state?.costUsd {
                        Text(String(format: "$%.4f", cost))
                    }
                    if message.state?.costUsd != nil && message.state?.durationMs != nil {
                        Text("·")
                    }
                    if let duration = message.state?.durationMs {
                        Text(String(format: "%.1fs", duration / 1000))
                    }
                }
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.tertiary)
                .padding(.top, 4)
            }

            // Output file attachments
            if let attachments = message.attachments, !attachments.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(attachments) { file in
                        FileCardView(file: file, serverURL: serverURL, compact: true)
                            .onTapGesture { onFilePreview?(file) }
                    }
                }
                .padding(.top, 8)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 4)
        .contextMenu {
            if !message.text.isEmpty {
                Button {
                    UIPasteboard.general.string = message.text
                } label: {
                    Label("Copy", systemImage: "doc.on.doc")
                }
                ShareLink(item: message.text) {
                    Label("Share", systemImage: "square.and.arrow.up")
                }
            }
        }
    }

    @ViewBuilder
    private var statusHeader: some View {
        HStack(spacing: 6) {
            switch message.state?.status {
            case .thinking:
                ProgressView()
                    .scaleEffect(0.7)
                    .frame(width: 16, height: 16)
                Text("Thinking...")
                    .font(.caption)
                    .foregroundStyle(.blue)
            case .running:
                ProgressView()
                    .scaleEffect(0.7)
                    .frame(width: 16, height: 16)
                Text("Running...")
                    .font(.caption)
                    .foregroundStyle(.blue)
            case .complete:
                Image(systemName: "checkmark.circle.fill")
                    .font(.caption)
                    .foregroundStyle(.green)
            case .error:
                Image(systemName: "xmark.circle.fill")
                    .font(.caption)
                    .foregroundStyle(.red)
                if let error = message.state?.errorMessage {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .lineLimit(1)
                }
            case .waitingForInput:
                Image(systemName: "questionmark.circle.fill")
                    .font(.caption)
                    .foregroundStyle(.orange)
                Text("Waiting for input...")
                    .font(.caption)
                    .foregroundStyle(.orange)
            case .none:
                EmptyView()
            }
        }
    }

    // MARK: - System Bubble

    private var systemBubble: some View {
        HStack {
            Spacer()
            Text(message.text)
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(.quaternary)
                .clipShape(Capsule())
            Spacer()
        }
        .padding(.vertical, 4)
    }
}

// MARK: - File Card

struct FileCardView: View {
    let file: FileAttachment
    let serverURL: String
    var compact: Bool = false

    var body: some View {
        HStack(spacing: 10) {
            // Icon
            ZStack {
                RoundedRectangle(cornerRadius: 6)
                    .fill(Color.accentColor.opacity(0.15))
                    .frame(width: compact ? 32 : 36, height: compact ? 32 : 36)
                Text(file.fileExtension.uppercased().prefix(4))
                    .font(.system(size: 9, weight: .bold, design: .monospaced))
                    .foregroundStyle(Color.accentColor)
            }

            VStack(alignment: .leading, spacing: 2) {
                Text(file.name)
                    .font(.system(size: 13, weight: .medium))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(file.formattedSize)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }

            Spacer()

            if let url = URL(string: "\(serverURL)\(file.url)") {
                Link(destination: url) {
                    Image(systemName: "arrow.down.circle")
                        .font(.body)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(10)
        .background(.quaternary)
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}

// MARK: - Pending Question

struct PendingQuestionView: View {
    let question: PendingQuestion

    @Environment(AppState.self) private var appState

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let text = question.question {
                Text(text)
                    .font(.subheadline)
                    .foregroundStyle(.primary)
            }

            if let options = question.options {
                ForEach(options) { option in
                    Button {
                        if let toolUseId = question.toolUseId {
                            appState.answerQuestion(toolUseId: toolUseId, answer: option.label)
                        }
                    } label: {
                        Text(option.label)
                            .font(.subheadline)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                            .background(Color.accentColor.opacity(0.1))
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(12)
        .background(.orange.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }
}

// MARK: - Markdown Theme

extension MarkdownUI.Theme {
    static let metabot = Theme()
        .text {
            ForegroundColor(.primary)
            FontSize(15)
        }
        .code {
            FontFamilyVariant(.monospaced)
            FontSize(13)
            ForegroundColor(.secondary)
        }
        .codeBlock { configuration in
            ScrollView(.horizontal, showsIndicators: false) {
                configuration.label
                    .markdownTextStyle {
                        FontFamilyVariant(.monospaced)
                        FontSize(13)
                    }
                    .padding(12)
            }
            .background(Color(red: 0.95, green: 0.95, blue: 0.97)
                .opacity(0.5))
            .background(.quaternary)
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
        .link {
            ForegroundColor(.accentColor)
        }
}
