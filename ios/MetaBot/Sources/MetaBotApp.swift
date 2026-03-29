import CallKit
import Intents
import SwiftUI
import UserNotifications

// MARK: - App Delegate (Push Notification Handling)

class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    var pushService: PushNotificationService?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        // Set delegate early so cold-launch notification taps are handled
        UNUserNotificationCenter.current().delegate = self
        // Register CallKit provider before iOS delivers any pending CXStartCallAction (cold-launch callback)
        _ = CallKitService.shared
        return true
    }

    // Handle callback from Phone app recent calls (INStartCallIntent user activity)
    func application(
        _ application: UIApplication,
        continue userActivity: NSUserActivity,
        restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void
    ) -> Bool {
        let type = userActivity.activityType
        print("[AppDelegate] continue userActivity: \(type)")
        print("[AppDelegate] userInfo: \(userActivity.userInfo ?? [:])")
        // CallKit handles via CXStartCallAction delegate. Accept the activity so iOS doesn't error.
        return type.contains("StartCall") || type.contains("StartAudio")
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        pushService?.didRegisterForRemoteNotifications(deviceToken: deviceToken)
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        pushService?.didFailToRegisterForRemoteNotifications(error: error)
    }

    // Show notification banner even when app is in foreground
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        return [.banner, .sound]
    }

    // Handle notification tap or action button
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let userInfo = response.notification.request.content.userInfo
        let type = userInfo["type"] as? String
        let actionId = response.actionIdentifier

        if type == "incoming_call" {
            // Reject action — just dismiss, don't open call
            if actionId == "REJECT_CALL" { return }

            // Accept action or default tap — open incoming call screen
            let callInfo = userInfo.reduce(into: [String: String]()) { dict, pair in
                if let key = pair.key as? String, let val = pair.value as? String {
                    dict[key] = val
                }
            }
            AppDelegate.pendingCallData = callInfo
            await MainActor.run {
                NotificationCenter.default.post(name: .incomingCallFromPush, object: nil, userInfo: userInfo)
            }
        } else if let chatId = userInfo["chatId"] as? String {
            await MainActor.run {
                NotificationCenter.default.post(name: .navigateToChat, object: nil, userInfo: ["chatId": chatId])
            }
        }
    }

    /// Pending call data from push notification (survives cold launch)
    static var pendingCallData: [String: String]?
}

extension Notification.Name {
    static let navigateToChat = Notification.Name("navigateToChat")
    static let incomingCallFromPush = Notification.Name("incomingCallFromPush")
}

// MARK: - App Entry Point

@main
struct MetaBotApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @Environment(\.scenePhase) private var scenePhase
    @State private var appState = AppState()

    var body: some Scene {
        WindowGroup {
            Group {
                if appState.auth.isAuthenticated {
                    GeometryReader { geo in
                        if geo.size.width > 700 {
                            // iPad / landscape: split view
                            MainTabView()
                        } else {
                            // iPhone: tab-based mobile layout
                            MobileTabView()
                        }
                    }
                    .onAppear {
                        appState.connect()
                    }
                } else {
                    LoginView()
                }
            }
            .environment(appState)
            .preferredColorScheme(appState.colorScheme)
            .tint(NexusColors.accent)
            .id(appState.fontScale) // Force full re-render when font scale changes
            .onAppear {
                // Wire push service to AppDelegate
                appDelegate.pushService = appState.pushService
            }
            .onChange(of: scenePhase) { _, newPhase in
                if newPhase == .active {
                    appState.handleForegroundReturn()
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: .navigateToChat)) { notification in
                if let chatId = notification.userInfo?["chatId"] as? String {
                    appState.selectSession(chatId)
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: .incomingCallFromPush)) { notification in
                if let info = notification.userInfo {
                    appState.incomingVoiceCall = Self.parseCallFromUserInfo(info)
                }
            }
            // Handle "call back" from Phone app recent calls
            .onContinueUserActivity("INStartCallIntent") { userActivity in
                print("[MetaBotApp] INStartCallIntent received")
                Self.handleStartCallIntent(userActivity)
            }
            .onContinueUserActivity("INStartAudioCallIntent") { userActivity in
                print("[MetaBotApp] INStartAudioCallIntent received")
                Self.handleStartCallIntent(userActivity)
            }
            .task {
                // Cold launch: check if app was opened from a call push notification
                if let data = AppDelegate.pendingCallData {
                    AppDelegate.pendingCallData = nil
                    try? await Task.sleep(for: .seconds(1.5))
                    await MainActor.run {
                        appState.incomingVoiceCall = Self.parseCallFromDict(data)
                    }
                }
            }
        }
    }

    private static func parseCallFromUserInfo(_ info: [AnyHashable: Any]) -> IncomingVoiceCall {
        IncomingVoiceCall(
            sessionId: info["sessionId"] as? String ?? "",
            roomId: info["roomId"] as? String ?? "",
            token: info["token"] as? String ?? "",
            appId: info["appId"] as? String ?? "",
            userId: info["userId"] as? String ?? "",
            aiUserId: info["aiUserId"] as? String ?? "",
            chatId: info["chatId"] as? String ?? "",
            botName: info["botName"] as? String ?? "Voice Call",
            prompt: nil
        )
    }

    /// Handle INStartCallIntent from Phone app recents — extract bot name and trigger CXStartCallAction
    private static func handleStartCallIntent(_ userActivity: NSUserActivity) {
        var botName: String?

        // Try to extract from INStartCallIntent
        if let interaction = userActivity.interaction,
           let intent = interaction.intent as? INStartCallIntent,
           let contact = intent.contacts?.first {
            botName = contact.personHandle?.value
            print("[MetaBotApp] Intent contact handle: \(botName ?? "nil")")
        }

        // Fallback: try INStartAudioCallIntent (older iOS)
        if botName == nil, let interaction = userActivity.interaction,
           let intent = interaction.intent as? INStartAudioCallIntent,
           let contact = intent.contacts?.first {
            botName = contact.personHandle?.value
        }

        // Fallback: check userInfo
        if botName == nil {
            botName = userActivity.userInfo?["handle"] as? String
        }

        guard let botName, !botName.isEmpty else {
            print("[MetaBotApp] Could not extract bot name from intent")
            return
        }

        print("[MetaBotApp] Starting outgoing call to: \(botName)")

        // Programmatically trigger CXStartCallAction → CallKitService handles it
        let handle = CXHandle(type: .generic, value: botName)
        let action = CXStartCallAction(call: UUID(), handle: handle)
        let transaction = CXTransaction(action: action)
        CXCallController().request(transaction) { error in
            if let error {
                print("[MetaBotApp] CXStartCallAction request failed: \(error)")
            }
        }
    }

    private static func parseCallFromDict(_ info: [String: String]) -> IncomingVoiceCall {
        IncomingVoiceCall(
            sessionId: info["sessionId"] ?? "",
            roomId: info["roomId"] ?? "",
            token: info["token"] ?? "",
            appId: info["appId"] ?? "",
            userId: info["userId"] ?? "",
            aiUserId: info["aiUserId"] ?? "",
            chatId: info["chatId"] ?? "",
            botName: info["botName"] ?? "Voice Call",
            prompt: nil
        )
    }
}
