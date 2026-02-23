import type { BotConfigBase } from '../config.js';
import type { MessageBridge } from '../bridge/message-bridge.js';
import type { IMessageSender } from '../bridge/message-sender.interface.js';

export interface RegisteredBot {
  name: string;
  platform: 'feishu' | 'telegram';
  config: BotConfigBase;
  bridge: MessageBridge;
  sender: IMessageSender;
}

/** Public DTO returned by list() — no secrets or internal refs. */
export interface BotInfo {
  name: string;
  platform: string;
  workingDirectory: string;
  allowedTools: string[];
}

/**
 * In-memory registry of all running bots.
 * Populated at startup; used by the HTTP API and task scheduler.
 */
export class BotRegistry {
  private bots = new Map<string, RegisteredBot>();

  register(bot: RegisteredBot): void {
    this.bots.set(bot.name, bot);
  }

  get(name: string): RegisteredBot | undefined {
    return this.bots.get(name);
  }

  deregister(name: string): boolean {
    return this.bots.delete(name);
  }

  list(): BotInfo[] {
    return Array.from(this.bots.values()).map((b) => ({
      name: b.name,
      platform: b.platform,
      workingDirectory: b.config.claude.defaultWorkingDirectory,
      allowedTools: b.config.claude.allowedTools,
    }));
  }
}
