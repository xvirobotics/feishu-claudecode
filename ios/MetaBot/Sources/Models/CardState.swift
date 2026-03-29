import Foundation

/// Status of an assistant message
enum MessageStatus: String, Codable {
    case thinking
    case running
    case complete
    case error
    case waitingForInput = "waiting_for_input"
}

/// Tool call information
struct ToolCallInfo: Codable, Identifiable {
    /// Stable unique ID based on name + detail (status excluded for stability)
    var id: String { name + (detail ?? "") }
    let name: String
    let detail: String?
    let status: String? // "running" or "done"

    enum CodingKeys: String, CodingKey {
        case name, detail, status
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
        detail = try container.decodeIfPresent(String.self, forKey: .detail)
        status = try container.decodeIfPresent(String.self, forKey: .status)
    }
}

/// Pending question from Claude
struct PendingQuestion: Codable {
    let toolUseId: String?
    let question: String?
    let options: [QuestionOption]?
}

struct QuestionOption: Codable, Identifiable {
    var id: String { label }
    let label: String
    let description: String?
}

/// Streaming card state for assistant messages
struct CardState: Codable {
    let status: MessageStatus?
    let responseText: String?
    let toolCalls: [ToolCallInfo]?
    let costUsd: Double?
    let durationMs: Double?
    let errorMessage: String?
    let userPrompt: String?
    let pendingQuestion: PendingQuestion?
}
