import type { BotRegistry, BotInfo } from './bot-registry.js';
import { getAgents, type AgentMetadata } from './agent-scanner.js';

export interface BotStatus extends BotInfo {
  status: 'idle' | 'busy' | 'error';
  currentTask?: {
    chatId: string;
    startTime: number;
    durationMs: number;
  };
  stats: {
    totalTasks: number;
    completedTasks: number;
    failedTasks: number;
    totalCostUsd: number;
  };
  agents?: AgentMetadata[];
}

export interface TeamStatus {
  bots: BotStatus[];
  summary: {
    totalBots: number;
    busyBots: number;
    idleBots: number;
    totalCostUsd: number;
    totalTasks: number;
  };
}

/**
 * Aggregate bot status from the registry, running tasks, and cost tracker.
 */
export async function getTeamStatus(registry: BotRegistry): Promise<TeamStatus> {
  const bots: BotStatus[] = [];
  const registeredBots = registry.list();

  for (const botInfo of registeredBots) {
    const bot = registry.get(botInfo.name);
    const bridge = bot?.bridge;

    // Check if bot has a running task via the public API
    let currentTask: BotStatus['currentTask'] | undefined;
    let status: BotStatus['status'] = 'idle';

    const runningTasksInfo = bridge?.getRunningTasksInfo();
    if (runningTasksInfo && runningTasksInfo.length > 0) {
      status = 'busy';
      // Show the first running task for display
      const first = runningTasksInfo[0];
      currentTask = {
        chatId: first.chatId,
        startTime: first.startTime,
        durationMs: Date.now() - first.startTime,
      };
    }

    // Get cost stats from the bridge's cost tracker
    const costStats = bridge?.costTracker?.getStats();
    const botStats = costStats?.byBot?.[botInfo.name];

    // Scan sub-agents from the bot's working directory
    const agents = await getAgents(botInfo.workingDirectory);

    bots.push({
      ...botInfo,
      status,
      currentTask,
      stats: {
        totalTasks: botStats?.totalTasks ?? 0,
        completedTasks: botStats?.completedTasks ?? 0,
        failedTasks: botStats?.failedTasks ?? 0,
        totalCostUsd: botStats?.totalCostUsd ?? 0,
      },
      ...(agents.length > 0 ? { agents } : {}),
    });
  }

  const summary = {
    totalBots: bots.length,
    busyBots: bots.filter((b) => b.status === 'busy').length,
    idleBots: bots.filter((b) => b.status === 'idle').length,
    totalCostUsd: bots.reduce((sum, b) => sum + b.stats.totalCostUsd, 0),
    totalTasks: bots.reduce((sum, b) => sum + b.stats.totalTasks, 0),
  };

  return { bots, summary };
}
