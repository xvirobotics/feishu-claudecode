import Foundation
import SwiftUI

/// Global application state
@Observable
final class AppState {
    // Services
    let auth = AuthService()
    let webSocket = WebSocketService()
    let pushService = PushNotificationService()

    // Connection
    var serverURL: String {
        didSet { UserDefaults.standard.set(serverURL, forKey: "metabot:serverURL") }
    }

    // Bots
    var bots: [BotInfo] = []
    var activeBotName: String? {
        didSet { UserDefaults.standard.set(activeBotName, forKey: "metabot:activeBotName") }
    }

    // Groups
    var groups: [ChatGroup] = []

    // RTC Voice Call
    var rtcAvailable = false
    var incomingVoiceCall: IncomingVoiceCall?

    // Team
    var teamStatus: TeamStatus? = nil

    // ASR streaming
    var asrPartialText: String = ""

    // Sessions
    var sessions: [String: ChatSession] = [:] {
        didSet { debounceSave() }
    }
    private var saveTask: Task<Void, Never>?
    var activeSessionId: String? {
        didSet { UserDefaults.standard.set(activeSessionId, forKey: "metabot:activeSessionId") }
    }

    // Navigation
    var activeTab: AppTab = .chats
    var showingChat = false

    // Theme
    var colorScheme: ColorScheme? = nil

    // Font Scale
    var fontScale: Double = 1.0 {
        didSet {
            UserDefaults.standard.set(fontScale, forKey: "metabot:fontScale")
            NexusFontScale.current = fontScale
        }
    }

    var activeSession: ChatSession? {
        guard let id = activeSessionId else { return nil }
        return sessions[id]
    }

    var activeBot: BotInfo? {
        bots.first(where: { $0.name == activeBotName })
    }

    var isConnected: Bool { webSocket.isConnected }

    private var messageListenerTask: Task<Void, Never>?

    init() {
        serverURL = UserDefaults.standard.string(forKey: "metabot:serverURL") ?? "https://metabot.xvirobotics.com"
        activeBotName = UserDefaults.standard.string(forKey: "metabot:activeBotName")
        activeSessionId = UserDefaults.standard.string(forKey: "metabot:activeSessionId")
        let storedScale = UserDefaults.standard.double(forKey: "metabot:fontScale")
        fontScale = storedScale.nonZeroOrDefault
        NexusFontScale.current = fontScale
        loadSessions()
    }

    // MARK: - Connection

    func connect() {
        guard let token = auth.token else { return }
        webSocket.connect(serverURL: serverURL, token: token)
        startListening()

        // Configure push service and request permission
        pushService.configure(serverURL: serverURL, token: token)
        Task { await pushService.requestPermission() }

        // Check RTC availability
        Task { await checkRtcAvailability() }
    }

    func disconnect() {
        messageListenerTask?.cancel()
        messageListenerTask = nil
        webSocket.disconnect()
        bots = []
        groups = []
    }

    private func startListening() {
        messageListenerTask?.cancel()
        messageListenerTask = Task { [weak self] in
            guard let self else { return }
            for await message in self.webSocket.messageStream {
                await MainActor.run {
                    self.handleMessage(message)
                }
            }
        }
    }

    // MARK: - Message Handling

    private func handleMessage(_ message: ServerMessage) {
        switch message {
        case .connected(let bots):
            self.bots = bots
            if activeBotName == nil, let first = bots.first {
                activeBotName = first.name
            }
            // Request groups list on connect
            webSocket.send(.listGroups)

        case .botsUpdated(let bots):
            self.bots = bots

        case .state(let chatId, let messageId, let state, _):
            updateMessageState(chatId: chatId, messageId: messageId, state: state)

        case .complete(let chatId, let messageId, let state, let botName):
            updateMessageState(chatId: chatId, messageId: messageId, state: state)
            // Post local notification if app is in background
            if UIApplication.shared.applicationState != .active {
                let title = botName ?? "MetaBot"
                let body = state.responseText?.prefix(200).description ?? "Task completed"
                pushService.postLocalNotification(title: title, body: body, chatId: chatId)
            }

        case .error(let chatId, let messageId, let error):
            if let messageId {
                let errorState = CardState(
                    status: .error, responseText: nil, toolCalls: nil,
                    costUsd: nil, durationMs: nil, errorMessage: error,
                    userPrompt: nil, pendingQuestion: nil
                )
                updateMessageState(chatId: chatId, messageId: messageId, state: errorState)
            }

        case .file(let chatId, let url, let name, let mimeType, let size):
            let attachment = FileAttachment(name: name, type: mimeType, size: size, url: url, path: nil)
            addAttachmentToLastAssistantMessage(chatId: chatId, attachment: attachment)

        case .notice(let text, let chatId, let title, let content):
            if let chatId {
                // Plan mode: when content is present, show as a collapsible plan card
                let isPlan = content != nil && title?.lowercased() == "plan"
                let displayText = content ?? text ?? ""
                guard !displayText.isEmpty else { break }
                let msg = ChatMessage(
                    id: UUID().uuidString, type: .system, text: displayText,
                    state: nil, attachments: nil,
                    timestamp: Date().timeIntervalSince1970 * 1000,
                    isPlanMode: isPlan ? true : nil
                )
                addMessage(chatId: chatId, message: msg)
            }

        case .voiceCall(let call):
            incomingVoiceCall = call

        case .groupCreated(let group):
            groups.append(group)

        case .groupDeleted(let groupId):
            groups.removeAll { $0.id == groupId }

        case .groupsList(let groups):
            self.groups = groups

        case .asrPartial(let text):
            asrPartialText = text

        case .asrFinal(let text):
            if !text.isEmpty {
                asrPartialText = ""
            }

        case .pong, .unknown:
            break
        }
    }

    // MARK: - Session Management

    func createSession(botName: String? = nil, groupId: String? = nil) -> String {
        let id = "ios_\(UUID().uuidString.prefix(8))"
        let bot = botName ?? activeBotName ?? "default"
        let session = ChatSession(
            id: id, botName: bot, title: "", messages: [],
            createdAt: Date().timeIntervalSince1970 * 1000,
            updatedAt: Date().timeIntervalSince1970 * 1000,
            groupId: groupId
        )
        sessions[id] = session
        activeSessionId = id
        activeBotName = bot
        showingChat = true
        return id
    }

    func deleteSession(_ id: String) {
        guard let session = sessions[id] else { return }
        let botName = session.botName
        sessions.removeValue(forKey: id)
        if activeSessionId == id {
            // Switch to most recent remaining session for the same bot
            let remaining = sessions.values
                .filter { $0.botName == botName && $0.groupId == nil }
                .sorted(by: { $0.updatedAt > $1.updatedAt })
            if let next = remaining.first {
                selectSession(next.id)
            } else {
                activeSessionId = nil
                showingChat = false
            }
        }
    }

    /// Delete session using labeled parameter (convenience for closures)
    func deleteSession(id: String) {
        deleteSession(id)
    }

    func renameSession(id: String, title: String) {
        sessions[id]?.title = title
    }

    func selectSession(_ id: String) {
        activeSessionId = id
        if let session = sessions[id] {
            activeBotName = session.botName
        }
        showingChat = true
    }

    func getOrCreateSession(botName: String) -> String {
        if let existing = sessions.values.first(where: {
            $0.botName == botName && $0.messages.isEmpty
        }) {
            activeSessionId = existing.id
            activeBotName = botName
            showingChat = true
            return existing.id
        }
        return createSession(botName: botName)
    }

    func deleteMessage(sessionId: String, messageId: String) {
        sessions[sessionId]?.messages.removeAll { $0.id == messageId }
    }

    func clearSessionMessages(id: String) {
        sessions[id]?.messages = []
    }

    func clearAllSessions() {
        sessions.removeAll()
        activeSessionId = nil
    }

    // MARK: - Group Management

    func createGroup(name: String, members: [String]) {
        webSocket.send(.createGroup(name: name, members: members))
    }

    func deleteGroup(_ groupId: String) {
        webSocket.send(.deleteGroup(groupId: groupId))
    }

    func createGroupSession(group: ChatGroup) -> String {
        return createSession(botName: group.name, groupId: group.id)
    }

    // MARK: - Message Management

    func addMessage(chatId: String, message: ChatMessage) {
        guard sessions[chatId] != nil else { return }
        sessions[chatId]?.messages.append(message)
        sessions[chatId]?.updatedAt = Date().timeIntervalSince1970 * 1000
        if message.type == .user, sessions[chatId]?.title.isEmpty == true {
            sessions[chatId]?.title = String(message.text.prefix(60))
        }
    }

    func updateMessageState(chatId: String, messageId: String, state: CardState) {
        guard let idx = sessions[chatId]?.messages.firstIndex(where: { $0.id == messageId }) else { return }
        sessions[chatId]?.messages[idx].state = state
        if let text = state.responseText, !text.isEmpty {
            sessions[chatId]?.messages[idx].text = text
        }
    }

    func addAttachmentToLastAssistantMessage(chatId: String, attachment: FileAttachment) {
        guard var session = sessions[chatId] else { return }
        if let idx = session.messages.lastIndex(where: { $0.type == .assistant }) {
            if session.messages[idx].attachments == nil {
                session.messages[idx].attachments = []
            }
            session.messages[idx].attachments?.append(attachment)
            sessions[chatId] = session
        }
    }

    // MARK: - Send

    func sendMessage(text: String, attachments: [FileAttachment] = []) {
        var sessionId = activeSessionId
        if sessionId == nil {
            sessionId = createSession()
        }
        guard let sessionId else { return }

        let userMsgId = UUID().uuidString
        let assistantMsgId = UUID().uuidString
        let botName = activeBotName ?? "default"

        // Add user message
        let userMsg = ChatMessage(
            id: userMsgId, type: .user, text: text,
            state: nil, attachments: attachments.isEmpty ? nil : attachments,
            timestamp: Date().timeIntervalSince1970 * 1000
        )
        addMessage(chatId: sessionId, message: userMsg)

        // Add placeholder assistant message
        let thinkingState = CardState(
            status: .thinking, responseText: "", toolCalls: [],
            costUsd: nil, durationMs: nil, errorMessage: nil,
            userPrompt: text, pendingQuestion: nil
        )
        let assistantMsg = ChatMessage(
            id: assistantMsgId, type: .assistant, text: "",
            state: thinkingState, attachments: nil,
            timestamp: Date().timeIntervalSince1970 * 1000
        )
        addMessage(chatId: sessionId, message: assistantMsg)

        // Register this chatId for push notifications
        pushService.registerForChat(chatId: sessionId)

        // Check if this is a group chat
        let session = sessions[sessionId]
        if let groupId = session?.groupId {
            webSocket.send(.groupChat(
                groupId: groupId,
                chatId: sessionId,
                text: text,
                messageId: assistantMsgId
            ))
        } else {
            webSocket.send(.chat(
                botName: botName,
                chatId: sessionId,
                text: text,
                messageId: assistantMsgId
            ))
        }
    }

    func stopTask() {
        guard let chatId = activeSessionId else { return }
        webSocket.send(.stop(chatId: chatId))

        if let session = sessions[chatId],
           let last = session.messages.last,
           last.type == .assistant,
           let status = last.state?.status,
           status == .thinking || status == .running {
            let stoppedState = CardState(
                status: .error, responseText: last.state?.responseText,
                toolCalls: last.state?.toolCalls, costUsd: last.state?.costUsd,
                durationMs: last.state?.durationMs, errorMessage: "Stopped by user",
                userPrompt: last.state?.userPrompt, pendingQuestion: nil
            )
            updateMessageState(chatId: chatId, messageId: last.id, state: stoppedState)
        }
    }

    func answerQuestion(toolUseId: String, answer: String) {
        guard let chatId = activeSessionId else { return }
        webSocket.send(.answer(chatId: chatId, toolUseId: toolUseId, answer: answer))
    }

    var isRunning: Bool {
        guard let session = activeSession, let last = session.messages.last else { return false }
        return last.type == .assistant && (last.state?.status == .thinking || last.state?.status == .running)
    }

    // MARK: - RTC Voice Call

    func checkRtcAvailability() async {
        guard let token = auth.token else { return }
        let api = RtcAPIService(serverURL: serverURL, token: token)
        if let config = try? await api.checkConfig() {
            await MainActor.run { rtcAvailable = config.configured }
        }
    }

    /// Build a concise chat context from recent messages (user text + AI final response only, no tool calls)
    func buildChatContext(forSession sessionId: String, maxRounds: Int = 8) -> String {
        guard let session = sessions[sessionId] else { return "" }
        var turns: [String] = []
        for msg in session.messages {
            if msg.type == .user, !msg.text.isEmpty {
                turns.append("User: \(msg.text)")
            } else if msg.type == .assistant {
                let text = msg.state?.responseText ?? msg.text
                if !text.isEmpty { turns.append("AI: \(text)") }
            }
        }
        let recent = turns.suffix(maxRounds * 2)
        return recent.joined(separator: "\n")
    }

    /// Inject RTC call transcript into chat as a message for Claude to process
    func injectRtcTranscript(_ transcriptText: String) {
        sendMessage(text: transcriptText)
    }

    // MARK: - Team Status

    func fetchTeamStatus() async {
        guard let token = auth.token else { return }
        guard let url = URL(string: "\(serverURL)/api/team/status") else { return }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        do {
            let (data, _) = try await URLSession.shared.data(for: request)
            let status = try JSONDecoder().decode(TeamStatus.self, from: data)
            await MainActor.run { teamStatus = status }
        } catch {
            print("[Team] Fetch error: \(error)")
        }
    }

    // MARK: - Persistence

    private func debounceSave() {
        saveTask?.cancel()
        saveTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(1))
            guard !Task.isCancelled, let self else { return }
            self.saveSessions()
        }
    }

    private func saveSessions() {
        let data = try? JSONEncoder().encode(sessions)
        UserDefaults.standard.set(data, forKey: "metabot:sessions")
    }

    private func loadSessions() {
        guard let data = UserDefaults.standard.data(forKey: "metabot:sessions"),
              let loaded = try? JSONDecoder().decode([String: ChatSession].self, from: data)
        else { return }
        sessions = loaded
    }
}

enum AppTab: String, CaseIterable {
    case chats
    case team
    case memory
    case settings
}

// MARK: - Double Extension

extension Double {
    /// Returns self if non-zero, otherwise 1.0 (useful for UserDefaults where 0 means "not set")
    var nonZeroOrDefault: Double { self == 0 ? 1.0 : self }
}
