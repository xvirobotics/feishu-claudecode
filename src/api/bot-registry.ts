import type * as lark from '@larksuiteoapi/node-sdk';
import type { BotConfigBase } from '../config.js';
import type { MessageBridge } from '../bridge/message-bridge.js';
import type { IMessageSender } from '../bridge/message-sender.interface.js';

export interface RegisteredBot {
  name: string;
  platform: 'feishu' | 'telegram' | 'web';
  config: BotConfigBase;
  bridge: MessageBridge;
  sender: IMessageSender;
  /** Feishu SDK client (only for feishu platform bots). */
  feishuClient?: lark.Client;
}

/** Public DTO returned by list() — no secrets or internal refs. */
export interface BotInfo {
  name: string;
  description?: string;
  platform: string;
  workingDirectory: string;
  /** Set when the bot comes from a peer instance. */
  peerUrl?: string;
  /** Human-readable peer identifier. */
  peerName?: string;
}

/**
 * In-memory registry of all running bots.
 * Populated at startup; used by the HTTP API and task scheduler.
 *
 * Keys are `platform:name` to avoid collisions when a Feishu bot and
 * Telegram bot share the same name (e.g. both called "metabot").
 */
export class BotRegistry {
  private bots = new Map<string, RegisteredBot>();

  private key(name: string, platform?: string): string {
    if (platform) return `${platform}:${name}`;
    // Legacy lookup: try exact key first, then search by name
    return name;
  }

  register(bot: RegisteredBot): void {
    this.bots.set(`${bot.platform}:${bot.name}`, bot);
  }

  get(name: string): RegisteredBot | undefined {
    // Try platform-qualified keys first
    for (const prefix of ['feishu', 'telegram', 'web']) {
      const bot = this.bots.get(`${prefix}:${name}`);
      if (bot) return bot;
    }
    return undefined;
  }

  /** Get a bot by name and platform. */
  getByPlatform(name: string, platform: string): RegisteredBot | undefined {
    return this.bots.get(`${platform}:${name}`);
  }

  /** Get all bots of a specific platform. */
  listByPlatform(platform: string): RegisteredBot[] {
    return Array.from(this.bots.values()).filter((b) => b.platform === platform);
  }

  deregister(name: string): boolean {
    // Try all platform-qualified keys
    for (const prefix of ['feishu', 'telegram', 'web']) {
      if (this.bots.delete(`${prefix}:${name}`)) return true;
    }
    return false;
  }

  list(): BotInfo[] {
    return Array.from(this.bots.values()).map((b) => ({
      name: b.name,
      ...(b.config.description ? { description: b.config.description } : {}),
      platform: b.platform,
      workingDirectory: b.config.claude.defaultWorkingDirectory,
    }));
  }
}
