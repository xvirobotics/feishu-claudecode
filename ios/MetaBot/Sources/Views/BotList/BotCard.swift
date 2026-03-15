import SwiftUI

struct BotCard: View {
    let bot: BotInfo
    let latestSession: ChatSession?
    let isActive: Bool
    let onTap: () -> Void
    let onNewSession: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 12) {
                // Avatar
                ZStack(alignment: .bottomTrailing) {
                    GradientAvatar(name: bot.name, size: 48)
                    Circle()
                        .fill(Color.green)
                        .frame(width: 12, height: 12)
                        .overlay(Circle().stroke(.background, lineWidth: 2))
                }

                // Info
                VStack(alignment: .leading, spacing: 3) {
                    HStack {
                        Text(bot.name)
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(.primary)

                        if let platform = bot.platform {
                            Text(platform)
                                .font(.system(size: 10, weight: .medium))
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(.quaternary)
                                .clipShape(Capsule())
                        }

                        Spacer()

                        if let session = latestSession {
                            Text(relativeTime(session.lastUpdatedDate))
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                    }

                    // Preview
                    if let session = latestSession, let last = session.lastMessage {
                        HStack(spacing: 4) {
                            statusIndicator(last)
                            Text(previewText(last))
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    } else {
                        Text("Start a conversation")
                            .font(.subheadline)
                            .foregroundStyle(.tertiary)
                    }
                }

                // New session button
                Button(action: onNewSession) {
                    Image(systemName: "plus.circle")
                        .font(.title3)
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
            }
            .padding(.vertical, 10)
            .padding(.horizontal, 16)
            .background(isActive ? Color.accentColor.opacity(0.08) : .clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private func statusIndicator(_ msg: ChatMessage) -> some View {
        if msg.type == .assistant {
            switch msg.state?.status {
            case .thinking:
                ProgressView()
                    .scaleEffect(0.6)
                    .frame(width: 14, height: 14)
            case .running:
                ProgressView()
                    .scaleEffect(0.6)
                    .frame(width: 14, height: 14)
            case .error:
                Image(systemName: "exclamationmark.circle.fill")
                    .font(.caption2)
                    .foregroundStyle(.red)
            default:
                EmptyView()
            }
        }
    }

    private func previewText(_ msg: ChatMessage) -> String {
        if msg.type == .assistant {
            switch msg.state?.status {
            case .thinking: return "Thinking..."
            case .running: return "Running..."
            case .error: return msg.state?.errorMessage ?? "Error"
            default: break
            }
        }
        let text = msg.text.replacingOccurrences(of: "\n", with: " ")
        return String(text.prefix(60))
    }

    private func relativeTime(_ date: Date) -> String {
        let seconds = Int(-date.timeIntervalSinceNow)
        if seconds < 60 { return "now" }
        if seconds < 3600 { return "\(seconds / 60)m" }
        if seconds < 86400 { return "\(seconds / 3600)h" }
        return "\(seconds / 86400)d"
    }
}
