import AVFoundation
import CallKit
import Foundation
import Observation

/// Manages CallKit integration for native incoming call UI.
/// Singleton -- initialized once at app launch.
@Observable
final class CallKitService: NSObject {
    static let shared = CallKitService()

    /// The currently active (answered) call, observed by MainTabView to show RtcCallView
    var activeCall: IncomingVoiceCall?
    /// UUID of the active CallKit call
    private(set) var activeCallUUID: UUID?

    private let provider: CXProvider
    private let callController = CXCallController()
    /// Cache: CallKit UUID -> IncomingVoiceCall data (from VoIP push payload)
    private(set) var pendingCalls: [UUID: IncomingVoiceCall] = [:]

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

    /// End the current call (called from RtcCallView when user hangs up)
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
    /// For incoming calls, the connected state is set when CXAnswerCallAction is fulfilled.
    /// This sends an update to refresh the call info if needed.
    func reportCallConnected() {
        guard let uuid = activeCallUUID else { return }
        let update = CXCallUpdate()
        update.hasVideo = false
        provider.reportCall(with: uuid, updated: update)
    }

    /// Report that the call has ended from the remote side
    func reportCallEnded(reason: CXCallEndedReason = .remoteEnded) {
        guard let uuid = activeCallUUID else { return }
        provider.reportCall(with: uuid, endedAt: Date(), reason: reason)
        activeCall = nil
        activeCallUUID = nil
    }
}

// MARK: - CXProviderDelegate

extension CallKitService: CXProviderDelegate {
    func providerDidReset(_ provider: CXProvider) {
        activeCall = nil
        activeCallUUID = nil
        pendingCalls.removeAll()
    }

    func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        guard let call = pendingCalls[action.callUUID] else {
            action.fail()
            return
        }

        activeCallUUID = action.callUUID
        activeCall = call
        pendingCalls.removeValue(forKey: action.callUUID)
        action.fulfill()
    }

    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        pendingCalls.removeValue(forKey: action.callUUID)
        if activeCallUUID == action.callUUID {
            activeCall = nil
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
