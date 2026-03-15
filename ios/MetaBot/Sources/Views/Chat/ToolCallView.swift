import SwiftUI

struct ToolCallView: View {
    let toolCalls: [ToolCallInfo]
    @State private var isExpanded = false

    private var runningCount: Int { toolCalls.filter { $0.status == "running" }.count }
    private var doneCount: Int { toolCalls.filter { $0.status == "done" }.count }

    var body: some View {
        if !toolCalls.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                // Header
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        isExpanded.toggle()
                    }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "chevron.right")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .rotationEffect(.degrees(isExpanded ? 90 : 0))

                        if runningCount > 0 {
                            ProgressView()
                                .scaleEffect(0.6)
                                .frame(width: 14, height: 14)
                            Text("Running \(toolCalls.last?.name ?? "tool")...")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        } else {
                            Image(systemName: "checkmark.circle.fill")
                                .font(.caption)
                                .foregroundStyle(.green)
                            Text("\(doneCount) tool(s) used")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }

                        Spacer()
                    }
                    .padding(.vertical, 6)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                // Expanded list
                if isExpanded {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(Array(toolCalls.enumerated()), id: \.offset) { _, call in
                            HStack(spacing: 6) {
                                if call.status == "running" {
                                    ProgressView()
                                        .scaleEffect(0.5)
                                        .frame(width: 12, height: 12)
                                } else {
                                    Image(systemName: "checkmark.circle.fill")
                                        .font(.system(size: 10))
                                        .foregroundStyle(.green)
                                }

                                Text(call.name)
                                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                                    .foregroundStyle(.primary)

                                if let detail = call.detail {
                                    Text(detail)
                                        .font(.system(size: 10, design: .monospaced))
                                        .foregroundStyle(.tertiary)
                                        .lineLimit(1)
                                }
                            }
                        }
                    }
                    .padding(.leading, 20)
                    .padding(.bottom, 4)
                }
            }
        }
    }
}
