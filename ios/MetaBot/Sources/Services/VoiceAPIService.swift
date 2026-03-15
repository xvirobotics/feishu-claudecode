import Foundation
import AVFoundation

/// Voice API client — handles POST /api/voice for STT + Agent + TTS
struct VoiceAPIService {
    let serverURL: String
    let token: String

    struct VoiceResponse {
        let transcript: String
        let responseText: String
        let audioData: Data?
        let costUsd: Double?
        let durationMs: Double?
    }

    /// Send audio to /api/voice and get back response (audio or text)
    func sendVoice(
        audioData: Data,
        botName: String,
        chatId: String,
        voiceMode: Bool = true,
        tts: String = "doubao",
        stt: String = "doubao",
        language: String = "zh"
    ) async throws -> VoiceResponse {
        var components = URLComponents(string: "\(serverURL)/api/voice")!
        components.queryItems = [
            URLQueryItem(name: "botName", value: botName),
            URLQueryItem(name: "chatId", value: chatId),
            URLQueryItem(name: "voiceMode", value: voiceMode ? "true" : "false"),
            URLQueryItem(name: "tts", value: tts),
            URLQueryItem(name: "stt", value: stt),
            URLQueryItem(name: "language", value: language),
        ]

        var request = URLRequest(url: components.url!)
        request.httpMethod = "POST"
        request.setValue("audio/mp4", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = audioData
        request.timeoutInterval = 60

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
            throw VoiceAPIError.requestFailed(statusCode: statusCode)
        }

        let contentType = http.value(forHTTPHeaderField: "Content-Type") ?? ""

        // Decode headers (base64-encoded)
        let transcript = decodeHeader(http.value(forHTTPHeaderField: "X-Transcript"))
        let responseText = decodeHeader(http.value(forHTTPHeaderField: "X-Response-Text"))

        if contentType.contains("audio") {
            // TTS response — audio data
            return VoiceResponse(
                transcript: transcript,
                responseText: responseText,
                audioData: data,
                costUsd: nil,
                durationMs: nil
            )
        } else {
            // JSON response (no TTS)
            struct JSONResponse: Decodable {
                let transcript: String?
                let responseText: String?
                let costUsd: Double?
                let durationMs: Double?
            }
            let json = try? JSONDecoder().decode(JSONResponse.self, from: data)
            return VoiceResponse(
                transcript: json?.transcript ?? transcript,
                responseText: json?.responseText ?? responseText,
                audioData: nil,
                costUsd: json?.costUsd,
                durationMs: json?.durationMs
            )
        }
    }

    private func decodeHeader(_ value: String?) -> String {
        guard let value, let data = Data(base64Encoded: value) else { return "" }
        return String(data: data, encoding: .utf8) ?? ""
    }
}

enum VoiceAPIError: Error, LocalizedError {
    case requestFailed(statusCode: Int)

    var errorDescription: String? {
        switch self {
        case .requestFailed(let code): return "Voice API error (HTTP \(code))"
        }
    }
}
