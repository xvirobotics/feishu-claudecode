import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BotsJsonNewFormat, FeishuBotJsonEntry, TelegramBotJsonEntry } from '../config.js';

export function readBotsConfig(configPath: string): BotsJsonNewFormat {
  const raw = fs.readFileSync(configPath, 'utf-8');
  const parsed = JSON.parse(raw);

  // Handle old array format (backward compat)
  if (Array.isArray(parsed)) {
    return { feishuBots: parsed as FeishuBotJsonEntry[] };
  }

  return parsed as BotsJsonNewFormat;
}

export function writeBotsConfig(configPath: string, config: BotsJsonNewFormat): void {
  const json = JSON.stringify(config, null, 2) + '\n';
  const tmpPath = path.join(path.dirname(configPath), '.bots.json.tmp');
  fs.writeFileSync(tmpPath, json, { mode: 0o600 });
  fs.renameSync(tmpPath, configPath);
}

export function addBot(
  configPath: string,
  platform: 'feishu' | 'telegram',
  entry: FeishuBotJsonEntry | TelegramBotJsonEntry,
): void {
  const config = readBotsConfig(configPath);

  // Check for duplicate names across both platforms
  const allNames = [
    ...(config.feishuBots || []).map((b) => b.name),
    ...(config.telegramBots || []).map((b) => b.name),
  ];
  if (allNames.includes(entry.name)) {
    throw new Error(`Bot with name "${entry.name}" already exists`);
  }

  if (platform === 'feishu') {
    if (!config.feishuBots) config.feishuBots = [];
    config.feishuBots.push(entry as FeishuBotJsonEntry);
  } else {
    if (!config.telegramBots) config.telegramBots = [];
    config.telegramBots.push(entry as TelegramBotJsonEntry);
  }

  writeBotsConfig(configPath, config);
}

export function removeBot(configPath: string, name: string): boolean {
  const config = readBotsConfig(configPath);

  const totalBots = (config.feishuBots?.length || 0) + (config.telegramBots?.length || 0);

  // Find and remove
  if (config.feishuBots) {
    const idx = config.feishuBots.findIndex((b) => b.name === name);
    if (idx !== -1) {
      if (totalBots <= 1) throw new Error('Cannot remove the last bot');
      config.feishuBots.splice(idx, 1);
      writeBotsConfig(configPath, config);
      return true;
    }
  }

  if (config.telegramBots) {
    const idx = config.telegramBots.findIndex((b) => b.name === name);
    if (idx !== -1) {
      if (totalBots <= 1) throw new Error('Cannot remove the last bot');
      config.telegramBots.splice(idx, 1);
      writeBotsConfig(configPath, config);
      return true;
    }
  }

  return false;
}

export function getBotEntry(
  configPath: string,
  name: string,
): { platform: 'feishu' | 'telegram'; entry: FeishuBotJsonEntry | TelegramBotJsonEntry } | null {
  const config = readBotsConfig(configPath);

  const feishu = config.feishuBots?.find((b) => b.name === name);
  if (feishu) return { platform: 'feishu', entry: feishu };

  const telegram = config.telegramBots?.find((b) => b.name === name);
  if (telegram) return { platform: 'telegram', entry: telegram };

  return null;
}
