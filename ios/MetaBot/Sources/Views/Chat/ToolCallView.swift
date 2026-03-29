import SwiftUI

struct ToolCallView: View {
    let toolCalls: [ToolCallInfo]
    @State private var isExpanded = false

    private var runningCount: Int { toolCalls.filter { $0.status == "running" }.count }
    private var doneCount: Int { toolCalls.filter { $0.status == "done" }.count }

    var body: some View {
        if !toolCalls.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                // Header — plain text+icon chip, no background container
                Button {
                    Haptics.selection()
                    withAnimation(NexusMotion.base) {
                        isExpanded.toggle()
                    }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 10, weight: .medium))
                            .foregroundStyle(NexusColors.text2)
                            .rotationEffect(.degrees(isExpanded ? 90 : 0))
                            .animation(NexusMotion.base, value: isExpanded)

                        if runningCount > 0 {
                            ProgressView()
                                .tint(NexusColors.blue)
                                .scaleEffect(0.5)
                                .frame(width: 14, height: 14)
                            Text("Running \(toolCalls.last?.name ?? "tool")...")
                                .font(NexusTypography.jetBrainsMono(size: 11))
                                .foregroundStyle(NexusColors.text2)
                                .tracking(0.3)
                        } else {
                            Text("\(doneCount) tool\(doneCount == 1 ? "" : "s") used")
                                .font(NexusTypography.jetBrainsMono(size: 11))
                                .foregroundStyle(NexusColors.text2)
                                .tracking(0.3)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                // Expanded list with left border only
                if isExpanded {
                    HStack(alignment: .top, spacing: 0) {
                        // Left border line
                        Rectangle()
                            .fill(NexusColors.glassBorder)
                            .frame(width: 1)

                        // Tool rows
                        VStack(alignment: .leading, spacing: 1) {
                            ForEach(Array(toolCalls.enumerated()), id: \.offset) { _, call in
                                toolRow(call)
                            }
                        }
                        .padding(.vertical, 6)
                    }
                    .padding(.leading, 12)
                    .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
        }
    }

    @ViewBuilder
    private func toolRow(_ call: ToolCallInfo) -> some View {
        HStack(spacing: 8) {
            // Status icon
            if call.status == "running" {
                ProgressView()
                    .tint(NexusColors.blue)
                    .scaleEffect(0.6)
                    .frame(width: 14, height: 14)
            } else {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(NexusColors.green)
                    .font(.system(size: 12))
            }

            // Tool name
            Text(call.name)
                .font(NexusTypography.jetBrainsMono(size: 12))
                .foregroundStyle(NexusColors.text1)

            // Detail
            if let detail = call.detail {
                Text(detail)
                    .font(NexusTypography.jetBrainsMono(size: 11))
                    .foregroundStyle(NexusColors.text2)
                    .lineLimit(1)
            }

            Spacer()
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
    }
}
