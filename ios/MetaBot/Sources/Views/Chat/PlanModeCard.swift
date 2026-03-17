import SwiftUI
import MarkdownUI

struct PlanModeCard: View {
    let text: String
    @State private var isExpanded = false

    var body: some View {
        HStack(spacing: 0) {
            // Left accent border
            Rectangle()
                .fill(NexusColors.accent)
                .frame(width: 3)

            VStack(alignment: .leading, spacing: 0) {
                // Header
                Button {
                    withAnimation(NexusMotion.base) { isExpanded.toggle() }
                } label: {
                    HStack(spacing: NexusSpacing.sm) {
                        Text("PLAN")
                            .font(NexusTypography.jetBrainsMono(size: 10))
                            .foregroundStyle(NexusColors.accentText)
                            .tracking(1.2)
                        Spacer()
                        Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                            .foregroundStyle(NexusColors.text2)
                            .font(.system(size: 12))
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 14)
                }
                .buttonStyle(.plain)

                if isExpanded {
                    Divider().background(NexusColors.glassBorder)
                    ScrollView {
                        Markdown(text)
                            .markdownTheme(.nexus)
                            .padding(14)
                    }
                    .frame(maxHeight: 400)
                }
            }
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
        .padding(.horizontal, NexusSpacing.lg)
    }
}
