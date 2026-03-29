import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BotsJsonNewFormat, FeishuBotJsonEntry, TelegramBotJsonEntry, WebBotJsonEntry, WechatBotJsonEntry } from '../config.js';

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

/** Collect all bot names across all platforms. */
function allBotNames(config: BotsJsonNewFormat): string[] {
  return [
    ...(config.feishuBots || []).map((b) => b.name),
    ...(config.telegramBots || []).map((b) => b.name),
    ...(config.webBots || []).map((b) => b.name),
    ...(config.wechatBots || []).map((b) => b.name),
  ];
}

export function addBot(
  configPath: string,
  platform: 'feishu' | 'telegram' | 'web' | 'wechat',
  entry: FeishuBotJsonEntry | TelegramBotJsonEntry | WebBotJsonEntry | WechatBotJsonEntry,
): void {
  const config = readBotsConfig(configPath);

  // Check for duplicate names across all platforms
  if (allBotNames(config).includes(entry.name)) {
    throw new Error(`Bot with name "${entry.name}" already exists`);
  }

  if (platform === 'feishu') {
    if (!config.feishuBots) config.feishuBots = [];
    config.feishuBots.push(entry as FeishuBotJsonEntry);
  } else if (platform === 'telegram') {
    if (!config.telegramBots) config.telegramBots = [];
    config.telegramBots.push(entry as TelegramBotJsonEntry);
  } else {
    if (platform === 'web') {
      if (!config.webBots) config.webBots = [];
      config.webBots.push(entry as WebBotJsonEntry);
    } else {
      if (!config.wechatBots) config.wechatBots = [];
      config.wechatBots.push(entry as WechatBotJsonEntry);
    }
  }

  writeBotsConfig(configPath, config);
}

export function removeBot(configPath: string, name: string): boolean {
  const config = readBotsConfig(configPath);

  const totalBots = (config.feishuBots?.length || 0) + (config.telegramBots?.length || 0) + (config.webBots?.length || 0) + (config.wechatBots?.length || 0);

  // Find and remove from feishu
  if (config.feishuBots) {
    const idx = config.feishuBots.findIndex((b) => b.name === name);
    if (idx !== -1) {
      if (totalBots <= 1) throw new Error('Cannot remove the last bot');
      config.feishuBots.splice(idx, 1);
      writeBotsConfig(configPath, config);
      return true;
    }
  }

  // Find and remove from telegram
  if (config.telegramBots) {
    const idx = config.telegramBots.findIndex((b) => b.name === name);
    if (idx !== -1) {
      if (totalBots <= 1) throw new Error('Cannot remove the last bot');
      config.telegramBots.splice(idx, 1);
      writeBotsConfig(configPath, config);
      return true;
    }
  }

  // Find and remove from web
  if (config.webBots) {
    const idx = config.webBots.findIndex((b) => b.name === name);
    if (idx !== -1) {
      if (totalBots <= 1) throw new Error('Cannot remove the last bot');
      config.webBots.splice(idx, 1);
      writeBotsConfig(configPath, config);
      return true;
    }
  }

  if (config.wechatBots) {
    const idx = config.wechatBots.findIndex((b) => b.name === name);
    if (idx !== -1) {
      if (totalBots <= 1) throw new Error('Cannot remove the last bot');
      config.wechatBots.splice(idx, 1);
      writeBotsConfig(configPath, config);
      return true;
    }
  }

  return false;
}

export function getBotEntry(
  configPath: string,
  name: string,
): { platform: 'feishu' | 'telegram' | 'web' | 'wechat'; entry: FeishuBotJsonEntry | TelegramBotJsonEntry | WebBotJsonEntry | WechatBotJsonEntry } | null {
  const config = readBotsConfig(configPath);

  const feishu = config.feishuBots?.find((b) => b.name === name);
  if (feishu) return { platform: 'feishu', entry: feishu };

  const telegram = config.telegramBots?.find((b) => b.name === name);
  if (telegram) return { platform: 'telegram', entry: telegram };

  const web = config.webBots?.find((b) => b.name === name);
  if (web) return { platform: 'web', entry: web };

  const wechat = config.wechatBots?.find((b) => b.name === name);
  if (wechat) return { platform: 'wechat', entry: wechat };

  return null;
}
