import Foundation

/// Bot information received from the server
struct BotInfo: Codable, Identifiable, Hashable {
    var id: String { name }
    let name: String
    let platform: String?
    let workingDirectory: String?
    let description: String?

    enum CodingKeys: String, CodingKey {
        case name, platform, workingDirectory, description
    }
}
