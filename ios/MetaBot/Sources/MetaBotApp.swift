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

        if type == "incoming_call",
           let sessionId = userInfo["sessionId"] as? String,
           let roomId = userInfo["roomId"] as? String,
           let token = userInfo["token"] as? String,
           let appId = userInfo["appId"] as? String,
           let userId = userInfo["userId"] as? String,
           let aiUserId = userInfo["aiUserId"] as? String {
            let chatId = userInfo["chatId"] as? String ?? ""
            let botName = userInfo["botName"] as? String ?? "Voice Call"
            await MainActor.run {
                NotificationCenter.default.post(
                    name: .incomingCallFromPush,
                    object: nil,
                    userInfo: [
                        "sessionId": sessionId, "roomId": roomId, "token": token,
                        "appId": appId, "userId": userId, "aiUserId": aiUserId,
                        "chatId": chatId, "botName": botName,
                    ]
                )
            }
        } else if let chatId = userInfo["chatId"] as? String {
            await MainActor.run {
                NotificationCenter.default.post(
                    name: .navigateToChat,
                    object: nil,
                    userInfo: ["chatId": chatId]
                )
            }
        }
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
                guard let info = notification.userInfo else { return }
                let call = IncomingVoiceCall(
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
                appState.incomingVoiceCall = call
            }
        }
    }
}
