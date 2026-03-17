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

            // Radial accent glow at top
            RadialGradient(
                colors: [NexusColors.accent.opacity(0.12), .clear],
                center: .top,
                startRadius: 0,
                endRadius: 300
            )
            .ignoresSafeArea()
            .blur(radius: 40)

            // Main content
            VStack(spacing: 0) {
                topBar
                Spacer()
                avatarSection
                Spacer()
                transcriptSection
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
                    .font(.title3)
                    .foregroundStyle(NexusColors.text1)
            }
            .accessibilityLabel("End call")
            Spacer()
            HStack(spacing: 6) {
                Text(formattedDuration)
                    .font(NexusTypography.label)
                    .foregroundStyle(NexusColors.text2)
                // RTC badge
                Text("RTC")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(NexusColors.accent.opacity(0.6))
                    .clipShape(Capsule())
            }
            Spacer()
            Color.clear.frame(width: 24)
        }
        .padding(.horizontal, NexusSpacing.xl)
        .padding(.top, NexusSpacing.lg)
    }

    // MARK: - Avatar Section

    private var avatarSection: some View {
        VStack(spacing: 24) {
            GradientAvatar(name: botName, size: 90)
                .overlay(
                    Circle().stroke(
                        NexusColors.accent.opacity(rtcService.callPhase == .connected ? 0.4 : 0),
                        lineWidth: 2
                    )
                )
                .animation(NexusMotion.base, value: rtcService.callPhase == .connected)

            Text(botName)
                .font(NexusTypography.title)
                .foregroundStyle(NexusColors.text0)

            WaveformView(
                audioLevel: rtcService.callPhase == .connected ? 0.3 : 0,
                isActive: rtcService.callPhase == .connected
            )
            .padding(.horizontal, 40)

            phaseIndicator
        }
    }

    // MARK: - Phase Indicator

    private var phaseIndicator: some View {
        HStack(spacing: 8) {
            switch rtcService.callPhase {
            case .connecting:
                NexusThinkingDots()
            case .connected:
                Image(systemName: rtcService.isMuted ? "mic.slash.fill" : "waveform")
                    .foregroundStyle(NexusColors.accent)
                    .symbolEffect(.variableColor.iterative)
            case .error:
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(NexusColors.red)
            default:
                EmptyView()
            }

            Text(rtcService.callPhase.displayText)
                .font(NexusTypography.body)
                .foregroundStyle(NexusColors.text1)
        }
        .frame(height: 28)
    }

    // MARK: - Transcript Section

    @ViewBuilder
    private var transcriptSection: some View {
        // Live subtitle display
        if !rtcService.subtitleText.isEmpty && rtcService.callPhase == .connected {
            Text(rtcService.subtitleText)
                .font(NexusTypography.body)
                .foregroundStyle(NexusColors.text0)
                .multilineTextAlignment(.center)
                .padding(NexusSpacing.md)
                .background(NexusColors.surface1)
                .clipShape(RoundedRectangle(cornerRadius: NexusRadius.lg))
                .nexusGlassBorder(radius: NexusRadius.lg)
                .padding(.horizontal, 40)
                .padding(.bottom, 20)
                .transition(.opacity)
                .animation(.easeInOut(duration: 0.2), value: rtcService.subtitleText)
        }

        // Error message
        if case .error(let msg) = rtcService.callPhase {
            Text(msg)
                .font(.caption)
                .foregroundStyle(NexusColors.red)
                .padding(.bottom, 8)
        }
    }

    // MARK: - Controls Bar

    private var controlsBar: some View {
        HStack(spacing: NexusSpacing.xxl) {
            // Mute
            Button { rtcService.toggleMute() } label: {
                ZStack {
                    Circle()
                        .fill(rtcService.isMuted ? NexusColors.red.opacity(0.2) : NexusColors.surface2)
                        .frame(width: 56, height: 56)
                        .nexusGlassBorder(radius: 28)
                    Image(systemName: rtcService.isMuted ? "mic.slash.fill" : "mic.fill")
                        .font(.title3)
                        .foregroundStyle(rtcService.isMuted ? NexusColors.red : NexusColors.text1)
                }
            }
            .accessibilityLabel(rtcService.isMuted ? "Unmute" : "Mute")
            .disabled(rtcService.callPhase != .connected)

            // End call
            Button { endCall() } label: {
                ZStack {
                    Circle().fill(NexusColors.red).frame(width: 68, height: 68)
                        .nexusShadowMd()
                    Image(systemName: "phone.down.fill")
                        .font(.title2)
                        .foregroundStyle(.white)
                }
            }
            .accessibilityLabel("End call")

            // Speaker toggle
            Button { toggleSpeaker() } label: {
                ZStack {
                    Circle()
                        .fill(isSpeakerOn ? NexusColors.accentSoft : NexusColors.surface2)
                        .frame(width: 56, height: 56)
                        .nexusGlassBorder(radius: 28)
                    Image(systemName: isSpeakerOn ? "speaker.wave.3.fill" : "speaker.wave.2.fill")
                        .font(.title3)
                        .foregroundStyle(isSpeakerOn ? NexusColors.accent : NexusColors.text1)
                }
            }
            .accessibilityLabel(isSpeakerOn ? "Disable speaker" : "Enable speaker")
        }
        .padding(.bottom, 50)
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
        // Prevent auto-lock during call
        UIApplication.shared.isIdleTimerDisabled = true

        // Set up audio interruption handling
        setupInterruptionHandling()

        // Set up Now Playing info for lock screen
        setupNowPlaying()

        // Start call timer
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
                // Agent-initiated call — join existing room
                await rtcService.joinCall(
                    incoming: incoming,
                    serverURL: appState.serverURL,
                    token: token
                )
            } else {
                // User-initiated call — create room + join
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

            // Inject transcript into chat for Claude processing
            if let transcriptText {
                appState.injectRtcTranscript(transcriptText)
            }

            cleanup()
            dismiss()
        }
    }

    private func cleanup() {
        callTimer?.invalidate()
        callTimer = nil

        // Re-enable auto-lock
        UIApplication.shared.isIdleTimerDisabled = false

        // Clear Now Playing
        clearNowPlaying()

        // Remove interruption observer
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
                  let type = AVAudioSession.InterruptionType(rawValue: typeValue) else { return }

            switch type {
            case .began:
                // Phone call or Siri interrupted
                break
            case .ended:
                // Interruption ended — RTC SDK should handle audio session recovery
                break
            @unknown default:
                break
            }
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

        // Handle remote command: pause = end call
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
