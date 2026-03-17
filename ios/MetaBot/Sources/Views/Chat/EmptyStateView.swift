import SwiftUI

struct EmptyStateView: View {
    let onHintTap: (String) -> Void

    @State private var ringScale: CGFloat = 1.0

    private let hints = [
        "Explain how this project works",
        "Find and fix bugs in my code",
        "Write tests for the main module",
        "Refactor this function for clarity",
    ]

    var body: some View {
        VStack(spacing: NexusSpacing.xl) {
            Spacer()

            // Logo with animated ring
            ZStack {
                Circle()
                    .stroke(NexusColors.accent.opacity(0.2), lineWidth: 1.5)
                    .frame(width: 88, height: 88)
                    .scaleEffect(ringScale)
                    .onAppear {
                        withAnimation(
                            .easeInOut(duration: 2.4)
                            .repeatForever(autoreverses: true)
                        ) {
                            ringScale = 1.08
                        }
                    }

                Circle()
                    .fill(NexusColors.accentSoft)
                    .frame(width: 72, height: 72)
                Text("M")
                    .font(.system(size: 32, weight: .bold, design: .rounded))
                    .foregroundStyle(NexusColors.accent)
            }

            VStack(spacing: NexusSpacing.sm) {
                Text("MetaBot")
                    .font(NexusTypography.heading)
                    .foregroundStyle(NexusColors.text0)
                Text("Ask anything to get started")
                    .font(NexusTypography.body)
                    .foregroundStyle(NexusColors.text2)
            }

            // Hint buttons
            VStack(spacing: NexusSpacing.sm) {
                ForEach(hints, id: \.self) { hint in
                    HintButton(text: hint) {
                        onHintTap(hint)
                    }
                }
            }
            .padding(.horizontal, NexusSpacing.xl)

            Spacer()
        }
        .frame(maxWidth: 500)
        .frame(maxWidth: .infinity)
    }
}

/// Hint button with press scale animation
private struct HintButton: View {
    let text: String
    let action: () -> Void

    @State private var isPressed = false

    var body: some View {
        Button(action: action) {
            Text(text)
                .font(NexusTypography.body)
                .foregroundStyle(NexusColors.text1)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, NexusSpacing.lg)
                .padding(.vertical, NexusSpacing.md)
                .background(NexusColors.surface1)
                .clipShape(RoundedRectangle(cornerRadius: NexusRadius.md))
                .nexusGlassBorder(radius: NexusRadius.md)
                .scaleEffect(isPressed ? 0.98 : 1.0)
                .animation(NexusMotion.fast, value: isPressed)
        }
        .buttonStyle(.plain)
        .onLongPressGesture(minimumDuration: .infinity, pressing: { pressing in
            isPressed = pressing
        }, perform: {})
    }
}
