import Foundation
import Observation
import PushKit
import UIKit
import UserNotifications

/// Manages APNs push notification lifecycle:
/// - Permission request + remote notification registration
/// - Device token → server registration per chatId
/// - Local notification fallback for background WebSocket events
@Observable
final class PushNotificationService: NSObject {
    private(set) var deviceToken: String?
    private(set) var voipToken: String?
    private(set) var permissionGranted = false

    private var serverURL: String = ""
    private var authToken: String = ""
    /// chatIds registered for push on this device
    private var registeredChatIds = Set<String>()
    private var voipRegistry: PKPushRegistry?

    // MARK: - Permission & Registration

    /// Notification category for incoming calls
    static let incomingCallCategory = "INCOMING_CALL"

    /// Request notification permission and register for remote notifications.
    func requestPermission() async {
        let center = UNUserNotificationCenter.current()

        // Register call notification category with Accept/Reject actions
        let acceptAction = UNNotificationAction(
            identifier: "ACCEPT_CALL",
            title: "Accept",
            options: [.foreground]
        )
        let rejectAction = UNNotificationAction(
            identifier: "REJECT_CALL",
            title: "Decline",
            options: [.destructive]
        )
        let callCategory = UNNotificationCategory(
            identifier: Self.incomingCallCategory,
            actions: [acceptAction, rejectAction],
            intentIdentifiers: [],
            options: []
        )
        center.setNotificationCategories([callCategory])

        do {
            let granted = try await center.requestAuthorization(options: [.alert, .sound, .badge])
            await MainActor.run {
                self.permissionGranted = granted
                if granted {
                    UIApplication.shared.registerForRemoteNotifications()
                }

                // Register for VoIP push (PushKit)
                let registry = PKPushRegistry(queue: .main)
                registry.delegate = self
                registry.desiredPushTypes = [.voIP]
                self.voipRegistry = registry
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
        if deviceToken != nil {
            registerWithServer(chatId: chatId)
        }
        if voipToken != nil {
            registerVoIPTokenWithServer(chatId: chatId)
        }
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

    private func registerVoIPTokenWithServer(chatId: String) {
        guard let voipToken, !serverURL.isEmpty else { return }
        guard let url = URL(string: "\(serverURL)/api/devices/register") else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "deviceToken": voipToken,
            "chatId": chatId,
            "tokenType": "voip",
        ])

        URLSession.shared.dataTask(with: request) { _, response, error in
            if let error {
                print("[Push] VoIP register error: \(error.localizedDescription)")
            } else if let http = response as? HTTPURLResponse, http.statusCode == 200 {
                print("[Push] VoIP registered for chat: \(chatId.prefix(16))")
            }
        }.resume()
    }
}

// MARK: - PKPushRegistryDelegate

extension PushNotificationService: PKPushRegistryDelegate {
    func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
        guard type == .voIP else { return }
        let token = pushCredentials.token.map { String(format: "%02.2hhx", $0) }.joined()
        print("[Push] VoIP token: \(token.prefix(16))...")
        voipToken = token
        // Register VoIP token for all known chatIds
        for chatId in registeredChatIds {
            registerVoIPTokenWithServer(chatId: chatId)
        }
    }

    func pushRegistry(
        _ registry: PKPushRegistry,
        didReceiveIncomingPushWith payload: PKPushPayload,
        for type: PKPushType,
        completion: @escaping () -> Void
    ) {
        guard type == .voIP else { completion(); return }
        let data = payload.dictionaryPayload

        let call = IncomingVoiceCall(
            sessionId: data["sessionId"] as? String ?? "",
            roomId: data["roomId"] as? String ?? "",
            token: data["token"] as? String ?? "",
            appId: data["appId"] as? String ?? "",
            userId: data["userId"] as? String ?? "",
            aiUserId: data["aiUserId"] as? String ?? "",
            chatId: data["chatId"] as? String ?? "",
            botName: data["botName"] as? String ?? "Voice Call",
            prompt: data["prompt"] as? String
        )

        // Report to CallKit immediately (Apple enforces a ~5-second deadline)
        CallKitService.shared.reportIncomingCall(call: call) { _ in
            completion()
        }
    }

    func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
        guard type == .voIP else { return }
        voipToken = nil
    }
}
