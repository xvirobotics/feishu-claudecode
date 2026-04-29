import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Logger } from '../../utils/logger.js';

export interface ApiConfig {
  baseUrl: string;
  authToken: string;
}

interface ConfigFile {
  configs: Record<string, ApiConfig>;
  current?: string;
}

export class ApiConfigManager {
  private configPath: string;
  private settingsPath: string;
  private configs: Map<string, ApiConfig> = new Map();
  private currentName?: string;

  constructor(private logger: Logger) {
    const claudeDir = path.join(os.homedir(), '.claude');
    this.configPath = path.join(claudeDir, 'metabot-apis.json');
    this.settingsPath = path.join(claudeDir, 'settings.json');
    this.loadConfigs();
  }

  private loadConfigs(): void {
    try {
      if (!fs.existsSync(this.configPath)) {
        this.logger.info('API config file not found, starting with empty config');
        return;
      }

      const content = fs.readFileSync(this.configPath, 'utf-8');
      const data: ConfigFile = JSON.parse(content);

      this.configs.clear();
      for (const [name, config] of Object.entries(data.configs || {})) {
        this.configs.set(name, config);
      }
      this.currentName = data.current;

      this.logger.info({ count: this.configs.size, current: this.currentName }, 'Loaded API configs');
    } catch (err: any) {
      this.logger.error({ err, path: this.configPath }, 'Failed to load API configs');
    }
  }

  private async saveConfigs(): Promise<void> {
    const data: ConfigFile = {
      configs: Object.fromEntries(this.configs),
      current: this.currentName,
    };

    const dir = path.dirname(this.configPath);
    await fsPromises.mkdir(dir, { recursive: true });

    const tmpPath = `${this.configPath}.tmp`;
    await fsPromises.writeFile(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 });
    await fsPromises.rename(tmpPath, this.configPath);

    this.logger.info({ path: this.configPath }, 'Saved API configs');
  }

  private async syncToSettings(config: ApiConfig): Promise<void> {
    try {
      let settings: Record<string, unknown> = {};

      if (fs.existsSync(this.settingsPath)) {
        const content = fs.readFileSync(this.settingsPath, 'utf-8');
        settings = JSON.parse(content);
      }

      const env = (settings.env as Record<string, string>) || {};
      env.ANTHROPIC_BASE_URL = config.baseUrl;
      env.ANTHROPIC_AUTH_TOKEN = config.authToken;
      settings.env = env;

      const tmpPath = `${this.settingsPath}.tmp`;
      await fsPromises.writeFile(tmpPath, JSON.stringify(settings, null, 2), 'utf-8');
      await fsPromises.rename(tmpPath, this.settingsPath);

      this.logger.info({ baseUrl: config.baseUrl }, 'Synced API config to settings.json');
    } catch (err: any) {
      this.logger.error({ err }, 'Failed to sync API config to settings.json');
      throw new Error(`Failed to update settings.json: ${err.message}`, { cause: err });
    }
  }

  async validateConfig(config: ApiConfig): Promise<{ valid: boolean; error?: string }> {
    const url = `${config.baseUrl}/v1/messages`;
    const maxRetries = 2;
    let lastError = '';

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': config.authToken,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({}),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (response.status === 401 || response.status === 403) {
          return { valid: false, error: `Authentication failed (HTTP ${response.status})` };
        }

        return { valid: true };
      } catch (err: any) {
        lastError = err.name === 'AbortError' ? 'Request timeout (8s)' : (err.message || String(err));
        this.logger.warn({ attempt: attempt + 1, maxRetries: maxRetries + 1, error: lastError }, 'API validation attempt failed, retrying...');

        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }

    return { valid: false, error: lastError };
  }

  async setConfig(name: string, config: ApiConfig, validate = true): Promise<{ success: boolean; error?: string }> {
    if (!name || !config.baseUrl || !config.authToken) {
      return { success: false, error: 'Invalid config: name, baseUrl, and authToken are required' };
    }

    if (validate) {
      this.logger.info({ name, baseUrl: config.baseUrl }, 'Validating API config');
      const result = await this.validateConfig(config);
      if (!result.valid) {
        return { success: false, error: `Validation failed: ${result.error}` };
      }
    }

    this.configs.set(name, config);
    this.currentName = name;
    await this.saveConfigs();
    await this.syncToSettings(config);

    this.logger.info({ name, baseUrl: config.baseUrl }, 'API config set and activated');
    return { success: true };
  }

  async switchConfig(name: string, validate = true): Promise<{ success: boolean; error?: string }> {
    const config = this.configs.get(name);
    if (!config) {
      return { success: false, error: `Config "${name}" not found` };
    }

    if (validate) {
      this.logger.info({ name, baseUrl: config.baseUrl }, 'Validating API config before switch');
      const result = await this.validateConfig(config);
      if (!result.valid) {
        return { success: false, error: `Validation failed: ${result.error}` };
      }
    }

    this.currentName = name;
    await this.saveConfigs();
    await this.syncToSettings(config);

    this.logger.info({ name, baseUrl: config.baseUrl }, 'Switched to API config');
    return { success: true };
  }

  async deleteConfig(name: string): Promise<{ success: boolean; error?: string }> {
    if (!this.configs.has(name)) {
      return { success: false, error: `Config "${name}" not found` };
    }

    this.configs.delete(name);

    if (this.currentName === name) {
      this.currentName = undefined;
    }

    await this.saveConfigs();

    this.logger.info({ name }, 'Deleted API config');
    return { success: true };
  }

  listConfigs(): Array<{ name: string; baseUrl: string; isCurrent: boolean }> {
    return Array.from(this.configs.entries()).map(([name, config]) => ({
      name,
      baseUrl: config.baseUrl,
      isCurrent: name === this.currentName,
    }));
  }

  getCurrentConfig(): { name: string; config: ApiConfig } | null {
    if (!this.currentName) return null;
    const config = this.configs.get(this.currentName);
    if (!config) return null;
    return { name: this.currentName, config };
  }

  getCurrentEnv(): Record<string, string> | null {
    const current = this.getCurrentConfig();
    if (!current) return null;

    return {
      ANTHROPIC_BASE_URL: current.config.baseUrl,
      ANTHROPIC_AUTH_TOKEN: current.config.authToken,
    };
  }
}
