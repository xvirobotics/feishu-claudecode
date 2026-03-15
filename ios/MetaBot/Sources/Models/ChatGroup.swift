import Foundation

/// A group of bots for multi-agent conversation
struct ChatGroup: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let members: [String]
    let createdAt: Double?
}
