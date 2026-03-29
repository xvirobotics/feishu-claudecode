import AVFoundation
import Foundation
import Observation
import VolcEngineRTC

// MARK: - Types

enum RtcCallPhase: Equatable {
    case idle
    case connecting
    case connected
    case ended
    case error(String)

    var displayText: String {
        switch self {
        case .idle: return ""
        case .connecting: return "Connecting..."
        case .connected: return "Connected"
        case .ended: return "Call Ended"
        case .error(let msg): return msg
        }
    }
}

struct RtcSessionInfo {
    let sessionId: String
    let roomId: String
    let taskId: String
    let token: String
    let appId: String
    let userId: String
    let aiUserId: String
}

// MARK: - TLV Subtitle Parsing

struct SubtitleEntry: Decodable {
    let text: String
    let userId: String
    let sequence: Int
    let definite: Bool
    let paragraph: Bool
    let roundId: Int?
    let language: String?
}

struct SubtitleData: Decodable {
    let type: String
    let data: [SubtitleEntry]
}

/// Parse TLV binary message: 4-byte magic "subv" + 4-byte big-endian length + JSON payload
func parseSubtitle(from data: Data) -> SubtitleData? {
    guard data.count >= 8 else { return nil }

    // Check magic bytes "subv"
    let magic = String(data: data[0..<4], encoding: .ascii)
    guard magic == "subv" else { return nil }

    // Read big-endian length
    let length = data[4..<8].withUnsafeBytes { ptr -> UInt32 in
        ptr.load(as: UInt32.self).bigEndian
    }
    guard data.count >= 8 + Int(length) else { return nil }

    // Parse JSON payload
    let jsonData = data[8..<(8 + Int(length))]
    return try? JSONDecoder().decode(SubtitleData.self, from: Data(jsonData))
}

// MARK: - RTC Voice Service

/// Manages Volcengine RTC voice call lifecycle.
/// Audio is captured/played by the RTC SDK (no local AVAudioEngine needed).
/// ASR -> LLM -> TTS all happens in Volcengine cloud.
@Observable
final class RtcVoiceService: NSObject {
    // Observable state
    private(set) var callPhase: RtcCallPhase = .idle
    private(set) var isMuted = false
    private(set) var subtitleText = ""
    private(set) var callStartTime: Date?
    private(set) var transcript: [RtcAPIService.TranscriptEntry] = []

    // Private state
    private var rtcEngine: ByteRTCEngine?
    private var rtcRoom: ByteRTCRoom?
    private var sessionInfo: RtcSessionInfo?
    private var apiService: RtcAPIService?

    func setError(_ message: String) {
        callPhase = .error(message)
    }

    // MARK: - Start Call (user-initiated)

    func startCall(
        serverURL: String,
        token: String,
        botName: String,
        chatId: String,
        systemPrompt: String? = nil,
        welcomeMessage: String? = nil
    ) async {
        await MainActor.run {
            callPhase = .connecting
            isMuted = false
            subtitleText = ""
            transcript = []
        }

        let api = RtcAPIService(serverURL: serverURL, token: token)
        self.apiService = api

        do {
            // 1. Call server to create RTC room + AI agent
            let response = try await api.startCall(
                botName: botName,
                chatId: chatId,
                systemPrompt: systemPrompt,
                welcomeMessage: welcomeMessage
            )

            let info = RtcSessionInfo(
                sessionId: response.sessionId,
                roomId: response.roomId,
                taskId: response.taskId,
                token: response.token,
                appId: response.appId,
                userId: response.userId,
                aiUserId: response.aiUserId
            )
            self.sessionInfo = info

            // 2. Join RTC room
            try await joinRtcRoom(info: info)

        } catch {
            await MainActor.run {
                callPhase = .error("Failed to start: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - Join Call (agent-initiated / incoming)

    func joinCall(incoming: IncomingVoiceCall, serverURL: String, token: String) async {
        await MainActor.run {
            callPhase = .connecting
            isMuted = false
            subtitleText = ""
            transcript = []
        }

        self.apiService = RtcAPIService(serverURL: serverURL, token: token)

        let info = RtcSessionInfo(
            sessionId: incoming.sessionId,
            roomId: incoming.roomId,
            taskId: "",
            token: incoming.token,
            appId: incoming.appId,
            userId: incoming.userId,
            aiUserId: incoming.aiUserId
        )
        self.sessionInfo = info

        do {
            try await joinRtcRoom(info: info)
        } catch {
            await MainActor.run {
                callPhase = .error("Failed to join: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - End Call

    func endCall() async -> String? {
        let info = sessionInfo
        let currentTranscript = transcript

        // Clean up RTC
        cleanupRtc()

        await MainActor.run {
            callPhase = .ended
            subtitleText = ""
        }

        guard let info, let api = apiService else { return nil }

        // Format transcript text
        let transcriptText = currentTranscript
            .map { "[\($0.speaker == "ai" ? "AI" : "User")]: \($0.text)" }
            .joined(separator: "\n")

        // Submit transcript to server
        if !currentTranscript.isEmpty {
            try? await api.submitTranscript(sessionId: info.sessionId, transcript: currentTranscript)
        }

        // Stop session
        try? await api.stopCall(sessionId: info.sessionId)

        sessionInfo = nil

        guard !transcriptText.isEmpty else { return nil }

        return "[语音通话记录]\n\n\(transcriptText)\n\n请根据以上语音对话内容，判断是否有需要执行的后续任务。如果对话中提到了具体的工作请求，请直接执行。如果只是闲聊，简单确认即可。"
    }

    // MARK: - Mute

    func toggleMute() {
        isMuted.toggle()
        if isMuted {
            rtcEngine?.stopAudioCapture()
        } else {
            rtcEngine?.startAudioCapture()
        }
    }

    // MARK: - Private: RTC Room

    private func joinRtcRoom(info: RtcSessionInfo) async throws {
        // Only configure audio session if CallKit is NOT managing it
        if CallKitService.shared.activeCallUUID == nil {
            let audioSession = AVAudioSession.sharedInstance()
            try audioSession.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetooth])
            try audioSession.setActive(true)
        }

        // Create engine
        let engineCfg = ByteRTCEngineConfig()
        engineCfg.appID = info.appId
        rtcEngine = ByteRTCEngine.createRTCEngine(engineCfg, delegate: self)

        // Configure audio processing — match web's echoCancellation/noiseSuppression/autoGainControl
        rtcEngine?.setAudioScenario(.aiClient)        // AIGC-optimized scenario
        rtcEngine?.setAudioProfile(.standard)          // Standard quality for voice
        rtcEngine?.setAnsMode(.automatic)              // Automatic noise suppression

        // Create and configure room
        rtcRoom = rtcEngine?.createRTCRoom(info.roomId)
        rtcRoom?.delegate = self

        // Configure user info with AIGC call scene
        let userInfo = ByteRTCUserInfo()
        userInfo.userId = info.userId
        userInfo.extraInfo = "{\"call_scene\":\"RTC-AIGC\",\"user_name\":\"\(info.userId)\",\"user_id\":\"\(info.userId)\"}"

        // Configure room
        let roomCfg = ByteRTCRoomConfig()
        roomCfg.profile = .communication
        roomCfg.isPublishAudio = true

        // Join room
        rtcRoom?.joinRoom(info.token, userInfo: userInfo, userVisibility: true, roomConfig: roomCfg)

        // Start audio capture
        rtcEngine?.startAudioCapture()

        // State will be updated in delegate callback (onRoomStateChanged)
    }

    private func cleanupRtc() {
        rtcEngine?.stopAudioCapture()
        rtcRoom?.leave()
        rtcRoom?.destroy()
        ByteRTCEngine.destroyRTCEngine()
        rtcEngine = nil
        rtcRoom = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    // MARK: - Subtitle Processing (called from RTC delegate)

    /// Process binary message received from RTC room (TLV subtitle format)
    func processRoomBinaryMessage(from uid: String, message: Data) {
        guard let subtitle = parseSubtitle(from: message),
              subtitle.type == "subtitle" else { return }

        for entry in subtitle.data {
            // Update live subtitle display
            if !entry.text.isEmpty {
                Task { @MainActor in
                    self.subtitleText = entry.text
                }
            }

            // Collect complete sentences for transcript
            if entry.paragraph && entry.definite && !entry.text.trimmingCharacters(in: .whitespaces).isEmpty {
                let speaker = entry.userId == sessionInfo?.aiUserId ? "ai" : "user"
                transcript.append(RtcAPIService.TranscriptEntry(
                    speaker: speaker,
                    text: entry.text.trimmingCharacters(in: .whitespaces),
                    timestamp: Date().timeIntervalSince1970 * 1000
                ))
            }
        }
    }
}

// MARK: - ByteRTCEngineDelegate

extension RtcVoiceService: ByteRTCEngineDelegate {
    func rtcEngine(_ engine: ByteRTCEngine, onError errorCode: ByteRTCErrorCode) {
        Task { @MainActor in
            self.callPhase = .error("RTC error: \(errorCode.rawValue)")
        }
    }
}

// MARK: - ByteRTCRoomDelegate

extension RtcVoiceService: ByteRTCRoomDelegate {
    func rtcRoom(_ rtcRoom: ByteRTCRoom, onRoomStateChanged roomId: String, withUid uid: String, state: Int, extraInfo: String) {
        if state == 0 {
            Task { @MainActor in
                self.callPhase = .connected
                self.callStartTime = Date()
            }
        } else if state < 0 {
            let errorMsg: String
            switch state {
            case -1000: errorMsg = "Invalid token"
            case -1004: errorMsg = "Duplicate login — another device already joined"
            case -1009: errorMsg = "Token expired"
            case -2001: errorMsg = "Failed to join room"
            default: errorMsg = "Room error: \(state)"
            }
            Task { @MainActor in
                self.callPhase = .error(errorMsg)
            }
        }
    }

    func rtcRoom(_ rtcRoom: ByteRTCRoom, onUserJoined userInfo: ByteRTCUserInfo) {
        // AI user joined
    }

    func rtcRoom(_ rtcRoom: ByteRTCRoom, onUserLeave uid: String, reason: ByteRTCUserOfflineReason) {
        if uid == sessionInfo?.aiUserId {
            Task { @MainActor in
                self.subtitleText = "AI disconnected"
            }
        }
    }

    func rtcRoom(_ rtcRoom: ByteRTCRoom, onRoomBinaryMessageReceived uid: String, message: Data) {
        processRoomBinaryMessage(from: uid, message: message)
    }
}
