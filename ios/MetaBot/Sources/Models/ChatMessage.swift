import Foundation

/// Type of chat message
enum ChatMessageType: String, Codable {
    case user
    case assistant
    case system
}

/// A single chat message
struct ChatMessage: Codable, Identifiable {
    let id: String
    let type: ChatMessageType
    var text: String
    var state: CardState?
    var attachments: [FileAttachment]?
    let timestamp: Double
    var isPlanMode: Bool? = nil

    var date: Date {
        Date(timeIntervalSince1970: timestamp / 1000)
    }
}

/// A chat session containing messages
struct ChatSession: Codable, Identifiable {
    let id: String
    let botName: String
    var title: String
    var messages: [ChatMessage]
    let createdAt: Double
    var updatedAt: Double
    var groupId: String?

    var lastMessage: ChatMessage? { messages.last }

    var displayTitle: String {
        if !title.isEmpty { return title }
        if let first = messages.first(where: { $0.type == .user }) {
            let preview = first.text.prefix(60)
            return preview.isEmpty ? "New Chat" : String(preview)
        }
        return "New Chat"
    }

    var lastUpdatedDate: Date {
        Date(timeIntervalSince1970: updatedAt / 1000)
    }
}
