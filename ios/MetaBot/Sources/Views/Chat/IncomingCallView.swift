import SwiftUI

/// Incoming call screen with Accept/Reject buttons (like WeChat/WhatsApp)
struct IncomingCallView: View {
    let call: IncomingVoiceCall
    let onAccept: () -> Void
    let onReject: () -> Void

    @State private var pulseScale: CGFloat = 1.0

    var body: some View {
        ZStack {
            NexusColors.void.ignoresSafeArea()

            // Radial glow
            RadialGradient(
                colors: [NexusColors.accent.opacity(0.08), .clear],
                center: .center,
                startRadius: 40,
                endRadius: 300
            )
            .ignoresSafeArea()

            VStack(spacing: 0) {
                Spacer()

                // Avatar with pulse ring
                ZStack {
                    Circle()
                        .stroke(NexusColors.accent.opacity(0.2), lineWidth: 1.5)
                        .frame(width: 130, height: 130)
                        .scaleEffect(pulseScale)
                        .opacity(2 - pulseScale)

                    Circle()
                        .stroke(NexusColors.accent.opacity(0.15), lineWidth: 1)
                        .frame(width: 150, height: 150)
                        .scaleEffect(pulseScale * 0.9)
                        .opacity(2 - pulseScale)

                    GradientAvatar(name: call.botName, size: 100)
                }
                .onAppear {
                    withAnimation(.easeInOut(duration: 1.8).repeatForever(autoreverses: true)) {
                        pulseScale = 1.15
                    }
                }

                Spacer().frame(height: 28)

                // Bot name
                Text(call.botName)
                    .font(NexusTypography.spaceGrotesk(size: 24, weight: .semibold))
                    .foregroundStyle(NexusColors.text0)

                Spacer().frame(height: 8)

                // "Incoming voice call"
                Text("Incoming Voice Call")
                    .font(NexusTypography.spaceGrotesk(size: 15))
                    .foregroundStyle(NexusColors.text2)

                // Prompt hint (if any)
                if let prompt = call.prompt, !prompt.isEmpty {
                    Text(prompt)
                        .font(NexusTypography.body)
                        .foregroundStyle(NexusColors.text1)
                        .multilineTextAlignment(.center)
                        .lineLimit(3)
                        .padding(.horizontal, 40)
                        .padding(.top, 16)
                }

                Spacer()

                // Accept / Reject buttons
                HStack(spacing: 60) {
                    // Reject
                    VStack(spacing: 10) {
                        Button { onReject() } label: {
                            Image(systemName: "phone.down.fill")
                                .font(.system(size: 28))
                                .foregroundStyle(.white)
                                .frame(width: 72, height: 72)
                                .background(NexusColors.red)
                                .clipShape(Circle())
                                .shadow(color: NexusColors.red.opacity(0.4), radius: 12, y: 4)
                        }
                        .accessibilityLabel("Decline")

                        Text("Decline")
                            .font(NexusTypography.caption)
                            .foregroundStyle(NexusColors.text2)
                    }

                    // Accept
                    VStack(spacing: 10) {
                        Button { onAccept() } label: {
                            Image(systemName: "phone.fill")
                                .font(.system(size: 28))
                                .foregroundStyle(.white)
                                .frame(width: 72, height: 72)
                                .background(NexusColors.accent)
                                .clipShape(Circle())
                                .shadow(color: NexusColors.accent.opacity(0.4), radius: 12, y: 4)
                        }
                        .accessibilityLabel("Accept")

                        Text("Accept")
                            .font(NexusTypography.caption)
                            .foregroundStyle(NexusColors.accentText)
                    }
                }
                .padding(.bottom, 80)
            }
        }
    }
}
