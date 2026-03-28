import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { generateWechatUin, encryptMedia, decryptMedia } from './wechat-crypto.js';
import type { Logger } from '../utils/logger.js';

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const POLL_TIMEOUT_S = 35;

// --- Types (matching official @tencent-weixin/openclaw-weixin) ---

/** CDN media reference used in image/voice/file/video items. */
export interface CDNMedia {
  encrypt_query_param?: string;
  aes_key?: string; // base64 encoded AES-128 key
}

export interface ILinkMessageItem {
  type: number; // 1=TEXT, 2=IMAGE, 3=VOICE, 4=FILE, 5=VIDEO
  text_item?: { text: string };
  image_item?: CDNMedia;
  voice_item?: CDNMedia & { transcription?: string };
  file_item?: CDNMedia & { filename?: string };
  video_item?: CDNMedia & { thumb?: CDNMedia };
  ref_msg?: { message_id?: number; from_user_id?: string; item_list?: ILinkMessageItem[] };
}

export interface ILinkMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  create_time_ms?: number;
  session_id?: string;
  message_type?: number; // 1=USER, 2=BOT
  message_state?: number; // 0=NEW, 1=GENERATING, 2=FINISH
  item_list?: ILinkMessageItem[];
  context_token?: string;
}

interface GetUpdatesResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: ILinkMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

interface QrCodeResponse {
  ret?: number;
  qrcode: string;               // QR code ID for status polling
  qrcode_img_content?: string;  // scannable URL
}

interface QrStatusResponse {
  ret?: number;
  status: string; // 'wait', 'scanned', 'confirmed', 'expired'
  bot_token?: string;
  baseurl?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
}

interface GetConfigResponse {
  ret?: number;
  typing_ticket?: string;
}

interface UploadUrlResponse {
  upload_param?: string; // encrypted upload param
  thumb_upload_param?: string;
}

interface TokenStore {
  tokens: Record<string, { botToken: string; typingTicket: string; loginTime: number }>;
}

// --- Client ---

export class WechatClient {
  private botToken: string | undefined;
  private cursor = '';
  private typingTicket = '';
  private contextTokens = new Map<string, string>();
  private baseUrl: string;
  private logger: Logger;

  constructor(baseUrl: string | undefined, logger: Logger) {
    this.baseUrl = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.logger = logger;
  }

  get isAuthenticated(): boolean {
    return !!this.botToken;
  }

  /** Set token directly (from config or persisted store). */
  setToken(token: string): void {
    this.botToken = token;
  }

  /** Set typing ticket directly (from persisted store). */
  setTypingTicket(ticket: string): void {
    this.typingTicket = ticket;
  }

  /** Get the latest context_token for a chat. */
  getContextToken(chatId: string): string | undefined {
    return this.contextTokens.get(chatId);
  }

  // --- Auth ---

  async login(): Promise<{ botToken: string; qrUrl: string }> {
    this.logger.info('Starting WeChat iLink QR login...');

    const qrRes = await this.request<QrCodeResponse>('GET', '/ilink/bot/get_bot_qrcode?bot_type=3', undefined, false);
    const qrUrl = qrRes.qrcode_img_content || '';
    const qrId = qrRes.qrcode;

    this.logger.info({ qrUrl, qrId }, 'QR code generated — scan with WeChat');

    // Print QR URL for terminal access
    console.log('\n=== WeChat QR Login ===');
    console.log(`Open this URL or scan the QR code: ${qrUrl}`);
    console.log('Waiting for scan...\n');

    // Poll for scan status (API may long-poll ~30s or return immediately)
    let token: string | undefined;
    const maxAttempts = 60; // ~5 minutes with 5s intervals
    for (let i = 0; i < maxAttempts; i++) {
      const statusRes = await this.request<QrStatusResponse>(
        'GET',
        `/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrId)}`,
        undefined,
        false,
        45000, // 45s timeout — API may long-poll for ~30s
      );

      this.logger.debug({ status: statusRes.status, attempt: i + 1 }, 'QR status poll');

      if (statusRes.status === 'confirmed' && statusRes.bot_token) {
        token = statusRes.bot_token;
        if (statusRes.baseurl) {
          this.baseUrl = statusRes.baseurl;
        }
        break;
      }

      if (statusRes.status === 'scanned') {
        this.logger.info('QR code scanned, waiting for confirmation...');
      }

      if (statusRes.status === 'expired') {
        throw new Error('WeChat QR code expired. Please restart to try again.');
      }

      await sleep(5000);
    }

    if (!token) {
      throw new Error('WeChat QR login timed out after 5 minutes.');
    }

    this.botToken = token;
    this.logger.info('WeChat iLink login successful');

    // Fetch typing ticket
    await this.fetchConfig();

    return { botToken: token, qrUrl };
  }

  async fetchConfig(userId?: string): Promise<void> {
    try {
      const body: Record<string, unknown> = {};
      if (userId) {
        body.ilink_user_id = userId;
      }
      const res = await this.request<GetConfigResponse>('POST', '/ilink/bot/getconfig', body);
      if (res.typing_ticket) {
        this.typingTicket = res.typing_ticket;
      }
    } catch (err) {
      this.logger.warn({ err }, 'Failed to fetch iLink config (typing ticket)');
    }
  }

  // --- Messages ---

  async getUpdates(timeoutS: number = POLL_TIMEOUT_S): Promise<ILinkMessage[]> {
    const body: Record<string, unknown> = {
      get_updates_buf: this.cursor || '',
    };

    const res = await this.request<GetUpdatesResponse>('POST', '/ilink/bot/getupdates', body, true, timeoutS * 1000 + 5000);

    // Check for errors
    if (res.ret !== undefined && res.ret !== 0) {
      if (res.errcode === -14) {
        // Session timeout, just continue polling
        this.logger.debug('iLink session timeout, continuing...');
      } else {
        this.logger.warn({ ret: res.ret, errcode: res.errcode, errmsg: res.errmsg }, 'iLink getupdates error');
      }
    }

    // Update cursor
    if (res.get_updates_buf) {
      this.cursor = res.get_updates_buf;
    }

    const messages = res.msgs || [];

    // Track context tokens
    for (const msg of messages) {
      if (msg.context_token && msg.from_user_id) {
        this.contextTokens.set(msg.from_user_id, msg.context_token);
      }
    }

    return messages;
  }

  /**
   * Send a message. Use clientId + messageState for streaming:
   * - messageState=1 (GENERATING): shows as "typing/generating" in WeChat, can be updated
   * - messageState=2 (FINISH): final message, same clientId replaces the GENERATING one
   */
  async sendMessage(
    toUserId: string,
    items: ILinkMessageItem[],
    opts?: { clientId?: string; messageState?: number },
  ): Promise<string> {
    const contextToken = this.contextTokens.get(toUserId);
    const clientId = opts?.clientId || `metabot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const messageState = opts?.messageState ?? 2; // default FINISH

    const body = {
      msg: {
        from_user_id: '',
        to_user_id: toUserId,
        client_id: clientId,
        message_type: 2, // BOT
        message_state: messageState,
        ...(contextToken ? { context_token: contextToken } : {}),
        item_list: items,
      },
    };

    await this.request<Record<string, unknown>>('POST', '/ilink/bot/sendmessage', body);
    return clientId;
  }

  async sendTextMessage(toUserId: string, text: string, opts?: { clientId?: string; messageState?: number }): Promise<string> {
    return this.sendMessage(toUserId, [
      { type: 1, text_item: { text } },
    ], opts);
  }

  async sendTyping(toUserId: string, cancel = false): Promise<void> {
    if (!this.typingTicket) return;
    try {
      await this.request('POST', '/ilink/bot/sendtyping', {
        ilink_user_id: toUserId,
        typing_ticket: this.typingTicket,
        status: cancel ? 2 : 1, // 1 = typing, 2 = cancel
      });
    } catch {
      // Typing is best-effort
    }
  }

  // --- Media ---

  async uploadMedia(
    filePath: string,
    mediaType: number, // 1=IMAGE, 2=VIDEO, 3=FILE
    toUserId: string,
  ): Promise<{ encryptQueryParam: string; aesKey: string } | undefined> {
    const fileData = fs.readFileSync(filePath);
    const rawSize = fileData.length;
    const rawMd5 = crypto.createHash('md5').update(fileData).digest('hex');

    // Encrypt
    const { encrypted, key } = encryptMedia(fileData);
    const encryptedSize = encrypted.length;
    const aesKeyBase64 = key.toString('base64');

    // Build upload request
    const filekey = `metabot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const uploadReqBody: Record<string, unknown> = {
      filekey,
      media_type: mediaType,
      to_user_id: toUserId,
      rawsize: rawSize,
      rawfilemd5: rawMd5,
      filesize: encryptedSize,
    };

    // For images/videos, generate a simple thumbnail (just use same file for now)
    if (mediaType === 1 || mediaType === 2) {
      uploadReqBody.thumb_rawsize = rawSize;
      uploadReqBody.thumb_rawfilemd5 = rawMd5;
      uploadReqBody.thumb_filesize = encryptedSize;
    }

    const uploadRes = await this.request<UploadUrlResponse>('POST', '/ilink/bot/getuploadurl', uploadReqBody);

    if (!uploadRes.upload_param) {
      this.logger.error('Failed to get upload_param from iLink');
      return undefined;
    }

    // The upload_param is an encrypted string used as CDN upload URL query param
    // Upload encrypted file to CDN
    const cdnUrl = `https://novac2c.cdn.weixin.qq.com/c2c?${uploadRes.upload_param}`;
    const uploadResp = await fetch(cdnUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(encryptedSize),
      },
      body: new Uint8Array(encrypted),
    });

    if (!uploadResp.ok) {
      this.logger.error({ status: uploadResp.status }, 'CDN upload failed');
      return undefined;
    }

    return {
      encryptQueryParam: uploadRes.upload_param,
      aesKey: aesKeyBase64,
    };
  }

  async downloadMedia(encryptQueryParam: string, aesKeyBase64: string, savePath: string): Promise<boolean> {
    try {
      const cdnUrl = `https://novac2c.cdn.weixin.qq.com/c2c?${encryptQueryParam}`;
      const resp = await fetch(cdnUrl);
      if (!resp.ok) return false;

      const encryptedBuf = Buffer.from(await resp.arrayBuffer());
      const key = Buffer.from(aesKeyBase64, 'base64');
      const decrypted = decryptMedia(encryptedBuf, key);

      fs.writeFileSync(savePath, decrypted);
      return true;
    } catch (err) {
      this.logger.error({ err }, 'Failed to download WeChat media');
      return false;
    }
  }

  // --- Token persistence ---

  saveToken(dataDir: string, botName: string): void {
    if (!this.botToken) return;
    const filePath = path.join(dataDir, 'wechat-tokens.json');

    let store: TokenStore = { tokens: {} };
    try {
      if (fs.existsSync(filePath)) {
        store = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as TokenStore;
      }
    } catch {
      // Start fresh
    }

    store.tokens[botName] = {
      botToken: this.botToken,
      typingTicket: this.typingTicket,
      loginTime: Date.now(),
    };

    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(store, null, 2));
    this.logger.info({ botName, filePath }, 'WeChat token saved');
  }

  static loadToken(dataDir: string, botName: string): { botToken: string; typingTicket: string } | undefined {
    const filePath = path.join(dataDir, 'wechat-tokens.json');
    try {
      if (!fs.existsSync(filePath)) return undefined;
      const store = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as TokenStore;
      const entry = store.tokens[botName];
      if (!entry?.botToken) return undefined;
      return { botToken: entry.botToken, typingTicket: entry.typingTicket };
    } catch {
      return undefined;
    }
  }

  // --- HTTP helpers ---

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'AuthorizationType': 'ilink_bot_token',
      'X-WECHAT-UIN': generateWechatUin(),
    };
    if (this.botToken) {
      headers['Authorization'] = `Bearer ${this.botToken}`;
    }
    return headers;
  }

  private async request<T>(
    method: string,
    endpoint: string,
    body?: unknown,
    requireAuth = true,
    timeoutMs = 15000,
  ): Promise<T> {
    if (requireAuth && !this.botToken) {
      throw new Error('WeChat client not authenticated');
    }

    const url = `${this.baseUrl}${endpoint}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const resp = await fetch(url, {
        method,
        headers: this.buildHeaders(),
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`iLink API ${method} ${endpoint} failed: ${resp.status} ${text}`);
      }

      return (await resp.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
