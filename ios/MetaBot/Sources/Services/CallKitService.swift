import AVFoundation
import CallKit
import Foundation
import Observation
import VolcEngineRTC

/// Manages CallKit integration for incoming and outgoing calls.
/// Incoming: VoIP push → CallKit UI → answer → RTC audio connected here.
/// Outgoing: Phone app recents → CXStartCallAction → creates RTC room → connects.
/// No RtcCallView is shown — the native phone UI handles mute/speaker/hangup.
/// Singleton -- initialized once at app launch.
@Observable
final class CallKitService: NSObject {
    static let shared = CallKitService()

    /// UUID of the active CallKit call
    private(set) var activeCallUUID: UUID?

    private let provider: CXProvider
    private let callController = CXCallController()
    /// Cache: CallKit UUID -> IncomingVoiceCall data (from VoIP push payload)
    private var pendingCalls: [UUID: IncomingVoiceCall] = [:]

    // RTC state for CallKit-managed calls
    private var rtcEngine: ByteRTCEngine?
    private var rtcRoom: ByteRTCRoom?
    private var currentCall: IncomingVoiceCall?
    private var transcript: [RtcAPIService.TranscriptEntry] = []
    private var isOutgoingCall = false
    private var audioSessionActivated = false

    /// Server credentials for transcript submission (set by AppState.connect)
    var serverURL: String = ""
    var authToken: String = ""

    /// Called on main thread when a CallKit-managed call ends. Parameters: (transcriptText, call)
    var onCallEnded: ((String?, IncomingVoiceCall?) -> Void)?

    /// Called to build system prompt for outgoing calls. Parameters: (botName) -> systemPrompt?
    var onBuildSystemPrompt: ((String) -> String?)?

    private override init() {
        let config = CXProviderConfiguration(localizedName: "MetaBot")
        config.supportsVideo = false
        config.maximumCallsPerCallGroup = 1
        config.maximumCallGroups = 1
        config.supportedHandleTypes = [.generic]
        config.includesCallsInRecents = true
        if let ringtoneURL = Bundle.main.url(forResource: "ringtone", withExtension: "caf") {
            config.ringtoneSound = ringtoneURL.lastPathComponent
        }

        self.provider = CXProvider(configuration: config)
        super.init()
        provider.setDelegate(self, queue: .main)
    }

    /// Report an incoming call to CallKit (called from PushKit handler, must complete fast)
    func reportIncomingCall(call: IncomingVoiceCall, completion: ((Error?) -> Void)? = nil) {
        let uuid = UUID()
        pendingCalls[uuid] = call

        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: call.botName)
        update.localizedCallerName = call.botName
        update.hasVideo = false
        update.supportsGrouping = false
        update.supportsUngrouping = false
        update.supportsHolding = false
        update.supportsDTMF = false

        provider.reportNewIncomingCall(with: uuid, update: update) { [weak self] error in
            if let error {
                print("[CallKit] Report incoming call error: \(error)")
                self?.pendingCalls.removeValue(forKey: uuid)
            }
            completion?(error)
        }
    }

    /// End the current call (called when user hangs up)
    func endCurrentCall() {
        guard let uuid = activeCallUUID else { return }
        let action = CXEndCallAction(call: uuid)
        callController.request(CXTransaction(action: action)) { error in
            if let error {
                print("[CallKit] End call error: \(error)")
            }
        }
    }

    /// Report that the call has connected (called after RTC room is joined).
    func reportCallConnected() {
        guard let uuid = activeCallUUID else { return }
        if isOutgoingCall {
            provider.reportOutgoingCall(with: uuid, connectedAt: Date())
        } else {
            // Incoming call — notify CallKit that audio is connected
            let update = CXCallUpdate()
            update.hasVideo = false
            provider.reportCall(with: uuid, updated: update)
        }
    }

    /// Report that the call has ended from the remote side
    func reportCallEnded(reason: CXCallEndedReason = .remoteEnded) {
        guard let uuid = activeCallUUID else { return }
        provider.reportCall(with: uuid, endedAt: Date(), reason: reason)
        disconnectRTC()
        activeCallUUID = nil
    }

    // MARK: - RTC Connection (for CallKit-managed calls)

    private func connectRTC(call: IncomingVoiceCall) {
        currentCall = call

        let engineCfg = ByteRTCEngineConfig()
        engineCfg.appID = call.appId
        rtcEngine = ByteRTCEngine.createRTCEngine(engineCfg, delegate: self)

        rtcEngine?.setAudioScenario(.aiClient)
        rtcEngine?.setAudioProfile(.standard)
        rtcEngine?.setAnsMode(.automatic)

        rtcRoom = rtcEngine?.createRTCRoom(call.roomId)
        rtcRoom?.delegate = self

        let userInfo = ByteRTCUserInfo()
        userInfo.userId = call.userId
        userInfo.extraInfo = "{\"call_scene\":\"RTC-AIGC\",\"user_name\":\"\(call.userId)\",\"user_id\":\"\(call.userId)\"}"

        let roomCfg = ByteRTCRoomConfig()
        roomCfg.profile = .communication
        roomCfg.isPublishAudio = true

        rtcRoom?.joinRoom(call.token, userInfo: userInfo, userVisibility: true, roomConfig: roomCfg)
        // Audio capture starts in didActivate(audioSession:) callback
    }

    private func disconnectRTC() {
        let call = currentCall
        let collectedTranscript = transcript
        let url = serverURL
        let token = authToken
        let wasOutgoing = isOutgoingCall

        // Cleanup RTC
        rtcEngine?.stopAudioCapture()
        rtcRoom?.leave()
        rtcRoom?.destroy()
        ByteRTCEngine.destroyRTCEngine()
        rtcEngine = nil
        rtcRoom = nil
        currentCall = nil
        transcript = []
        isOutgoingCall = false
        audioSessionActivated = false

        // Format transcript (same format as RtcVoiceService)
        let transcriptText: String? = collectedTranscript.isEmpty ? nil :
            collectedTranscript.map { "[\($0.speaker == "ai" ? "AI" : "User")]: \($0.text)" }
                .joined(separator: "\n")

        // Submit transcript to server & stop session (fire-and-forget)
        if let call, !url.isEmpty {
            let api = RtcAPIService(serverURL: url, token: token)
            Task {
                if !collectedTranscript.isEmpty {
                    try? await api.submitTranscript(sessionId: call.sessionId, transcript: collectedTranscript)
                }
                try? await api.stopCall(sessionId: call.sessionId)
            }
        }

        // Only inject transcript for outgoing calls (user-initiated from Phone recents).
        // Incoming calls: agent already gets transcript via --wait, no need to inject.
        if wasOutgoing {
            onCallEnded?(transcriptText, call)
        }
    }
}

// MARK: - CXProviderDelegate

extension CallKitService: CXProviderDelegate {
    func providerDidReset(_ provider: CXProvider) {
        disconnectRTC()
        activeCallUUID = nil
        pendingCalls.removeAll()
    }

    func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        guard let call = pendingCalls[action.callUUID] else {
            action.fail()
            return
        }

        activeCallUUID = action.callUUID
        isOutgoingCall = false
        pendingCalls.removeValue(forKey: action.callUUID)
        action.fulfill()

        // Connect RTC audio directly — no app UI needed
        connectRTC(call: call)
    }

    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        pendingCalls.removeValue(forKey: action.callUUID)
        if activeCallUUID == action.callUUID {
            disconnectRTC()
            activeCallUUID = nil
        }
        action.fulfill()
    }

    func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        let botName = action.handle.value
        let uuid = action.callUUID
        print("[CallKit] CXStartCallAction received — botName: \(botName), uuid: \(uuid)")
        print("[CallKit] serverURL: \(serverURL.isEmpty ? "EMPTY" : serverURL), authToken: \(authToken.isEmpty ? "EMPTY" : "set")")

        // Fulfill immediately to satisfy CallKit's ~10s timeout
        activeCallUUID = uuid
        isOutgoingCall = true
        provider.reportOutgoingCall(with: uuid, startedConnectingAt: Date())
        action.fulfill()

        // Create RTC room asynchronously
        startOutgoingCall(uuid: uuid, botName: botName)
    }

    private func startOutgoingCall(uuid: UUID, botName: String) {
        guard !serverURL.isEmpty, !authToken.isEmpty else {
            print("[CallKit] Outgoing call failed: no server credentials")
            provider.reportCall(with: uuid, endedAt: Date(), reason: .failed)
            activeCallUUID = nil
            return
        }

        let chatId = "callkit_\(uuid.uuidString.prefix(8).lowercased())"
        let api = RtcAPIService(serverURL: serverURL, token: authToken)
        let systemPrompt = onBuildSystemPrompt?(botName)

        Task {
            do {
                let response = try await api.startCall(botName: botName, chatId: chatId, systemPrompt: systemPrompt)
                let call = IncomingVoiceCall(
                    sessionId: response.sessionId, roomId: response.roomId,
                    token: response.token, appId: response.appId,
                    userId: response.userId, aiUserId: response.aiUserId,
                    chatId: chatId, botName: botName, prompt: nil
                )
                await MainActor.run { self.connectRTC(call: call) }
            } catch {
                print("[CallKit] Outgoing call failed: \(error)")
                await MainActor.run {
                    self.provider.reportCall(with: uuid, endedAt: Date(), reason: .failed)
                    self.activeCallUUID = nil
                }
            }
        }
    }

    func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        print("[CallKit] Audio session activated, engine exists: \(rtcEngine != nil)")
        audioSessionActivated = true
        // Start audio capture if engine is already ready (incoming calls)
        // For outgoing calls, engine may not exist yet — startAudioCapture called from onRoomStateChanged
        rtcEngine?.startAudioCapture()
    }

    func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        print("[CallKit] Audio session deactivated")
    }

    func provider(_ provider: CXProvider, timedOutPerforming action: CXAction) {
        action.fulfill()
    }
}

// MARK: - ByteRTCEngineDelegate

extension CallKitService: ByteRTCEngineDelegate {
    func rtcEngine(_ engine: ByteRTCEngine, onError errorCode: ByteRTCErrorCode) {
        print("[CallKit RTC] Engine error: \(errorCode.rawValue)")
        reportCallEnded(reason: .failed)
    }
}

// MARK: - ByteRTCRoomDelegate

extension CallKitService: ByteRTCRoomDelegate {
    func rtcRoom(_ rtcRoom: ByteRTCRoom, onRoomStateChanged roomId: String, withUid uid: String, state: Int, extraInfo: String) {
        if state == 0 {
            print("[CallKit RTC] Connected to room, audioActivated: \(audioSessionActivated)")
            // For outgoing calls: audio session was activated before engine existed, start capture now
            if audioSessionActivated {
                rtcEngine?.startAudioCapture()
            }
            reportCallConnected()
        } else if state < 0 {
            print("[CallKit RTC] Room error: \(state)")
            reportCallEnded(reason: .failed)
        }
    }

    func rtcRoom(_ rtcRoom: ByteRTCRoom, onUserJoined userInfo: ByteRTCUserInfo) {
        // AI user joined
    }

    func rtcRoom(_ rtcRoom: ByteRTCRoom, onUserLeave uid: String, reason: ByteRTCUserOfflineReason) {
        if uid == currentCall?.aiUserId {
            // AI left — end the CallKit call
            reportCallEnded(reason: .remoteEnded)
        }
    }

    func rtcRoom(_ rtcRoom: ByteRTCRoom, onRoomBinaryMessageReceived uid: String, message: Data) {
        // Collect subtitles for transcript (reuses parseSubtitle from RtcVoiceService.swift)
        guard let subtitle = parseSubtitle(from: message), subtitle.type == "subtitle" else { return }
        for entry in subtitle.data {
            if entry.paragraph && entry.definite && !entry.text.trimmingCharacters(in: .whitespaces).isEmpty {
                let speaker = entry.userId == currentCall?.aiUserId ? "ai" : "user"
                transcript.append(RtcAPIService.TranscriptEntry(
                    speaker: speaker,
                    text: entry.text.trimmingCharacters(in: .whitespaces),
                    timestamp: Date().timeIntervalSince1970 * 1000
                ))
            }
        }
    }
}
