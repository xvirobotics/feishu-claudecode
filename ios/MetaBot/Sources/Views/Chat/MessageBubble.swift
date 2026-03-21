import SwiftUI
import MarkdownUI

struct MessageBubble: View {
    let message: ChatMessage
    let serverURL: String
    var botName: String?
    var isGroupChat: Bool = false
    var onFilePreview: ((FileAttachment) -> Void)?
    var onDelete: (() -> Void)?
    var onRetry: (() -> Void)?

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
            Spacer(minLength: 48)
            VStack(alignment: .trailing, spacing: 6) {
                // File attachments above text
                if let attachments = message.attachments, !attachments.isEmpty {
                    ForEach(attachments) { file in
                        FileCardView(file: file, serverURL: serverURL)
                            .onTapGesture { onFilePreview?(file) }
                    }
                }
                // Text
                if !message.text.isEmpty {
                    Text(message.text)
                        .font(NexusTypography.body)
                        .foregroundStyle(Color(UIColor { traits in
                            traits.userInterfaceStyle == .dark ? .white : UIColor(red: 0.1, green: 0.1, blue: 0.12, alpha: 1)
                        }))
                        .lineSpacing(4)
                        .tracking(-0.1)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, 18)
                        .padding(.vertical, 11)
                        .background(NexusColors.userBubble)
                        .clipShape(
                            UnevenRoundedRectangle(
                                topLeadingRadius: 16,
                                bottomLeadingRadius: 16,
                                bottomTrailingRadius: 4,
                                topTrailingRadius: 16
                            )
                        )
                }
            }
        }
        .padding(.vertical, 2)
        .contextMenu {
            if !message.text.isEmpty {
                Button {
                    UIPasteboard.general.string = message.text
                } label: {
                    Label("Copy Text", systemImage: "doc.on.doc")
                }
                ShareLink(item: message.text) {
                    Label("Share", systemImage: "square.and.arrow.up")
                }
            }
            Button(role: .destructive) {
                onDelete?()
            } label: {
                Label("Delete", systemImage: "trash")
            }
        }
    }

    // MARK: - Assistant Bubble (full-width, no box)

    private var assistantBubble: some View {
        HStack(alignment: .top, spacing: 8) {
            // Bot avatar
            GradientAvatar(name: botName ?? "AI", size: 24)
                .padding(.top, 2)

            VStack(alignment: .leading, spacing: 0) {
                // Bot name label (group chats only)
                if isGroupChat, let name = botName, !name.isEmpty {
                    Text("@\(name)")
                        .font(NexusTypography.jetBrainsMono(size: 11))
                        .fontWeight(.semibold)
                        .foregroundStyle(NexusColors.accentText)
                        .padding(.bottom, 6)
                }

                // Status header (only for non-complete states)
                statusHeader

                // Tool calls
                if let tools = message.state?.toolCalls, !tools.isEmpty {
                    ToolCallView(toolCalls: tools)
                        .padding(.top, 4)
                }

                // Error block
                if message.state?.status == .error, let errorMsg = message.state?.errorMessage {
                    errorBlock(errorMsg)

                    // Inline retry button
                    if let prompt = message.state?.userPrompt, !prompt.isEmpty {
                        Button {
                            onRetry?()
                        } label: {
                            HStack(spacing: 6) {
                                Image(systemName: "arrow.clockwise")
                                    .font(.system(size: NexusFontScale.scaled(12)))
                                Text("Retry")
                                    .font(NexusTypography.jetBrainsMono(size: NexusFontScale.scaled(12)))
                            }
                            .foregroundStyle(NexusColors.text2)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 6)
                            .background(NexusColors.surface2)
                            .clipShape(Capsule())
                            .overlay(Capsule().stroke(NexusColors.glassBorder))
                        }
                        .buttonStyle(.plain)
                        .padding(.top, 8)
                    }
                }

                // Pending question
                if message.state?.status == .waitingForInput, let q = message.state?.pendingQuestion {
                    PendingQuestionView(question: q)
                        .padding(.top, 8)
                }

                // Markdown content
                if !message.text.isEmpty {
                    Markdown(message.text)
                        .markdownTheme(.nexus)
                        .textSelection(.enabled)
                        .padding(.top, 4)
                }

                // Stats footer
                if message.state?.status == .complete {
                    statsFooter
                        .padding(.top, 6)
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
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 4)
        .contextMenu {
            Button {
                UIPasteboard.general.string = message.state?.responseText ?? message.text
            } label: {
                Label("Copy Text", systemImage: "doc.on.doc")
            }
            if message.state?.status == .error, let prompt = message.state?.userPrompt, !prompt.isEmpty {
                Button {
                    onRetry?()
                } label: {
                    Label("Retry", systemImage: "arrow.clockwise")
                }
            }
            Button(role: .destructive) {
                onDelete?()
            } label: {
                Label("Delete", systemImage: "trash")
            }
        }
    }

    // MARK: - Status Header

    @ViewBuilder
    private var statusHeader: some View {
        switch message.state?.status {
        case .thinking:
            HStack(spacing: 6) {
                NexusThinkingDots()
                    .frame(width: 24, height: 16)
                Text("Thinking...")
                    .font(NexusTypography.caption)
                    .foregroundStyle(NexusColors.text2)
            }
        case .running:
            HStack(spacing: 6) {
                NexusThinkingDots()
                    .frame(width: 24, height: 16)
                Text("Running...")
                    .font(NexusTypography.caption)
                    .foregroundStyle(NexusColors.text2)
            }
        case .waitingForInput:
            HStack(spacing: 6) {
                Image(systemName: "questionmark.circle.fill")
                    .font(.caption)
                    .foregroundStyle(NexusColors.amber)
                Text("Waiting for input...")
                    .font(NexusTypography.caption)
                    .foregroundStyle(NexusColors.amber)
            }
        case .error:
            HStack(spacing: 6) {
                Image(systemName: "xmark.circle.fill")
                    .font(.caption)
                    .foregroundStyle(NexusColors.red)
                Text("ERROR")
                    .font(NexusTypography.caption)
                    .foregroundStyle(NexusColors.red)
            }
        case .complete, .none:
            EmptyView()
        }
    }

    // MARK: - Error Block

    private func errorBlock(_ errorMessage: String) -> some View {
        HStack(spacing: 0) {
            Rectangle()
                .fill(NexusColors.red)
                .frame(width: 3)
            Text(errorMessage)
                .font(NexusTypography.codeBody)
                .foregroundStyle(NexusColors.red)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(NexusColors.redSoft)
        }
        .clipShape(
            UnevenRoundedRectangle(
                topLeadingRadius: 0,
                bottomLeadingRadius: 0,
                bottomTrailingRadius: NexusRadius.md,
                topTrailingRadius: NexusRadius.md
            )
        )
        .padding(.top, 8)
    }

    // MARK: - Stats Footer

    private var statsFooter: some View {
        HStack(spacing: 4) {
            if let cost = message.state?.costUsd {
                Text(String(format: "$%.4f", cost))
            }
            if message.state?.costUsd != nil && message.state?.durationMs != nil {
                Text("\u{00B7}")
            }
            if let duration = message.state?.durationMs {
                Text(String(format: "%.1fs", duration / 1000))
            }
        }
        .font(NexusTypography.jetBrainsMono(size: 11))
        .foregroundStyle(NexusColors.text3)
    }

    // MARK: - System Bubble

    private var systemBubble: some View {
        Group {
            if message.isPlanMode == true {
                PlanModeCard(text: message.text)
            } else {
                HStack {
                    Spacer()
                    Text(message.text)
                        .font(.system(size: NexusFontScale.scaled(12)))
                        .foregroundStyle(NexusColors.text2)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 6)
                        .background(NexusColors.surface1)
                        .clipShape(Capsule())
                        .overlay(Capsule().stroke(NexusColors.glassBorder, lineWidth: 1))
                    Spacer()
                }
                .padding(.vertical, 4)
            }
        }
    }
}
