import AVFoundation
import Observation
import Speech

/// Voice recording and speech recognition service.
/// Supports two modes:
/// - **Normal mode**: start/stop recording with on-device SFSpeechRecognizer
/// - **Call mode**: persistent audio session for background voice calls;
///   keeps AVAudioEngine alive during "thinking" phase to prevent iOS suspension
@Observable
final class VoiceService {
    private(set) var isRecording = false
    private(set) var transcribedText = ""
    private(set) var audioLevel: Float = 0
    private(set) var permissionGranted = false
    private(set) var isInCallMode = false

    private var audioEngine: AVAudioEngine?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private let speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: "zh-Hans"))

    private var audioFile: AVAudioFile?
    private var recordingURL: URL?
    /// When true, the input tap is running but we're not writing audio to file
    private var isKeepAliveMode = false

    // MARK: - Permissions

    /// Request microphone + speech recognition permissions
    func requestPermissions() async {
        let audioGranted = await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { granted in
                continuation.resume(returning: granted)
            }
        }

        let speechGranted = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status == .authorized)
            }
        }

        await MainActor.run {
            permissionGranted = audioGranted && speechGranted
        }
    }

    // MARK: - Call Mode (Background-Safe)

    /// Enter call mode: set up a persistent audio session that keeps the app alive in background.
    /// Uses `.voiceChat` mode for optimal echo cancellation on speakerphone.
    func enterCallMode() throws {
        let audioSession = AVAudioSession.sharedInstance()
        try audioSession.setCategory(
            .playAndRecord,
            mode: .voiceChat,
            options: [.defaultToSpeaker, .allowBluetooth, .mixWithOthers]
        )
        try audioSession.setActive(true, options: .notifyOthersOnDeactivation)
        isInCallMode = true
    }

    /// Exit call mode: fully stop audio engine and release the audio session.
    func exitCallMode() {
        isInCallMode = false
        isKeepAliveMode = false

        audioEngine?.inputNode.removeTap(onBus: 0)
        audioEngine?.stop()
        audioEngine = nil

        recognitionRequest?.endAudio()
        recognitionTask?.cancel()
        recognitionRequest = nil
        recognitionTask = nil
        audioFile = nil

        isRecording = false
        audioLevel = 0

        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    // MARK: - Recording

    /// Start recording audio with optional real-time speech recognition.
    /// In call mode, reuses the audio session (already active).
    /// In normal mode, creates a fresh session.
    func startRecording(useLocalSTT: Bool = true) throws {
        // Clean up previous recording state
        if isRecording || isKeepAliveMode {
            audioEngine?.inputNode.removeTap(onBus: 0)
            audioEngine?.stop()
            recognitionRequest?.endAudio()
            recognitionTask?.cancel()
            recognitionRequest = nil
            recognitionTask = nil
            audioFile = nil
            audioEngine = nil
        }
        isKeepAliveMode = false

        // Set up audio session (skip if already in call mode)
        if !isInCallMode {
            let audioSession = AVAudioSession.sharedInstance()
            try audioSession.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetooth])
            try audioSession.setActive(true, options: .notifyOthersOnDeactivation)
        }

        audioEngine = AVAudioEngine()
        guard let audioEngine else { throw VoiceServiceError.unavailable }

        // Set up recording file
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("metabot_recording_\(UUID().uuidString).m4a")
        recordingURL = url

        // Set up speech recognition (only if using local STT and not in call mode)
        if useLocalSTT && !isInCallMode, let speechRecognizer, speechRecognizer.isAvailable {
            recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
            recognitionRequest?.shouldReportPartialResults = true

            recognitionTask = speechRecognizer.recognitionTask(with: recognitionRequest!) { [weak self] result, error in
                guard let self else { return }
                if let result {
                    Task { @MainActor in
                        self.transcribedText = result.bestTranscription.formattedString
                    }
                }
                if error != nil || (result?.isFinal == true) {
                    // Recognition ended
                }
            }
        }

        // Audio tap
        let inputNode = audioEngine.inputNode
        let recordingFormat = inputNode.outputFormat(forBus: 0)

        // Set up audio file for saving
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: recordingFormat.sampleRate,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
        ]
        audioFile = try AVAudioFile(forWriting: url, settings: settings, commonFormat: recordingFormat.commonFormat, interleaved: false)

        inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { [weak self] buffer, _ in
            guard let self else { return }
            self.recognitionRequest?.append(buffer)
            try? self.audioFile?.write(from: buffer)

            // Update audio level
            let channelData = buffer.floatChannelData?[0]
            let frames = buffer.frameLength
            if let channelData, frames > 0 {
                var sum: Float = 0
                for i in 0..<Int(frames) {
                    sum += abs(channelData[i])
                }
                let avg = sum / Float(frames)
                Task { @MainActor in
                    self.audioLevel = avg
                }
            }
        }

        audioEngine.prepare()
        try audioEngine.start()
        isRecording = true
        transcribedText = ""
    }

    /// Stop recording and return the audio file URL.
    /// In normal mode, tears down the entire audio engine.
    @discardableResult
    func stopRecording() -> URL? {
        audioEngine?.inputNode.removeTap(onBus: 0)
        audioEngine?.stop()
        recognitionRequest?.endAudio()
        recognitionTask?.cancel()
        audioFile = nil

        audioEngine = nil
        recognitionRequest = nil
        recognitionTask = nil
        isRecording = false
        audioLevel = 0

        return recordingURL
    }

    /// Pause recording but keep the audio engine alive (call mode only).
    /// Returns the recording URL. The engine input tap continues to run
    /// with a no-op handler, keeping iOS background audio mode active.
    func pauseRecording() -> URL? {
        guard isInCallMode else { return stopRecording() }

        // Stop writing to file and stop speech recognizer
        recognitionRequest?.endAudio()
        recognitionTask?.cancel()
        recognitionRequest = nil
        recognitionTask = nil
        audioFile = nil
        isRecording = false

        // Keep engine alive: reinstall tap with discard-only handler
        let url = recordingURL
        startSilentKeepAlive()
        return url
    }

    /// Keep the audio engine alive with a minimal input tap that monitors
    /// audio level but discards data. This maintains iOS background audio mode
    /// during the "thinking" phase between recording and playback.
    func startSilentKeepAlive() {
        guard isInCallMode else { return }
        isKeepAliveMode = true

        // If engine is already running with a tap, we're good
        if let engine = audioEngine, engine.isRunning { return }

        // Start a fresh engine with a discard tap
        audioEngine?.inputNode.removeTap(onBus: 0)
        audioEngine?.stop()
        audioEngine = AVAudioEngine()

        guard let audioEngine else { return }
        let inputNode = audioEngine.inputNode
        let format = inputNode.outputFormat(forBus: 0)

        inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            // Discard audio data, just monitor level for UI feedback
            let channelData = buffer.floatChannelData?[0]
            let frames = buffer.frameLength
            if let channelData, frames > 0 {
                var sum: Float = 0
                for i in 0..<Int(frames) { sum += abs(channelData[i]) }
                let avg = sum / Float(frames)
                Task { @MainActor in self?.audioLevel = avg }
            }
        }

        audioEngine.prepare()
        try? audioEngine.start()
    }

    // MARK: - Helpers

    /// Get audio data from last recording
    func getRecordingData() -> Data? {
        guard let url = recordingURL else { return nil }
        return try? Data(contentsOf: url)
    }

    /// Cleanup temp files
    func cleanupRecording() {
        if let url = recordingURL {
            try? FileManager.default.removeItem(at: url)
            recordingURL = nil
        }
    }
}

enum VoiceServiceError: Error, LocalizedError {
    case unavailable
    case permissionDenied

    var errorDescription: String? {
        switch self {
        case .unavailable: return "Speech recognition unavailable"
        case .permissionDenied: return "Microphone or speech recognition permission denied"
        }
    }
}
