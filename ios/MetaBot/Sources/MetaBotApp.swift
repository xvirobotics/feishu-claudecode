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

    // Handle notification tap → navigate to the correct chat
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let userInfo = response.notification.request.content.userInfo
        if let chatId = userInfo["chatId"] as? String {
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
}

// MARK: - App Entry Point

@main
struct MetaBotApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
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
            .tint(Color(red: 0.063, green: 0.725, blue: 0.506)) // #10b981 emerald
            .onAppear {
                // Wire push service to AppDelegate
                appDelegate.pushService = appState.pushService
                UNUserNotificationCenter.current().delegate = appDelegate
            }
            .onReceive(NotificationCenter.default.publisher(for: .navigateToChat)) { notification in
                if let chatId = notification.userInfo?["chatId"] as? String {
                    appState.selectSession(chatId)
                }
            }
        }
    }
}
