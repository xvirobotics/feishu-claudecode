import SwiftUI

struct EmptyStateView: View {
    var botName: String?
    @State private var ringScale: CGFloat = 1.0

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
                Text(String((botName ?? "MetaBot").prefix(1)).uppercased())
                    .font(.system(size: 32, weight: .bold, design: .rounded))
                    .foregroundStyle(NexusColors.accent)
            }

            VStack(spacing: NexusSpacing.sm) {
                Text(botName ?? "MetaBot")
                    .font(NexusTypography.heading)
                    .foregroundStyle(NexusColors.text0)
                Text("Ask anything to get started")
                    .font(NexusTypography.body)
                    .foregroundStyle(NexusColors.text2)
            }

            Spacer()
        }
        .frame(maxWidth: 500)
        .frame(maxWidth: .infinity)
    }
}
