import AVFoundation
import MediaPlayer
import SwiftUI

/// Full-screen RTC voice call overlay.
/// Uses Volcengine RTC for real-time AI voice chat (ASR -> LLM -> TTS in cloud).
/// No local recording/VAD needed — all audio processing happens server-side.
struct RtcCallView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss

    let botName: String
    let chatId: String
    /// Non-nil for agent-initiated (incoming) calls
    let incoming: IncomingVoiceCall?

    @State private var rtcService = RtcVoiceService()
    @State private var callDuration: TimeInterval = 0
    @State private var callTimer: Timer?
    @State private var interruptionObserver: Any?
    @State private var isSpeakerOn = false

    init(botName: String, chatId: String, incoming: IncomingVoiceCall? = nil) {
        self.botName = botName
        self.chatId = chatId
        self.incoming = incoming
    }

    var body: some View {
        ZStack {
            NexusColors.void.ignoresSafeArea()

            // Radial accent glow
            RadialGradient(
                colors: [NexusColors.accent.opacity(0.10), .clear],
                center: .center,
                startRadius: 40,
                endRadius: 350
            )
            .ignoresSafeArea()

            VStack(spacing: 0) {
                // Top bar — flush with safe area
                topBar

                Spacer(minLength: 20)

                // Avatar + name
                avatarAndName

                Spacer(minLength: 16)

                // Waveform + status
                statusSection

                Spacer(minLength: 16)

                // Live subtitle
                subtitleSection

                Spacer()

                // Controls
                controlsBar
            }
        }
        .onAppear {
            Haptics.medium()
            startCall()
        }
        .onDisappear { cleanup() }
    }

    // MARK: - Top Bar

    private var topBar: some View {
        HStack {
            Button { endCall() } label: {
                Image(systemName: "chevron.down")
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(NexusColors.text1)
                    .frame(width: 44, height: 44)
            }
            .accessibilityLabel("End call")

            Spacer()

            HStack(spacing: 6) {
                Text(formattedDuration)
                    .font(NexusTypography.jetBrainsMono(size: 14))
                    .foregroundStyle(NexusColors.text1)
                    .monospacedDigit()
                Text("RTC")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(NexusColors.accentText)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(NexusColors.accentSofter)
                    .clipShape(Capsule())
            }

            Spacer()

            Color.clear.frame(width: 44, height: 44)
        }
        .padding(.horizontal, 16)
    }

    // MARK: - Avatar + Name

    private var avatarAndName: some View {
        VStack(spacing: 16) {
            ZStack {
                // Outer pulse ring when connected
                if rtcService.callPhase == .connected {
                    Circle()
                        .stroke(NexusColors.accent.opacity(0.15), lineWidth: 1.5)
                        .frame(width: 120, height: 120)
                }

                GradientAvatar(name: botName, size: 96)
            }

            Text(botName)
                .font(NexusTypography.spaceGrotesk(size: 22, weight: .semibold))
                .foregroundStyle(NexusColors.text0)
        }
    }

    // MARK: - Status Section

    private var statusSection: some View {
        VStack(spacing: 12) {
            // Waveform — only show when connected
            if rtcService.callPhase == .connected {
                WaveformView(
                    audioLevel: 0.3,
                    isActive: true
                )
                .frame(height: 32)
                .padding(.horizontal, 80)
            }

            // Phase indicator
            HStack(spacing: 8) {
                switch rtcService.callPhase {
                case .connecting:
                    NexusThinkingDots()
                case .connected:
                    Circle()
                        .fill(NexusColors.accent)
                        .frame(width: 6, height: 6)
                case .error:
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 12))
                        .foregroundStyle(NexusColors.red)
                default:
                    EmptyView()
                }

                Text(rtcService.callPhase.displayText)
                    .font(NexusTypography.spaceGrotesk(size: 14))
                    .foregroundStyle(NexusColors.text2)
            }
        }
    }

    // MARK: - Subtitle Section

    @ViewBuilder
    private var subtitleSection: some View {
        if !rtcService.subtitleText.isEmpty && rtcService.callPhase == .connected {
            Text(rtcService.subtitleText)
                .font(NexusTypography.body)
                .foregroundStyle(NexusColors.text0)
                .multilineTextAlignment(.center)
                .lineLimit(4)
                .padding(.horizontal, 20)
                .padding(.vertical, 14)
                .frame(maxWidth: 320)
                .background(NexusColors.surface1)
                .clipShape(RoundedRectangle(cornerRadius: NexusRadius.lg))
                .nexusGlassBorder(radius: NexusRadius.lg)
                .padding(.horizontal, 32)
                .transition(.opacity)
                .animation(.easeInOut(duration: 0.2), value: rtcService.subtitleText)
        }

        if case .error(let msg) = rtcService.callPhase {
            Text(msg)
                .font(NexusTypography.caption)
                .foregroundStyle(NexusColors.red)
                .padding(.horizontal, 32)
        }
    }

    // MARK: - Controls Bar

    private var controlsBar: some View {
        HStack(spacing: 40) {
            // Mute
            callButton(
                icon: rtcService.isMuted ? "mic.slash.fill" : "mic.fill",
                isActive: rtcService.isMuted,
                activeColor: NexusColors.red,
                size: 60
            ) {
                rtcService.toggleMute()
            }
            .accessibilityLabel(rtcService.isMuted ? "Unmute" : "Mute")
            .disabled(rtcService.callPhase != .connected)

            // End call
            Button { endCall() } label: {
                Image(systemName: "phone.down.fill")
                    .font(.system(size: 24))
                    .foregroundStyle(.white)
                    .frame(width: 72, height: 72)
                    .background(NexusColors.red)
                    .clipShape(Circle())
                    .shadow(color: NexusColors.red.opacity(0.4), radius: 12, y: 4)
            }
            .accessibilityLabel("End call")

            // Speaker toggle
            callButton(
                icon: isSpeakerOn ? "speaker.wave.3.fill" : "speaker.wave.2.fill",
                isActive: isSpeakerOn,
                activeColor: NexusColors.accent,
                size: 60
            ) {
                toggleSpeaker()
            }
            .accessibilityLabel(isSpeakerOn ? "Disable speaker" : "Enable speaker")
        }
        .padding(.bottom, 60)
    }

    /// Reusable call control button
    private func callButton(icon: String, isActive: Bool, activeColor: Color, size: CGFloat, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 20))
                .foregroundStyle(isActive ? activeColor : NexusColors.text1)
                .frame(width: size, height: size)
                .background(isActive ? activeColor.opacity(0.15) : NexusColors.surface2)
                .clipShape(Circle())
                .overlay {
                    Circle().stroke(NexusColors.glassBorder, lineWidth: 1)
                }
        }
    }

    private var formattedDuration: String {
        let mins = Int(callDuration) / 60
        let secs = Int(callDuration) % 60
        return String(format: "%02d:%02d", mins, secs)
    }

    // MARK: - Speaker Toggle

    private func toggleSpeaker() {
        isSpeakerOn.toggle()
        do {
            let session = AVAudioSession.sharedInstance()
            let options: AVAudioSession.CategoryOptions = isSpeakerOn ? [.defaultToSpeaker, .allowBluetooth] : [.allowBluetooth]
            try session.setCategory(.playAndRecord, mode: .voiceChat, options: options)
            try session.setActive(true)
        } catch {
            print("[Call] Speaker toggle error: \(error)")
        }
    }

    // MARK: - Call Lifecycle

    private func startCall() {
        UIApplication.shared.isIdleTimerDisabled = true
        setupInterruptionHandling()
        setupNowPlaying()

        callTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
            if rtcService.callStartTime != nil {
                callDuration += 1
                updateNowPlayingTime()
            }
        }

        Task {
            guard let token = appState.auth.token else {
                rtcService.setError("Not authenticated")
                return
            }

            if let incoming {
                await rtcService.joinCall(
                    incoming: incoming,
                    serverURL: appState.serverURL,
                    token: token
                )
            } else {
                let chatContext = appState.buildChatContext(forSession: chatId)
                var systemPrompt: String?
                if !chatContext.isEmpty {
                    systemPrompt = """
                    你是 \(botName)。用用户说的语言回答。简洁、自然地对话。

                    以下是你和用户之前的文字聊天记录，请基于这些上下文继续对话：

                    \(chatContext)
                    """
                }

                await rtcService.startCall(
                    serverURL: appState.serverURL,
                    token: token,
                    botName: botName,
                    chatId: chatId,
                    systemPrompt: systemPrompt
                )
            }
        }
    }

    private func endCall() {
        Haptics.medium()
        Task {
            let transcriptText = await rtcService.endCall()
            if let transcriptText, incoming == nil {
                // User-initiated call: inject transcript for Claude to process.
                // Incoming (agent-initiated) calls: agent gets transcript via --wait, skip.
                appState.injectRtcTranscript(transcriptText, chatId: chatId, botName: botName)
            }

            // Notify CallKit that call ended
            CallKitService.shared.endCurrentCall()

            cleanup()
            dismiss()
        }
    }

    private func cleanup() {
        callTimer?.invalidate()
        callTimer = nil
        UIApplication.shared.isIdleTimerDisabled = false
        clearNowPlaying()
        if let observer = interruptionObserver {
            NotificationCenter.default.removeObserver(observer)
            interruptionObserver = nil
        }
    }

    // MARK: - Audio Interruption Handling

    private func setupInterruptionHandling() {
        interruptionObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: nil,
            queue: .main
        ) { notification in
            guard let info = notification.userInfo,
                  let typeValue = info[AVAudioSessionInterruptionTypeKey] as? UInt,
                  let _ = AVAudioSession.InterruptionType(rawValue: typeValue) else { return }
        }
    }

    // MARK: - Now Playing (Lock Screen Controls)

    private func setupNowPlaying() {
        let center = MPNowPlayingInfoCenter.default()
        center.nowPlayingInfo = [
            MPMediaItemPropertyTitle: "MetaBot Voice Call",
            MPMediaItemPropertyArtist: botName,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: 0,
            MPNowPlayingInfoPropertyPlaybackRate: 1.0,
        ]

        let commandCenter = MPRemoteCommandCenter.shared()
        commandCenter.pauseCommand.isEnabled = true
        commandCenter.pauseCommand.addTarget { _ in
            endCall()
            return .success
        }
        commandCenter.playCommand.isEnabled = false
    }

    private func updateNowPlayingTime() {
        MPNowPlayingInfoCenter.default().nowPlayingInfo?[MPNowPlayingInfoPropertyElapsedPlaybackTime] = callDuration
    }

    private func clearNowPlaying() {
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        let commandCenter = MPRemoteCommandCenter.shared()
        commandCenter.pauseCommand.removeTarget(nil)
    }
}
