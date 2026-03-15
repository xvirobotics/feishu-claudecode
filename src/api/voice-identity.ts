import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Logger } from '../utils/logger.js';

export interface VoiceIdentity {
  id: string;
  name: string;
  phone?: string;
  registeredAt: number;
  defaultBotTeam?: string[];
  permissions?: string[];
}

export class VoiceIdentityStore {
  private identities = new Map<string, VoiceIdentity>();
  private logger: Logger;
  private dataPath: string;

  constructor(logger: Logger) {
    this.logger = logger.child({ module: 'voice-identity' });
    this.dataPath = path.join(os.homedir(), '.metabot', 'voice-identities.json');
    this.load();
  }

  register(identity: Omit<VoiceIdentity, 'registeredAt'>): VoiceIdentity {
    const full: VoiceIdentity = { ...identity, registeredAt: Date.now() };
    this.identities.set(identity.id, full);
    this.save();
    this.logger.info({ id: identity.id, name: identity.name }, 'Voice identity registered');
    return full;
  }

  get(id: string): VoiceIdentity | undefined {
    return this.identities.get(id);
  }

  getByPhone(phone: string): VoiceIdentity | undefined {
    for (const identity of this.identities.values()) {
      if (identity.phone === phone) return identity;
    }
    return undefined;
  }

  list(): VoiceIdentity[] {
    return Array.from(this.identities.values());
  }

  update(id: string, updates: Partial<VoiceIdentity>): VoiceIdentity | undefined {
    const identity = this.identities.get(id);
    if (!identity) return undefined;
    Object.assign(identity, updates);
    this.save();
    return identity;
  }

  delete(id: string): boolean {
    const deleted = this.identities.delete(id);
    if (deleted) this.save();
    return deleted;
  }

  private load(): void {
    try {
      if (fs.existsSync(this.dataPath)) {
        const data = JSON.parse(fs.readFileSync(this.dataPath, 'utf-8'));
        for (const identity of data.identities || []) {
          this.identities.set(identity.id, identity);
        }
        this.logger.info({ count: this.identities.size }, 'Voice identities loaded');
      }
    } catch (err) {
      this.logger.warn({ err }, 'Failed to load voice identities');
    }
  }

  private save(): void {
    try {
      const dir = path.dirname(this.dataPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        this.dataPath,
        JSON.stringify(
          {
            identities: Array.from(this.identities.values()),
          },
          null,
          2,
        ),
      );
    } catch (err) {
      this.logger.warn({ err }, 'Failed to save voice identities');
    }
  }
}
