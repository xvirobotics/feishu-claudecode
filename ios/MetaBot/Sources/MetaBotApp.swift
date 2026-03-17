import SwiftUI
import UserNotifications

// MARK: - App Delegate (Push Notification Handling)

class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    var pushService: PushNotificationService?

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

    // Handle notification tap → navigate to chat or accept call
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let userInfo = response.notification.request.content.userInfo
        let type = userInfo["type"] as? String

        if type == "incoming_call" {
            // Store for cold launch — AppState will pick it up
            AppDelegate.pendingCallData = userInfo as? [String: String]
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
                UNUserNotificationCenter.current().delegate = appDelegate
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
