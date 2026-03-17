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
        return true
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

    /// Pending Quick Action bot name (set when user long-presses app icon)
    static var pendingQuickAction: String?

    func application(
        _ application: UIApplication,
        performActionFor shortcutItem: UIApplicationShortcutItem,
        completionHandler: @escaping (Bool) -> Void
    ) {
        let prefix = "com.xvirobotics.MetaBot.call."
        if shortcutItem.type.hasPrefix(prefix) {
            let botName = String(shortcutItem.type.dropFirst(prefix.count))
            AppDelegate.pendingQuickAction = botName
        }
        completionHandler(true)
    }
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
            .task {
                // Cold launch: check for pending actions (VoIP push, Quick Action, Siri)
                try? await Task.sleep(for: .seconds(1.5))
                await MainActor.run {
                    // VoIP push incoming call
                    if let data = AppDelegate.pendingCallData {
                        AppDelegate.pendingCallData = nil
                        appState.incomingVoiceCall = Self.parseCallFromDict(data)
                    }
                    // Quick Action: outgoing call
                    if let botName = AppDelegate.pendingQuickAction {
                        AppDelegate.pendingQuickAction = nil
                        appState.initiateOutgoingCall(botName: botName)
                    }
                    // Siri: outgoing call
                    if let botName = CallBotIntent.pendingCallBot {
                        CallBotIntent.pendingCallBot = nil
                        appState.initiateOutgoingCall(botName: botName)
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
