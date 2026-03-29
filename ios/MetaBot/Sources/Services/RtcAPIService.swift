import Foundation

/// HTTP client for RTC voice call endpoints (/api/rtc/*)
struct RtcAPIService {
    let serverURL: String
    let token: String

    struct StartCallResponse: Decodable {
        let sessionId: String
        let roomId: String
        let taskId: String
        let token: String
        let appId: String
        let userId: String
        let aiUserId: String
    }

    struct RtcConfig: Decodable {
        let configured: Bool
    }

    struct TranscriptEntry: Codable {
        let speaker: String  // "user" or "ai"
        let text: String
        let timestamp: Double
    }

    /// POST /api/rtc/start — Create RTC room + AI agent
    func startCall(
        botName: String,
        chatId: String,
        systemPrompt: String? = nil,
        welcomeMessage: String? = nil
    ) async throws -> StartCallResponse {
        let url = URL(string: "\(serverURL)/api/rtc/start")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 30

        var body: [String: String] = [
            "botName": botName,
            "chatId": chatId,
            "welcomeMessage": welcomeMessage ?? "你好，有什么可以帮你的吗？",
        ]
        if let systemPrompt { body["systemPrompt"] = systemPrompt }

        request.httpBody = try JSONEncoder().encode(body)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            if let errJson = try? JSONDecoder().decode([String: String].self, from: data),
               let errMsg = errJson["error"] {
                throw RtcAPIError.serverError(errMsg)
            }
            throw RtcAPIError.requestFailed(statusCode: code)
        }

        return try JSONDecoder().decode(StartCallResponse.self, from: data)
    }

    /// POST /api/rtc/stop — Stop voice chat session
    func stopCall(sessionId: String) async throws {
        let url = URL(string: "\(serverURL)/api/rtc/stop")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONEncoder().encode(["sessionId": sessionId])

        let (_, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            return // best-effort, don't throw
        }
        _ = http
    }

    /// POST /api/rtc/transcript — Submit collected transcript
    func submitTranscript(sessionId: String, transcript: [TranscriptEntry]) async throws {
        let url = URL(string: "\(serverURL)/api/rtc/transcript")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        struct Body: Encodable {
            let sessionId: String
            let transcript: [TranscriptEntry]
        }
        request.httpBody = try JSONEncoder().encode(Body(sessionId: sessionId, transcript: transcript))

        let (_, _) = try await URLSession.shared.data(for: request)
        // best-effort
    }

    /// GET /api/rtc/config — Check if RTC is configured on server
    func checkConfig() async throws -> RtcConfig {
        let url = URL(string: "\(serverURL)/api/rtc/config")!
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 10

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            return RtcConfig(configured: false)
        }
        _ = http
        return (try? JSONDecoder().decode(RtcConfig.self, from: data)) ?? RtcConfig(configured: false)
    }
}

enum RtcAPIError: Error, LocalizedError {
    case requestFailed(statusCode: Int)
    case serverError(String)

    var errorDescription: String? {
        switch self {
        case .requestFailed(let code): return "RTC API error (HTTP \(code))"
        case .serverError(let msg): return msg
        }
    }
}
