import Foundation
import Observation
import UIKit
import UserNotifications

/// Manages APNs push notification lifecycle:
/// - Permission request + remote notification registration
/// - Device token → server registration per chatId
/// - Local notification fallback for background WebSocket events
@Observable
final class PushNotificationService: NSObject {
    private(set) var deviceToken: String?
    private(set) var permissionGranted = false

    private var serverURL: String = ""
    private var authToken: String = ""
    /// chatIds registered for push on this device
    private var registeredChatIds = Set<String>()

    // MARK: - Permission & Registration

    /// Request notification permission and register for remote notifications.
    func requestPermission() async {
        let center = UNUserNotificationCenter.current()
        do {
            let granted = try await center.requestAuthorization(options: [.alert, .sound, .badge])
            await MainActor.run {
                self.permissionGranted = granted
                if granted {
                    UIApplication.shared.registerForRemoteNotifications()
                }
            }
        } catch {
            print("[Push] Permission error: \(error)")
        }
    }

    /// Called from AppDelegate when APNs provides the device token.
    func didRegisterForRemoteNotifications(deviceToken data: Data) {
        let token = data.map { String(format: "%02.2hhx", $0) }.joined()
        self.deviceToken = token
        print("[Push] Device token: \(token.prefix(16))...")

        // Re-register all previously registered chatIds with new token
        for chatId in registeredChatIds {
            registerWithServer(chatId: chatId)
        }
    }

    /// Called from AppDelegate when registration fails.
    func didFailToRegisterForRemoteNotifications(error: Error) {
        print("[Push] Registration failed: \(error.localizedDescription)")
    }

    // MARK: - Server Registration

    /// Configure server connection info.
    func configure(serverURL: String, token: String) {
        self.serverURL = serverURL
        self.authToken = token
    }

    /// Register this device for push notifications for a chatId.
    /// Called lazily when user interacts with a chat.
    func registerForChat(chatId: String) {
        guard !chatId.isEmpty else { return }
        registeredChatIds.insert(chatId)
        guard deviceToken != nil else { return }
        registerWithServer(chatId: chatId)
    }

    /// Unregister this device from all push notifications (e.g., on logout).
    func unregisterAll() {
        guard let deviceToken, !serverURL.isEmpty else { return }
        guard let url = URL(string: "\(serverURL)/api/devices/register") else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["deviceToken": deviceToken])
        URLSession.shared.dataTask(with: request).resume()
        registeredChatIds.removeAll()
    }

    // MARK: - Local Notification (background WebSocket fallback)

    /// Post a local notification when app is in background and receives task completion via WebSocket.
    func postLocalNotification(title: String, body: String, chatId: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        content.threadIdentifier = chatId
        content.userInfo = ["chatId": chatId]

        let request = UNNotificationRequest(
            identifier: "task-\(chatId)-\(Date().timeIntervalSince1970)",
            content: content,
            trigger: nil // Deliver immediately
        )
        UNUserNotificationCenter.current().add(request)
    }

    // MARK: - Private

    private func registerWithServer(chatId: String) {
        guard let deviceToken, !serverURL.isEmpty else { return }
        guard let url = URL(string: "\(serverURL)/api/devices/register") else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "deviceToken": deviceToken,
            "chatId": chatId,
        ])

        URLSession.shared.dataTask(with: request) { _, response, error in
            if let error {
                print("[Push] Register error: \(error.localizedDescription)")
            } else if let http = response as? HTTPURLResponse, http.statusCode == 200 {
                print("[Push] Registered for chat: \(chatId.prefix(16))")
            }
        }.resume()
    }
}
