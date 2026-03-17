import AppIntents
import Foundation

/// App Intent: "Call agent on MetaBot" via Siri
/// The user provides the agent name when prompted by Siri.
struct CallBotIntent: AppIntent {
    static var title: LocalizedStringResource = "Call Agent"
    static var description = IntentDescription("Start a voice call with a MetaBot agent")
    static var openAppWhenRun = true

    @Parameter(title: "Agent Name", requestValueDialog: "Which agent would you like to call?")
    var botName: String

    func perform() async throws -> some IntentResult {
        CallBotIntent.pendingCallBot = botName
        return .result()
    }

    /// Pending bot name from Siri -- checked by MetaBotApp on launch
    static var pendingCallBot: String?
}

/// Siri phrases and shortcuts registration
struct MetaBotShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: CallBotIntent(),
            phrases: [
                "Call agent on \(.applicationName)",
                "Phone agent with \(.applicationName)",
                "Voice call on \(.applicationName)",
            ],
            shortTitle: "Call Agent",
            systemImageName: "phone.fill"
        )
    }
}
