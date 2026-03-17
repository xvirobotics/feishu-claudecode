import SwiftUI

struct PendingQuestionView: View {
    let question: PendingQuestion

    @Environment(AppState.self) private var appState

    var body: some View {
        HStack(spacing: 0) {
            // Left accent border
            Rectangle()
                .fill(NexusColors.accent)
                .frame(width: 3)

            VStack(alignment: .leading, spacing: 12) {
                // QUESTION header
                Text("QUESTION")
                    .font(NexusTypography.jetBrainsMono(size: 10))
                    .foregroundStyle(NexusColors.accentText)
                    .tracking(1.2)

                // Question text
                if let text = question.question {
                    Text(text)
                        .font(NexusTypography.body)
                        .foregroundStyle(NexusColors.text0)
                }

                // Option buttons
                if let options = question.options {
                    FlowLayoutView(spacing: 8) {
                        ForEach(options) { option in
                            PendingQuestionOptionButton(
                                label: option.label,
                                toolUseId: question.toolUseId
                            )
                        }
                    }
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(NexusColors.surface1)
        }
        .clipShape(
            UnevenRoundedRectangle(
                topLeadingRadius: 0,
                bottomLeadingRadius: 0,
                bottomTrailingRadius: NexusRadius.lg,
                topTrailingRadius: NexusRadius.lg
            )
        )
        .overlay(
            UnevenRoundedRectangle(
                topLeadingRadius: 0,
                bottomLeadingRadius: 0,
                bottomTrailingRadius: NexusRadius.lg,
                topTrailingRadius: NexusRadius.lg
            )
            .stroke(NexusColors.glassBorder, lineWidth: 1)
        )
    }
}

/// Individual option button for pending questions
struct PendingQuestionOptionButton: View {
    let label: String
    let toolUseId: String?

    @Environment(AppState.self) private var appState
    @State private var isPressed = false

    var body: some View {
        Button {
            if let toolUseId {
                appState.answerQuestion(toolUseId: toolUseId, answer: label)
            }
        } label: {
            Text(label)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(NexusColors.text0)
                .padding(.horizontal, 20)
                .padding(.vertical, 9)
                .background(isPressed ? NexusColors.accentSoft : NexusColors.surface0)
                .clipShape(Capsule())
                .overlay(
                    Capsule()
                        .stroke(isPressed ? NexusColors.accent : NexusColors.glassBorder, lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
        .onLongPressGesture(minimumDuration: .infinity, pressing: { pressing in
            isPressed = pressing
        }, perform: {})
    }
}

// MARK: - Flow Layout

/// Simple flow layout that wraps children to next line
struct FlowLayoutView: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let result = arrangeSubviews(proposal: proposal, subviews: subviews)
        return result.size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let result = arrangeSubviews(proposal: proposal, subviews: subviews)
        for (index, position) in result.positions.enumerated() {
            subviews[index].place(
                at: CGPoint(x: bounds.minX + position.x, y: bounds.minY + position.y),
                proposal: .unspecified
            )
        }
    }

    private struct ArrangementResult {
        var positions: [CGPoint]
        var size: CGSize
    }

    private func arrangeSubviews(proposal: ProposedViewSize, subviews: Subviews) -> ArrangementResult {
        let maxWidth = proposal.width ?? .infinity
        var positions: [CGPoint] = []
        var currentX: CGFloat = 0
        var currentY: CGFloat = 0
        var lineHeight: CGFloat = 0
        var totalWidth: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if currentX + size.width > maxWidth && currentX > 0 {
                currentX = 0
                currentY += lineHeight + spacing
                lineHeight = 0
            }
            positions.append(CGPoint(x: currentX, y: currentY))
            lineHeight = max(lineHeight, size.height)
            currentX += size.width + spacing
            totalWidth = max(totalWidth, currentX - spacing)
        }

        return ArrangementResult(
            positions: positions,
            size: CGSize(width: totalWidth, height: currentY + lineHeight)
        )
    }
}
