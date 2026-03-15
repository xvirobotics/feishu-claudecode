import AVFoundation
import SwiftUI

/// Phone call status phases
enum CallPhase: String {
    case idle
    case listening = "Listening..."
    case speaking = "Speaking..."
    case thinking = "Thinking..."
    case playing = "Speaking..."
    case error = "Error"
}

/// Full-screen phone call overlay for voice conversation
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
    @State private var conversationLog: [(role: String, text: String)] = []
    @State private var silenceTimer: Task<Void, Never>?
    @State private var lastSpeechTime = Date()

    // VAD settings
    private let silenceThreshold: Float = 0.01
    private let silenceDelay: TimeInterval = 1.8

    var body: some View {
        ZStack {
            // Background gradient
            LinearGradient(
                colors: [Color(red: 0.05, green: 0.1, blue: 0.15), Color(red: 0.02, green: 0.05, blue: 0.08)],
                startPoint: .top,
                endPoint: .bottom
            )
            .ignoresSafeArea()

            VStack(spacing: 0) {
                // Top bar
                HStack {
                    Button {
                        endCall()
                    } label: {
                        Image(systemName: "chevron.down")
                            .font(.title3)
                            .foregroundStyle(.white.opacity(0.7))
                    }
                    Spacer()
                    Text(formattedDuration)
                        .font(.system(size: 14, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.6))
                    Spacer()
                    Color.clear.frame(width: 24)
                }
                .padding(.horizontal, 24)
                .padding(.top, 16)

                Spacer()

                // Avatar + status
                VStack(spacing: 20) {
                    ZStack {
                        // Pulsing rings for active states
                        if callPhase == .listening || callPhase == .playing {
                            ForEach(0..<3, id: \.self) { i in
                                Circle()
                                    .stroke(Color.accentColor.opacity(0.15 - Double(i) * 0.05), lineWidth: 2)
                                    .frame(width: 120 + CGFloat(i) * 30, height: 120 + CGFloat(i) * 30)
                                    .scaleEffect(callPhase == .listening ? 1.0 + voiceService.audioLevel * 2 : 1.0)
                                    .animation(.easeInOut(duration: 0.3), value: voiceService.audioLevel)
                            }
                        }

                        GradientAvatar(name: botName, size: 100)
                    }

                    Text(botName)
                        .font(.system(size: 24, weight: .semibold))
                        .foregroundStyle(.white)

                    // Phase indicator
                    HStack(spacing: 8) {
                        if callPhase == .thinking {
                            ProgressView()
                                .tint(.white)
                                .scaleEffect(0.8)
                        } else if callPhase == .listening {
                            Image(systemName: "waveform")
                                .foregroundStyle(Color.accentColor)
                                .symbolEffect(.variableColor.iterative)
                        } else if callPhase == .playing {
                            Image(systemName: "speaker.wave.2.fill")
                                .foregroundStyle(Color.accentColor)
                                .symbolEffect(.variableColor.iterative)
                        }

                        Text(callPhase.rawValue)
                            .font(.system(size: 15))
                            .foregroundStyle(.white.opacity(0.7))
                    }
                    .frame(height: 24)
                }

                Spacer()

                // Transcript display
                if !voiceService.transcribedText.isEmpty && callPhase == .listening {
                    Text(voiceService.transcribedText)
                        .font(.system(size: 15))
                        .foregroundStyle(.white.opacity(0.8))
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 40)
                        .padding(.bottom, 20)
                        .transition(.opacity)
                }

                // Last response
                if let last = conversationLog.last, last.role == "assistant" {
                    Text(last.text)
                        .font(.system(size: 14))
                        .foregroundStyle(.white.opacity(0.5))
                        .multilineTextAlignment(.center)
                        .lineLimit(3)
                        .padding(.horizontal, 40)
                        .padding(.bottom, 20)
                }

                // Error
                if let error = errorMessage {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .padding(.bottom, 8)
                }

                // Bottom controls
                HStack(spacing: 60) {
                    // Mute
                    Button {
                        isMuted.toggle()
                    } label: {
                        ZStack {
                            Circle()
                                .fill(isMuted ? .white : .white.opacity(0.15))
                                .frame(width: 56, height: 56)
                            Image(systemName: isMuted ? "mic.slash.fill" : "mic.fill")
                                .font(.title3)
                                .foregroundStyle(isMuted ? .black : .white)
                        }
                    }

                    // End call
                    Button {
                        endCall()
                    } label: {
                        ZStack {
                            Circle()
                                .fill(.red)
                                .frame(width: 64, height: 64)
                            Image(systemName: "phone.down.fill")
                                .font(.title2)
                                .foregroundStyle(.white)
                        }
                    }

                    // Speaker
                    Button {
                        // Toggle speaker (placeholder)
                    } label: {
                        ZStack {
                            Circle()
                                .fill(.white.opacity(0.15))
                                .frame(width: 56, height: 56)
                            Image(systemName: "speaker.wave.2.fill")
                                .font(.title3)
                                .foregroundStyle(.white)
                        }
                    }
                }
                .padding(.bottom, 50)
            }
        }
        .onAppear { startCall() }
        .onDisappear { cleanup() }
    }

    private var formattedDuration: String {
        let mins = Int(callDuration) / 60
        let secs = Int(callDuration) % 60
        return String(format: "%02d:%02d", mins, secs)
    }

    // MARK: - Call Lifecycle

    private func startCall() {
        Task {
            await voiceService.requestPermissions()
            guard voiceService.permissionGranted else {
                errorMessage = "Microphone permission required"
                return
            }

            // Start call timer
            callTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
                callDuration += 1
            }

            // Start first listen cycle
            startListening()
        }
    }

    private func startListening() {
        guard !isMuted else {
            callPhase = .listening
            return
        }

        do {
            try voiceService.startRecording()
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

        silenceTimer = Task { [weak voiceService] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(200))
                guard !Task.isCancelled, let voiceService else { break }

                let level = voiceService.audioLevel
                let now = Date()

                if level > silenceThreshold {
                    lastSpeechTime = now
                } else if now.timeIntervalSince(lastSpeechTime) > silenceDelay {
                    // Silence detected — stop recording and process
                    await MainActor.run {
                        processRecording()
                    }
                    break
                }
            }
        }
    }

    private func processRecording() {
        silenceTimer?.cancel()

        guard let audioURL = voiceService.stopRecording(),
              let audioData = try? Data(contentsOf: audioURL) else {
            startListening() // Restart if no data
            return
        }

        // Skip if too short (< 0.5s equivalent, ~8KB for m4a)
        if audioData.count < 8000 {
            voiceService.cleanupRecording()
            startListening()
            return
        }

        let transcript = voiceService.transcribedText
        if !transcript.isEmpty {
            conversationLog.append((role: "user", text: transcript))
        }

        callPhase = .thinking

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
                    startListening()
                }
            } catch {
                await MainActor.run {
                    errorMessage = error.localizedDescription
                    callPhase = .error
                }
                // Retry after delay
                try? await Task.sleep(for: .seconds(2))
                await MainActor.run {
                    startListening()
                }
            }
        }
    }

    private func playAudio(data: Data) async {
        await MainActor.run { callPhase = .playing }

        // Use AVAudioSession for playback
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetooth])
            try session.setActive(true)

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

        // Auto-cycle back to listening
        await MainActor.run {
            startListening()
        }
    }

    private func endCall() {
        cleanup()
        dismiss()
    }

    private func cleanup() {
        silenceTimer?.cancel()
        callTimer?.invalidate()
        callTimer = nil
        audioPlayer?.stop()
        audioPlayer = nil
        _ = voiceService.stopRecording()
        voiceService.cleanupRecording()

        try? AVAudioSession.sharedInstance().setActive(false)
    }
}
