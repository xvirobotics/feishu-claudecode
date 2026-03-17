import SwiftUI

struct BotCard: View {
    let bot: BotInfo
    let sessions: [ChatSession]
    let activeSessionId: String?
    let latestSession: ChatSession?
    let isActive: Bool
    let onSelect: () -> Void
    let onNewSession: () -> Void
    let onSelectSession: (String) -> Void
    let onDeleteSession: (String) -> Void

    @State private var isPressed = false
    @State private var isExpanded = false
    @State private var sessionToDelete: String? = nil

    var body: some View {
        VStack(spacing: 0) {
            // Main bot row
            HStack(alignment: .top, spacing: 12) {
                // Avatar with status dot
                avatarWithDot

                // Bot info
                VStack(alignment: .leading, spacing: 3) {
                    // Name + relative time
                    HStack {
                        Text(bot.name)
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(NexusColors.text0)
                            .lineLimit(1)
                        Spacer()
                        if let session = latestSession {
                            Text(relativeTime(session.lastUpdatedDate))
                                .font(NexusTypography.jetBrainsMono(size: 11))
                                .foregroundStyle(NexusColors.text2)
                                .monospacedDigit()
                        }
                    }

                    // Platform badge + new session button
                    HStack(spacing: 4) {
                        if let platform = bot.platform {
                            Text(platform.capitalized)
                                .font(.system(size: 8, weight: .bold))
                                .foregroundStyle(NexusColors.accentText)
                                .padding(.horizontal, 5)
                                .padding(.vertical, 1)
                                .background(NexusColors.accentSofter)
                                .clipShape(RoundedRectangle(cornerRadius: 3))
                        }
                        Spacer()
                        Button(action: onNewSession) {
                            Image(systemName: "plus")
                                .font(.system(size: 12))
                                .foregroundStyle(NexusColors.text2)
                                .frame(width: 28, height: 28)
                        }
                        .opacity(0.5)
                        .buttonStyle(.plain)
                    }

                    // Preview content
                    previewContent
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(isActive ? NexusColors.surfaceHover : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: NexusRadius.lg))
            .contentShape(Rectangle())
            .onTapGesture(perform: onSelect)
            .scaleEffect(isPressed ? 0.99 : 1.0)
            .animation(NexusMotion.fast, value: isPressed)

            // Expand toggle for 2+ sessions
            if sessions.count >= 2 {
                Button {
                    withAnimation(NexusMotion.base) { isExpanded.toggle() }
                    Haptics.selection()
                } label: {
                    HStack(spacing: 6) {
                        Rectangle()
                            .fill(NexusColors.glassBorder)
                            .frame(width: 1, height: 12)
                        Text("\(sessions.count) chats")
                            .font(NexusTypography.jetBrainsMono(size: 11))
                            .foregroundStyle(NexusColors.text2)
                        Image(systemName: "chevron.right")
                            .font(.system(size: 9, weight: .medium))
                            .foregroundStyle(NexusColors.text2)
                            .rotationEffect(.degrees(isExpanded ? 90 : 0))
                            .animation(NexusMotion.base, value: isExpanded)
                    }
                    .padding(.leading, 68)
                    .padding(.vertical, 4)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.plain)
            }

            // Session list (expanded)
            if isExpanded {
                VStack(spacing: 0) {
                    ForEach(sessions) { session in
                        sessionRow(session)
                    }
                }
                .padding(.leading, 68)
                .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .onLongPressGesture(minimumDuration: .infinity, pressing: { pressing in
            isPressed = pressing
        }, perform: {})
    }

    // MARK: - Session Row

    private func sessionRow(_ session: ChatSession) -> some View {
        let isActiveSession = session.id == activeSessionId
        return HStack(spacing: 8) {
            Rectangle()
                .fill(NexusColors.text3)
                .frame(width: 12, height: 1)

            Text(session.displayTitle)
                .font(.system(size: 12))
                .foregroundStyle(isActiveSession ? NexusColors.text0 : NexusColors.text1)
                .fontWeight(isActiveSession ? .medium : .regular)
                .lineLimit(1)

            Spacer()

            Text(relativeTime(session.lastUpdatedDate))
                .font(NexusTypography.jetBrainsMono(size: 10))
                .foregroundStyle(NexusColors.text3)

            Button {
                sessionToDelete = session.id
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .medium))
                    .foregroundStyle(NexusColors.text3)
                    .frame(width: 18, height: 18)
            }
            .buttonStyle(.plain)
        }
        .padding(.vertical, 5)
        .padding(.trailing, 12)
        .background(isActiveSession ? NexusColors.surfaceHover : Color.clear)
        .clipShape(RoundedRectangle(cornerRadius: NexusRadius.sm))
        .contentShape(Rectangle())
        .onTapGesture { onSelectSession(session.id) }
        .confirmationDialog("Delete this session?", isPresented: Binding(
            get: { sessionToDelete == session.id },
            set: { if !$0 { sessionToDelete = nil } }
        ), titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                onDeleteSession(session.id)
                sessionToDelete = nil
            }
            Button("Cancel", role: .cancel) { sessionToDelete = nil }
        }
    }

    // MARK: - Avatar with status dot

    private var avatarWithDot: some View {
        ZStack(alignment: .bottomTrailing) {
            GradientAvatar(name: bot.name, size: 44)
            Circle()
                .fill(NexusColors.green)
                .frame(width: 10, height: 10)
                .overlay(Circle().stroke(NexusColors.surface0, lineWidth: 2))
        }
    }

    // MARK: - Preview content

    @ViewBuilder
    private var previewContent: some View {
        if let session = latestSession, let last = session.lastMessage {
            if last.type == .assistant {
                switch last.state?.status {
                case .thinking:
                    NexusThinkingDots()
                        .frame(height: 14)
                case .running:
                    HStack(spacing: 4) {
                        ProgressView()
                            .scaleEffect(0.6)
                            .tint(.blue)
                        Text("Running...")
                            .font(.system(size: 12.5))
                            .foregroundStyle(NexusColors.text2)
                            .lineLimit(1)
                    }
                case .error:
                    Text(last.state?.errorMessage ?? "Error")
                        .font(.system(size: 12.5))
                        .foregroundStyle(NexusColors.red)
                        .lineLimit(1)
                default:
                    snippetText(last)
                }
            } else {
                snippetText(last)
            }
        } else {
            Text("Start a conversation")
                .font(.system(size: 12.5))
                .foregroundStyle(NexusColors.text2)
                .lineLimit(1)
        }
    }

    private func snippetText(_ msg: ChatMessage) -> some View {
        let text = msg.text.replacingOccurrences(of: "\n", with: " ")
        return Text(String(text.prefix(60)))
            .font(.system(size: 12.5))
            .foregroundStyle(NexusColors.text2)
            .lineLimit(1)
    }

    // MARK: - Relative time

    private func relativeTime(_ date: Date) -> String {
        let seconds = Int(-date.timeIntervalSinceNow)
        if seconds < 60 { return "now" }
        if seconds < 3600 { return "\(seconds / 60)m" }
        if seconds < 86400 { return "\(seconds / 3600)h" }
        return "\(seconds / 86400)d"
    }
}
