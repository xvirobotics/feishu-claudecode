import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from '../utils/logger.js';

interface StoredData {
  registrations: Array<{ chatId: string; deviceToken: string; registeredAt: number }>;
}

/**
 * JSON file-based store for APNs device tokens.
 * Maps chatId → Set<deviceToken> for push notification delivery.
 */
export class DeviceStore {
  private store = new Map<string, Set<string>>();
  private filePath: string;
  private logger: Logger;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(dataDir: string, logger: Logger) {
    this.filePath = path.join(dataDir, 'device-tokens.json');
    this.logger = logger.child({ module: 'device-store' });
    this.load();
  }

  /** Register a device token for a chatId. */
  register(chatId: string, deviceToken: string): void {
    let set = this.store.get(chatId);
    if (!set) {
      set = new Set();
      this.store.set(chatId, set);
    }
    if (!set.has(deviceToken)) {
      set.add(deviceToken);
      this.scheduleSave();
      this.logger.debug({ chatId, tokenPrefix: deviceToken.slice(0, 8) }, 'Device token registered');
    }
  }

  /** Unregister a device token from all chatIds. */
  unregister(deviceToken: string): void {
    let removed = false;
    for (const [chatId, set] of this.store) {
      if (set.delete(deviceToken)) {
        removed = true;
        if (set.size === 0) this.store.delete(chatId);
      }
    }
    if (removed) {
      this.scheduleSave();
      this.logger.debug({ tokenPrefix: deviceToken.slice(0, 8) }, 'Device token unregistered');
    }
  }

  /** Remove a specific token (e.g., when APNs returns 410 Gone). */
  removeToken(deviceToken: string): void {
    this.unregister(deviceToken);
  }

  /** Get all device tokens registered for a chatId. */
  getTokens(chatId: string): string[] {
    const set = this.store.get(chatId);
    return set ? [...set] : [];
  }

  /** Get all registered chatIds (for debugging). */
  getAllChatIds(): string[] {
    return [...this.store.keys()];
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const data: StoredData = JSON.parse(raw);
        for (const reg of data.registrations) {
          let set = this.store.get(reg.chatId);
          if (!set) {
            set = new Set();
            this.store.set(reg.chatId, set);
          }
          set.add(reg.deviceToken);
        }
        this.logger.info({ chatIds: this.store.size }, 'Device tokens loaded');
      }
    } catch (err) {
      this.logger.warn({ err }, 'Failed to load device tokens, starting fresh');
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 1000);
  }

  private save(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const registrations: StoredData['registrations'] = [];
      for (const [chatId, tokens] of this.store) {
        for (const deviceToken of tokens) {
          registrations.push({ chatId, deviceToken, registeredAt: Date.now() });
        }
      }
      fs.writeFileSync(this.filePath, JSON.stringify({ registrations }, null, 2));
      this.logger.debug({ count: registrations.length }, 'Device tokens saved');
    } catch (err) {
      this.logger.error({ err }, 'Failed to save device tokens');
    }
  }
}
