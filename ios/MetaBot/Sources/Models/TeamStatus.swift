import Foundation

struct TeamStatus: Codable {
    let bots: [TeamBotStatus]
    let summary: TeamSummary
}

struct TeamBotStatus: Codable, Identifiable {
    var id: String { name }
    let name: String
    let status: String  // "idle" | "busy" | "error"
    let platform: String?
    let icon: String?
    let description: String?
    let specialties: [String]?
    let currentTask: CurrentTaskInfo?
    let stats: BotStats

    var isIdle: Bool { status == "idle" }
    var isBusy: Bool { status == "busy" }
    var isError: Bool { status == "error" }
}

struct CurrentTaskInfo: Codable {
    let durationMs: Double

    var formattedDuration: String {
        let secs = Int(durationMs / 1000)
        if secs < 60 { return "\(secs)s" }
        return "\(secs / 60)m \(secs % 60)s"
    }
}

struct BotStats: Codable {
    let totalTasks: Int
    let failedTasks: Int
    let totalCostUsd: Double

    var formattedCost: String {
        String(format: "$%.4f", totalCostUsd)
    }
}

struct TeamSummary: Codable {
    let totalBots: Int
    let busyBots: Int
    let idleBots: Int
    let totalTasks: Int
    let totalCostUsd: Double

    var formattedCost: String {
        String(format: "$%.2f", totalCostUsd)
    }
}
