import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from '../utils/logger.js';

interface DeviceEntry {
  alert: Set<string>;
  voip: Set<string>;
}

interface StoredData {
  registrations: Array<{ chatId: string; deviceToken: string; tokenType?: 'alert' | 'voip'; registeredAt: number }>;
}

/**
 * JSON file-based store for APNs device tokens.
 * Maps chatId → DeviceEntry (alert + voip token sets) for push notification delivery.
 */
export class DeviceStore {
  private store = new Map<string, DeviceEntry>();
  private filePath: string;
  private logger: Logger;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(dataDir: string, logger: Logger) {
    this.filePath = path.join(dataDir, 'device-tokens.json');
    this.logger = logger.child({ module: 'device-store' });
    this.load();
  }

  /** Register a device token for a chatId. */
  register(chatId: string, deviceToken: string, tokenType: 'alert' | 'voip' = 'alert'): void {
    let entry = this.store.get(chatId);
    if (!entry) {
      entry = { alert: new Set(), voip: new Set() };
      this.store.set(chatId, entry);
    }
    const set = entry[tokenType];
    if (!set.has(deviceToken)) {
      set.add(deviceToken);
      this.scheduleSave();
      this.logger.debug({ chatId, tokenPrefix: deviceToken.slice(0, 8), tokenType }, 'Device token registered');
    }
  }

  /** Unregister a device token from all chatIds (both alert and voip sets). */
  unregister(deviceToken: string): void {
    let removed = false;
    for (const [chatId, entry] of this.store) {
      if (entry.alert.delete(deviceToken)) removed = true;
      if (entry.voip.delete(deviceToken)) removed = true;
      if (entry.alert.size === 0 && entry.voip.size === 0) this.store.delete(chatId);
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

  /** Get alert device tokens registered for a chatId (backward compatible). */
  getTokens(chatId: string): string[] {
    const entry = this.store.get(chatId);
    return entry ? [...entry.alert] : [];
  }

  /** Get VoIP device tokens registered for a chatId. */
  getVoIPTokens(chatId: string): string[] {
    const entry = this.store.get(chatId);
    return entry ? [...entry.voip] : [];
  }

  /** Get ALL alert device tokens across all chatIds. */
  getAllTokens(): string[] {
    const tokens = new Set<string>();
    for (const entry of this.store.values()) {
      for (const t of entry.alert) tokens.add(t);
    }
    return [...tokens];
  }

  /** Get ALL VoIP device tokens across all chatIds. */
  getAllVoIPTokens(): string[] {
    const tokens = new Set<string>();
    for (const entry of this.store.values()) {
      for (const t of entry.voip) tokens.add(t);
    }
    return [...tokens];
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
          let entry = this.store.get(reg.chatId);
          if (!entry) {
            entry = { alert: new Set(), voip: new Set() };
            this.store.set(reg.chatId, entry);
          }
          const tokenType = reg.tokenType || 'alert';
          entry[tokenType].add(reg.deviceToken);
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
      for (const [chatId, entry] of this.store) {
        for (const deviceToken of entry.alert) {
          registrations.push({ chatId, deviceToken, tokenType: 'alert', registeredAt: Date.now() });
        }
        for (const deviceToken of entry.voip) {
          registrations.push({ chatId, deviceToken, tokenType: 'voip', registeredAt: Date.now() });
        }
      }
      fs.writeFileSync(this.filePath, JSON.stringify({ registrations }, null, 2));
      this.logger.debug({ count: registrations.length }, 'Device tokens saved');
    } catch (err) {
      this.logger.error({ err }, 'Failed to save device tokens');
    }
  }
}
