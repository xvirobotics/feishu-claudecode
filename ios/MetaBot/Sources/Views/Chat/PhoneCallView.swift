import AVFoundation
import MediaPlayer
import SwiftUI

/// Phone call status phases
enum CallPhase {
    case idle
    case listening
    case speaking
    case thinking
    case playing
    case error

    var displayText: String {
        switch self {
        case .idle: return ""
        case .listening: return "Listening..."
        case .speaking: return "Speaking..."
        case .thinking: return "Thinking..."
        case .playing: return "AI Speaking..."
        case .error: return "Error"
        }
    }
}

/// Full-screen phone call overlay for voice conversation.
/// Supports background audio — conversation continues when screen is locked.
struct PhoneCallView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss

    let botName: String
    let chatId: String

    @State private var callPhase: CallPhase = .idle
    @State private var callDuration: TimeInterval = 0
    @State private var callTimer: Timer?
    @State private var voiceService = VoiceService()
    @State private var audioPlayer: AVAudioPlayer?
    @State private var errorMessage: String?
    @State private var isMuted = false
    @State private var isSpeakerOn = false
    @State private var conversationLog: [(role: String, text: String)] = []
    @State private var silenceTimer: Task<Void, Never>?
    @State private var lastSpeechTime = Date()
    @State private var interruptionObserver: Any?

    // VAD settings
    private let silenceThreshold: Float = 0.01
    private let silenceDelay: TimeInterval = 1.8

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

    private var topBar: some View {
        HStack {
            Button { endCall() } label: {
                Image(systemName: "chevron.down")
                    .font(.title3)
                    .foregroundStyle(NexusColors.text1)
            }
            .accessibilityLabel("End call")
            Spacer()
            Text(formattedDuration)
                .font(NexusTypography.label)
                .foregroundStyle(NexusColors.text2)
            Spacer()
            Color.clear.frame(width: 24)
        }
        .padding(.horizontal, NexusSpacing.xl)
        .padding(.top, NexusSpacing.lg)
    }

    private var avatarSection: some View {
        VStack(spacing: 24) {
            GradientAvatar(name: botName, size: 90)
                .overlay(
                    Circle().stroke(
                        NexusColors.accent.opacity(callPhase == .listening || callPhase == .playing ? 0.4 : 0),
                        lineWidth: 2
                    )
                )
                .animation(NexusMotion.base, value: callPhase == .listening)

            Text(botName)
                .font(NexusTypography.title)
                .foregroundStyle(NexusColors.text0)

            WaveformView(
                audioLevel: voiceService.audioLevel,
                isActive: callPhase == .listening || callPhase == .playing
            )
            .padding(.horizontal, 40)

            phaseIndicator
        }
    }

    private var phaseIndicator: some View {
        HStack(spacing: 8) {
            if callPhase == .thinking {
                NexusThinkingDots()
            } else if callPhase == .listening {
                Image(systemName: "waveform")
                    .foregroundStyle(NexusColors.accent)
                    .symbolEffect(.variableColor.iterative)
            } else if callPhase == .playing {
                Image(systemName: "speaker.wave.2.fill")
                    .foregroundStyle(NexusColors.accent)
                    .symbolEffect(.variableColor.iterative)
            }
            Text(callPhase.displayText)
                .font(NexusTypography.body)
                .foregroundStyle(NexusColors.text1)
        }
        .frame(height: 28)
    }

    @ViewBuilder
    private var transcriptSection: some View {
        if !voiceService.transcribedText.isEmpty && callPhase == .listening {
            Text(voiceService.transcribedText)
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
        }
        if let last = conversationLog.last, last.role == "assistant" {
            Text(last.text)
                .font(NexusTypography.caption)
                .foregroundStyle(NexusColors.text1)
                .multilineTextAlignment(.center)
                .lineLimit(3)
                .padding(NexusSpacing.md)
                .background(NexusColors.surface1)
                .clipShape(RoundedRectangle(cornerRadius: NexusRadius.lg))
                .nexusGlassBorder(radius: NexusRadius.lg)
                .padding(.horizontal, 40)
                .padding(.bottom, 20)
        }
        if let error = errorMessage {
            Text(error)
                .font(.caption)
                .foregroundStyle(NexusColors.red)
                .padding(.bottom, 8)
        }
    }

    private var controlsBar: some View {
        HStack(spacing: NexusSpacing.xxl) {
            // Mute
            Button { isMuted.toggle() } label: {
                ZStack {
                    Circle()
                        .fill(isMuted ? NexusColors.red.opacity(0.2) : NexusColors.surface2)
                        .frame(width: 56, height: 56)
                        .nexusGlassBorder(radius: 28)
                    Image(systemName: isMuted ? "mic.slash.fill" : "mic.fill")
                        .font(.title3)
                        .foregroundStyle(isMuted ? NexusColors.red : NexusColors.text1)
                }
            }
            .accessibilityLabel(isMuted ? "Unmute" : "Mute")

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
        Task {
            await voiceService.requestPermissions()
            guard voiceService.permissionGranted else {
                await MainActor.run { errorMessage = "Microphone permission required" }
                return
            }

            await MainActor.run {
                // Prevent auto-lock during call
                UIApplication.shared.isIdleTimerDisabled = true

                // Enter call mode (persistent audio session for background)
                do {
                    try voiceService.enterCallMode()
                } catch {
                    errorMessage = "Failed to start audio: \(error.localizedDescription)"
                    return
                }

                // Set up audio interruption handling
                setupInterruptionHandling()

                // Set up Now Playing info for lock screen
                setupNowPlaying()

                // Start call timer on main runloop so it fires reliably
                callTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
                    callDuration += 1
                    updateNowPlayingTime()
                }

                startListening()
            }
        }
    }

    private func startListening() {
        guard !isMuted else {
            callPhase = .listening
            return
        }

        do {
            // In call mode, skip local STT (use server-side STT for background compatibility)
            try voiceService.startRecording(useLocalSTT: false)
            callPhase = .listening
            errorMessage = nil

            // Start silence detection
            startSilenceDetection()
        } catch {
            errorMessage = error.localizedDescription
            callPhase = .error
        }
    }

    private func startSilenceDetection() {
        silenceTimer?.cancel()
        lastSpeechTime = Date()

        silenceTimer = Task { @MainActor [weak voiceService] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(200))
                guard !Task.isCancelled, let voiceService else { break }

                let level = voiceService.audioLevel
                let now = Date()

                if level > silenceThreshold {
                    lastSpeechTime = now
                } else if now.timeIntervalSince(lastSpeechTime) > silenceDelay {
                    processRecording()
                    break
                }
            }
        }
    }

    private func processRecording() {
        silenceTimer?.cancel()

        // Use pauseRecording (keeps engine alive for background mode)
        guard let audioURL = voiceService.pauseRecording(),
              let audioData = try? Data(contentsOf: audioURL) else {
            startListening()
            return
        }

        // Skip if too short (< 0.5s equivalent, ~8KB for m4a)
        if audioData.count < 8000 {
            voiceService.cleanupRecording()
            startListening()
            return
        }

        callPhase = .thinking

        // Keep audio engine alive during thinking phase
        voiceService.startSilentKeepAlive()

        Task {
            do {
                guard let token = appState.auth.token else { return }
                let api = VoiceAPIService(serverURL: appState.serverURL, token: token)
                let response = try await api.sendVoice(
                    audioData: audioData,
                    botName: botName,
                    chatId: chatId,
                    voiceMode: true,
                    tts: "doubao",
                    stt: "doubao",
                    language: "zh"
                )

                voiceService.cleanupRecording()

                if !response.responseText.isEmpty {
                    conversationLog.append((role: "assistant", text: response.responseText))
                }

                if let audio = response.audioData, !audio.isEmpty {
                    await playAudio(data: audio)
                } else {
                    // No audio — go back to listening
                    await MainActor.run { startListening() }
                }
            } catch {
                await MainActor.run {
                    errorMessage = error.localizedDescription
                    callPhase = .error
                }
                // Retry after delay
                try? await Task.sleep(for: .seconds(2))
                await MainActor.run { startListening() }
            }
        }
    }

    private func playAudio(data: Data) async {
        await MainActor.run { callPhase = .playing }

        // Audio session already active from call mode — just play
        do {
            let player = try AVAudioPlayer(data: data)
            await MainActor.run { audioPlayer = player }
            player.play()

            // Wait for playback to finish
            while player.isPlaying {
                try? await Task.sleep(for: .milliseconds(100))
            }
        } catch {
            print("[Call] Playback error: \(error)")
        }

        // Auto-cycle back to listening (no gap!)
        await MainActor.run { startListening() }
    }

    private func endCall() {
        Haptics.medium()
        cleanup()
        dismiss()
    }

    private func cleanup() {
        silenceTimer?.cancel()
        callTimer?.invalidate()
        callTimer = nil
        audioPlayer?.stop()
        audioPlayer = nil

        // Exit call mode (fully releases audio session)
        voiceService.exitCallMode()
        voiceService.cleanupRecording()

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
                // Phone call or Siri interrupted — pause gracefully
                silenceTimer?.cancel()
                callPhase = .idle
            case .ended:
                // Interruption ended — resume if possible
                if let optionsValue = info[AVAudioSessionInterruptionOptionKey] as? UInt {
                    let options = AVAudioSession.InterruptionOptions(rawValue: optionsValue)
                    if options.contains(.shouldResume) {
                        try? voiceService.enterCallMode()
                        startListening()
                    }
                }
            @unknown default:
                break
            }
        }
    }

    // MARK: - Now Playing (Lock Screen Controls)

    private func setupNowPlaying() {
        let center = MPNowPlayingInfoCenter.default()
        center.nowPlayingInfo = [
            MPMediaItemPropertyTitle: "MetaBot Call",
            MPMediaItemPropertyArtist: botName,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: 0,
            MPNowPlayingInfoPropertyPlaybackRate: 1.0,
        ]

        // Handle remote command: pause = end call
        let commandCenter = MPRemoteCommandCenter.shared()
        commandCenter.pauseCommand.isEnabled = true
        commandCenter.pauseCommand.addTarget { [self] _ in
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
