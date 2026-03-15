import Foundation

// MARK: - Client → Server Messages

enum ClientMessage: Encodable {
    case chat(botName: String, chatId: String, text: String, messageId: String)
    case stop(chatId: String)
    case answer(chatId: String, toolUseId: String, answer: String)
    case groupChat(groupId: String, chatId: String, text: String, messageId: String)
    case createGroup(name: String, members: [String])
    case deleteGroup(groupId: String)
    case listGroups
    case ping

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: DynamicCodingKey.self)
        switch self {
        case .chat(let botName, let chatId, let text, let messageId):
            try container.encode("chat", forKey: .key("type"))
            try container.encode(botName, forKey: .key("botName"))
            try container.encode(chatId, forKey: .key("chatId"))
            try container.encode(text, forKey: .key("text"))
            try container.encode(messageId, forKey: .key("messageId"))
        case .stop(let chatId):
            try container.encode("stop", forKey: .key("type"))
            try container.encode(chatId, forKey: .key("chatId"))
        case .answer(let chatId, let toolUseId, let answer):
            try container.encode("answer", forKey: .key("type"))
            try container.encode(chatId, forKey: .key("chatId"))
            try container.encode(toolUseId, forKey: .key("toolUseId"))
            try container.encode(answer, forKey: .key("answer"))
        case .groupChat(let groupId, let chatId, let text, let messageId):
            try container.encode("group_chat", forKey: .key("type"))
            try container.encode(groupId, forKey: .key("groupId"))
            try container.encode(chatId, forKey: .key("chatId"))
            try container.encode(text, forKey: .key("text"))
            try container.encode(messageId, forKey: .key("messageId"))
        case .createGroup(let name, let members):
            try container.encode("create_group", forKey: .key("type"))
            try container.encode(name, forKey: .key("name"))
            try container.encode(members, forKey: .key("members"))
        case .deleteGroup(let groupId):
            try container.encode("delete_group", forKey: .key("type"))
            try container.encode(groupId, forKey: .key("groupId"))
        case .listGroups:
            try container.encode("list_groups", forKey: .key("type"))
        case .ping:
            try container.encode("ping", forKey: .key("type"))
        }
    }
}

// MARK: - Server → Client Messages

enum ServerMessage {
    case connected(bots: [BotInfo])
    case botsUpdated(bots: [BotInfo])
    case state(chatId: String, messageId: String, state: CardState, botName: String?)
    case complete(chatId: String, messageId: String, state: CardState, botName: String?)
    case error(chatId: String, messageId: String?, error: String)
    case file(chatId: String, url: String, name: String, mimeType: String, size: Int?)
    case notice(text: String?, chatId: String?, title: String?, content: String?)
    case groupCreated(group: ChatGroup)
    case groupDeleted(groupId: String)
    case groupsList(groups: [ChatGroup])
    case pong
    case unknown(type: String)
}

extension ServerMessage: Decodable {
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: DynamicCodingKey.self)
        let type = try container.decode(String.self, forKey: .key("type"))

        switch type {
        case "connected":
            let bots = try container.decode([BotInfo].self, forKey: .key("bots"))
            self = .connected(bots: bots)
        case "bots_updated":
            let bots = try container.decode([BotInfo].self, forKey: .key("bots"))
            self = .botsUpdated(bots: bots)
        case "state":
            let chatId = try container.decode(String.self, forKey: .key("chatId"))
            let messageId = try container.decode(String.self, forKey: .key("messageId"))
            let state = try container.decode(CardState.self, forKey: .key("state"))
            let botName = try container.decodeIfPresent(String.self, forKey: .key("botName"))
            self = .state(chatId: chatId, messageId: messageId, state: state, botName: botName)
        case "complete":
            let chatId = try container.decode(String.self, forKey: .key("chatId"))
            let messageId = try container.decode(String.self, forKey: .key("messageId"))
            let state = try container.decode(CardState.self, forKey: .key("state"))
            let botName = try container.decodeIfPresent(String.self, forKey: .key("botName"))
            self = .complete(chatId: chatId, messageId: messageId, state: state, botName: botName)
        case "error":
            let chatId = try container.decode(String.self, forKey: .key("chatId"))
            let messageId = try container.decodeIfPresent(String.self, forKey: .key("messageId"))
            let error = try container.decode(String.self, forKey: .key("error"))
            self = .error(chatId: chatId, messageId: messageId, error: error)
        case "file":
            let chatId = try container.decode(String.self, forKey: .key("chatId"))
            let url = try container.decode(String.self, forKey: .key("url"))
            let name = try container.decode(String.self, forKey: .key("name"))
            let mimeType = try container.decode(String.self, forKey: .key("mimeType"))
            let size = try container.decodeIfPresent(Int.self, forKey: .key("size"))
            self = .file(chatId: chatId, url: url, name: name, mimeType: mimeType, size: size)
        case "notice":
            let text = try container.decodeIfPresent(String.self, forKey: .key("text"))
            let chatId = try container.decodeIfPresent(String.self, forKey: .key("chatId"))
            let title = try container.decodeIfPresent(String.self, forKey: .key("title"))
            let content = try container.decodeIfPresent(String.self, forKey: .key("content"))
            self = .notice(text: text, chatId: chatId, title: title, content: content)
        case "group_created":
            let group = try container.decode(ChatGroup.self, forKey: .key("group"))
            self = .groupCreated(group: group)
        case "group_deleted":
            let groupId = try container.decode(String.self, forKey: .key("groupId"))
            self = .groupDeleted(groupId: groupId)
        case "groups_list":
            let groups = try container.decode([ChatGroup].self, forKey: .key("groups"))
            self = .groupsList(groups: groups)
        case "pong":
            self = .pong
        default:
            self = .unknown(type: type)
        }
    }
}

// MARK: - Helper

struct DynamicCodingKey: CodingKey {
    var stringValue: String
    var intValue: Int?

    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { self.intValue = intValue; self.stringValue = "\(intValue)" }

    static func key(_ name: String) -> DynamicCodingKey {
        DynamicCodingKey(stringValue: name)!
    }
}
