import SwiftUI

struct TeamDashboardView: View {
    @Environment(AppState.self) private var appState
    @State private var refreshTrigger = false

    var body: some View {
        NavigationStack {
            ZStack {
                NexusColors.void.ignoresSafeArea()
                ScrollView {
                    VStack(spacing: NexusSpacing.xl) {
                        if let status = appState.teamStatus {
                            summaryRow(status.summary)
                            botGrid(status.bots)
                        } else {
                            loadingView
                        }
                    }
                    .padding(NexusSpacing.lg)
                }
            }
            .navigationTitle("Agent Team")
            .navigationBarTitleDisplayMode(.large)
            .toolbarBackground(NexusColors.surface0, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        refreshTrigger.toggle()
                    } label: {
                        Image(systemName: "arrow.clockwise")
                            .foregroundStyle(NexusColors.accent)
                    }
                }
            }
        }
        .task(id: refreshTrigger) {
            while !Task.isCancelled {
                await appState.fetchTeamStatus()
                try? await Task.sleep(for: .seconds(5))
            }
        }
    }

    @ViewBuilder
    private func summaryRow(_ summary: TeamSummary) -> some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 100))], spacing: NexusSpacing.sm) {
            SummaryStatCard(label: "Total", value: "\(summary.totalBots)", color: NexusColors.text0)
            SummaryStatCard(label: "Busy", value: "\(summary.busyBots)", color: NexusColors.amber)
            SummaryStatCard(label: "Idle", value: "\(summary.idleBots)", color: NexusColors.green)
            SummaryStatCard(label: "Tasks", value: "\(summary.totalTasks)", color: NexusColors.blue)
            SummaryStatCard(label: "Cost", value: summary.formattedCost, color: NexusColors.text1)
        }
    }

    @ViewBuilder
    private func botGrid(_ bots: [TeamBotStatus]) -> some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 160))], spacing: NexusSpacing.md) {
            ForEach(bots) { bot in
                TeamBotCard(bot: bot)
            }
        }
    }

    private var loadingView: some View {
        VStack(spacing: NexusSpacing.lg) {
            NexusThinkingDots()
            Text("Loading team status...")
                .font(NexusTypography.body)
                .foregroundStyle(NexusColors.text2)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 80)
    }
}

// MARK: - SummaryStatCard

struct SummaryStatCard: View {
    let label: String
    let value: String
    let color: Color

    var body: some View {
        VStack(spacing: 4) {
            Text(value)
                .font(NexusTypography.heading)
                .foregroundStyle(color)
            Text(label)
                .font(NexusTypography.label)
                .foregroundStyle(NexusColors.text2)
                .textCase(.uppercase)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, NexusSpacing.md)
        .background(NexusColors.surface1)
        .clipShape(RoundedRectangle(cornerRadius: NexusRadius.md))
        .nexusGlassBorder(radius: NexusRadius.md)
    }
}

// MARK: - TeamBotCard

struct TeamBotCard: View {
    let bot: TeamBotStatus

    private var statusColor: Color {
        if bot.isError { return NexusColors.red }
        if bot.isBusy { return NexusColors.amber }
        return NexusColors.green
    }

    var body: some View {
        VStack(alignment: .leading, spacing: NexusSpacing.sm) {
            // Header
            HStack {
                if let icon = bot.icon, !icon.isEmpty {
                    Text(icon)
                        .font(.system(size: 22))
                } else {
                    GradientAvatar(name: bot.name, size: 32)
                }

                VStack(alignment: .leading, spacing: 2) {
                    Text(bot.name)
                        .font(NexusTypography.heading)
                        .foregroundStyle(NexusColors.text0)
                        .lineLimit(1)
                    if let platform = bot.platform {
                        Text(platform)
                            .font(NexusTypography.label)
                            .foregroundStyle(NexusColors.text2)
                    }
                }
                Spacer()
                // Status indicator
                if bot.isBusy {
                    NexusPulsingDot(color: NexusColors.amber, size: 8)
                } else {
                    Circle()
                        .fill(statusColor)
                        .frame(width: 8, height: 8)
                }
            }

            // Description
            if let desc = bot.description, !desc.isEmpty {
                Text(desc)
                    .font(NexusTypography.caption)
                    .foregroundStyle(NexusColors.text1)
                    .lineLimit(2)
            }

            // Current task
            if let task = bot.currentTask {
                HStack(spacing: 6) {
                    NexusPulsingDot(color: NexusColors.amber, size: 6)
                    Text("Running for \(task.formattedDuration)")
                        .font(NexusTypography.label)
                        .foregroundStyle(NexusColors.amber)
                }
            }

            // Specialties
            if let specialties = bot.specialties, !specialties.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(specialties.prefix(4), id: \.self) { s in
                            Text(s)
                                .font(NexusTypography.label)
                                .foregroundStyle(NexusColors.text2)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 3)
                                .background(NexusColors.surface2)
                                .clipShape(Capsule())
                        }
                    }
                }
            }

            Divider()
                .background(NexusColors.glassBorder)

            // Stats footer
            HStack {
                Text("\(bot.stats.totalTasks) tasks")
                    .font(NexusTypography.label)
                    .foregroundStyle(NexusColors.text2)
                Spacer()
                Text(bot.stats.formattedCost)
                    .font(NexusTypography.label)
                    .foregroundStyle(NexusColors.text2)
            }
        }
        .padding(NexusSpacing.md)
        .background(NexusColors.surface1)
        .clipShape(RoundedRectangle(cornerRadius: NexusRadius.lg))
        .nexusGlassBorder(radius: NexusRadius.lg)
    }
}
