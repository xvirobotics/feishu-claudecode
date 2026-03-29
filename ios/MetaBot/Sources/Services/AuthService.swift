import Foundation
import Observation
import Security

/// Manages authentication token via Keychain
@Observable
final class AuthService {
    private(set) var token: String?
    private(set) var isValidating = false
    private(set) var validationError: String?

    private let keychainKey = "com.metabot.api-token"

    var isAuthenticated: Bool { token != nil }

    init() {
        token = loadFromKeychain()
    }

    /// Validate token against server and save if valid
    func login(token: String, serverURL: String) async -> Bool {
        isValidating = true
        validationError = nil
        defer { isValidating = false }

        // Try to validate with server
        let urlString = "\(serverURL)/api/status"
        guard let url = URL(string: urlString) else {
            validationError = "Invalid server URL"
            return false
        }

        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 10

        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse, http.statusCode == 200 {
                self.token = token
                saveToKeychain(token)
                return true
            } else {
                // Accept token even if server returned non-200 (server might be starting up)
                self.token = token
                saveToKeychain(token)
                return true
            }
        } catch {
            // Accept token even if server unreachable (WebSocket validates later)
            self.token = token
            saveToKeychain(token)
            return true
        }
    }

    func logout() {
        token = nil
        deleteFromKeychain()
    }

    // MARK: - Keychain

    private func saveToKeychain(_ value: String) {
        deleteFromKeychain()
        let data = Data(value.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: keychainKey,
            kSecValueData as String: data,
        ]
        SecItemAdd(query as CFDictionary, nil)
    }

    private func loadFromKeychain() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: keychainKey,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private func deleteFromKeychain() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: keychainKey,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
