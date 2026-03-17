import AVFoundation
import CallKit
import Foundation
import Observation
import VolcEngineRTC

/// Manages CallKit integration for native incoming call UI.
/// When user accepts a CallKit call, RTC audio is connected directly
/// in the background — no in-app UI needed (CallKit provides the call UI).
@Observable
final class CallKitService: NSObject {
    static let shared = CallKitService()

    /// UUID of the active CallKit call
    private(set) var activeCallUUID: UUID?
    /// Whether a CallKit call is in progress
    var isCallActive: Bool { activeCallUUID != nil }

    private let provider: CXProvider
    private let callController = CXCallController()
    /// Cache: CallKit UUID → IncomingVoiceCall data (from VoIP push payload)
    private(set) var pendingCalls: [UUID: IncomingVoiceCall] = [:]

    /// RTC state for the active CallKit call (managed here, not by RtcCallView)
    private var rtcEngine: ByteRTCEngine?
    private var rtcRoom: ByteRTCRoom?
    private var callInfo: IncomingVoiceCall?

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

    /// End the current call
    func endCurrentCall() {
        guard let uuid = activeCallUUID else { return }
        let action = CXEndCallAction(call: uuid)
        callController.request(CXTransaction(action: action)) { error in
            if let error {
                print("[CallKit] End call error: \(error)")
            }
        }
    }

    // MARK: - RTC Connection (background, no UI)

    private func connectRTC(call: IncomingVoiceCall) {
        callInfo = call
        print("[CallKit] Connecting RTC: room=\(call.roomId)")

        let engineCfg = ByteRTCEngineConfig()
        engineCfg.appID = call.appId
        rtcEngine = ByteRTCEngine.createRTCEngine(engineCfg, delegate: self)

        // Audio processing
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
        rtcEngine?.startAudioCapture()
    }

    private func disconnectRTC() {
        rtcEngine?.stopAudioCapture()
        rtcRoom?.leave()
        rtcRoom?.destroy()
        ByteRTCEngine.destroyRTCEngine()
        rtcEngine = nil
        rtcRoom = nil
        callInfo = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
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
        pendingCalls.removeValue(forKey: action.callUUID)
        action.fulfill()

        // Connect RTC audio in background — no app UI needed
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

    func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        print("[CallKit] Audio session activated")
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
        endCurrentCall()
    }
}

// MARK: - ByteRTCRoomDelegate

extension CallKitService: ByteRTCRoomDelegate {
    func rtcRoom(_ rtcRoom: ByteRTCRoom, onRoomStateChanged roomId: String, withUid uid: String, state: Int, extraInfo: String) {
        if state == 0 {
            print("[CallKit RTC] Connected to room")
            // Report to CallKit that call is connected
            if let uuid = activeCallUUID {
                provider.reportOutgoingCall(with: uuid, connectedAt: Date())
            }
        } else if state < 0 {
            print("[CallKit RTC] Room error: \(state)")
            endCurrentCall()
        }
    }

    func rtcRoom(_ rtcRoom: ByteRTCRoom, onUserJoined userInfo: ByteRTCUserInfo) {
        print("[CallKit RTC] User joined: \(userInfo.userId)")
    }

    func rtcRoom(_ rtcRoom: ByteRTCRoom, onUserLeave uid: String, reason: ByteRTCUserOfflineReason) {
        if uid == callInfo?.aiUserId {
            print("[CallKit RTC] AI disconnected")
            endCurrentCall()
        }
    }

    func rtcRoom(_ rtcRoom: ByteRTCRoom, onRoomBinaryMessageReceived uid: String, message: Data) {
        // Subtitles — not displayed in CallKit mode, just log
    }
}
