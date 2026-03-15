import AVFoundation
import Speech

/// Voice recording and speech recognition service
@Observable
final class VoiceService {
    private(set) var isRecording = false
    private(set) var transcribedText = ""
    private(set) var audioLevel: Float = 0
    private(set) var permissionGranted = false

    private var audioEngine: AVAudioEngine?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private let speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: "zh-Hans"))

    private var recordedData = Data()
    private var audioFile: AVAudioFile?
    private var recordingURL: URL?

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

    /// Start recording audio with real-time speech recognition
    func startRecording() throws {
        stopRecording()

        let audioSession = AVAudioSession.sharedInstance()
        try audioSession.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetooth])
        try audioSession.setActive(true, options: .notifyOthersOnDeactivation)

        audioEngine = AVAudioEngine()
        guard let audioEngine, let speechRecognizer, speechRecognizer.isAvailable else {
            throw VoiceServiceError.unavailable
        }

        // Set up recording file
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("metabot_recording_\(UUID().uuidString).m4a")
        recordingURL = url

        // Recognition
        recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
        guard let recognitionRequest else { throw VoiceServiceError.unavailable }
        recognitionRequest.shouldReportPartialResults = true

        recognitionTask = speechRecognizer.recognitionTask(with: recognitionRequest) { [weak self] result, error in
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

    /// Stop recording and return the audio file URL
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
