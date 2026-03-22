/**
 * iLink API client for WeChat personal account bot.
 *
 * Implements the Tencent iLink protocol (https://ilinkai.weixin.qq.com)
 * using HTTP long-polling for message reception and REST API for sending.
 *
 * All CDN media is encrypted with AES-128-ECB.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ILinkCredentials {
  botToken: string;
}

/** Message types from the iLink getupdates response. */
export const enum ILinkMessageType {
  TEXT = 1,
  IMAGE = 2,
  VOICE = 3,
  FILE = 4,
  VIDEO = 5,
}

export interface ILinkTextItem {
  text: string;
}

export interface ILinkImageItem {
  image_url: string;
  encrypt_query_param?: string;
  aes_key?: string;
  file_md5?: string;
  file_size?: number;
}

export interface ILinkFileItem {
  file_name: string;
  file_url: string;
  encrypt_query_param?: string;
  aes_key?: string;
  file_md5?: string;
  file_size?: number;
}

export interface ILinkVoiceItem {
  voice_url: string;
  duration?: number;
  voice_text?: string;
  encrypt_query_param?: string;
  aes_key?: string;
}

export interface ILinkVideoItem {
  video_url: string;
  thumb_url?: string;
  duration?: number;
  encrypt_query_param?: string;
  aes_key?: string;
  file_size?: number;
}

export interface ILinkMessage {
  from_user_id: string;
  to_user_id: string;
  context_token: string;
  type: ILinkMessageType;
  message_type: number; // 1=USER, 2=BOT
  message_state?: number; // 0=NEW, 1=GENERATING, 2=FINISH
  text_item?: ILinkTextItem;
  image_item?: ILinkImageItem;
  file_item?: ILinkFileItem;
  voice_item?: ILinkVoiceItem;
  video_item?: ILinkVideoItem;
  ref_msg?: unknown;
}

export interface ILinkGetUpdatesResponse {
  errcode: number;
  errmsg: string;
  get_updates_buf?: string;
  msgs?: ILinkMessage[];
}

export interface ILinkSendMessageResponse {
  errcode: number;
  errmsg: string;
}

export interface ILinkUploadUrlResponse {
  errcode: number;
  errmsg: string;
  upload_url?: string;
  download_url?: string;
  encrypt_query_param?: string;
}

export interface ILinkQrCodeResponse {
  errcode: number;
  errmsg: string;
  qrcode_url?: string;
  qrcode?: string;
}

export interface ILinkQrCodeStatusResponse {
  errcode: number;
  errmsg: string;
  status?: number; // 0=pending, 1=scanned, 2=confirmed, 3=expired
  bot_token?: string;
}

// ---------------------------------------------------------------------------
// AES-128-ECB helpers for CDN media
// ---------------------------------------------------------------------------

function aesEcbEncrypt(data: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

function aesEcbDecrypt(data: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

// ---------------------------------------------------------------------------
// iLink HTTP client
// ---------------------------------------------------------------------------

const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com';
const LONG_POLL_TIMEOUT_MS = 40_000; // slightly above server's 35s hold

export class ILinkClient {
  private botToken: string;
  private logger: Logger;
  private syncBuf: string | undefined;
  private abortController: AbortController | undefined;

  constructor(credentials: ILinkCredentials, logger: Logger) {
    this.botToken = credentials.botToken;
    this.logger = logger;
  }

  // ---- Authentication headers ----

  private headers(): Record<string, string> {
    const uin = crypto.randomBytes(4).readUInt32LE(0);
    return {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      Authorization: `Bearer ${this.botToken}`,
      'X-WECHAT-UIN': Buffer.from(String(uin)).toString('base64'),
    };
  }

  // ---- Generic fetch helper ----

  private async post<T>(path: string, body: unknown, timeoutMs = 10_000): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${ILINK_BASE_URL}${path}`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`iLink API ${path} HTTP ${res.status}: ${text}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private async get<T>(path: string, timeoutMs = 10_000): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${ILINK_BASE_URL}${path}`, {
        method: 'GET',
        headers: this.headers(),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`iLink API ${path} HTTP ${res.status}: ${text}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- QR Code login ----

  async getLoginQrCode(): Promise<ILinkQrCodeResponse> {
    return this.get<ILinkQrCodeResponse>('/ilink/bot/get_bot_qrcode?bot_type=3');
  }

  async pollQrCodeStatus(qrcode: string): Promise<ILinkQrCodeStatusResponse> {
    return this.get<ILinkQrCodeStatusResponse>(
      `/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
      60_000, // long-poll
    );
  }

  // ---- Long-poll for incoming messages ----

  async getUpdates(): Promise<ILinkGetUpdatesResponse> {
    this.abortController = new AbortController();
    const timer = setTimeout(() => this.abortController?.abort(), LONG_POLL_TIMEOUT_MS);
    try {
      const body: Record<string, unknown> = {};
      if (this.syncBuf) {
        body.get_updates_buf = this.syncBuf;
      }
      const res = await fetch(`${ILINK_BASE_URL}/ilink/bot/getupdates`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: this.abortController.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`iLink getupdates HTTP ${res.status}: ${text}`);
      }
      const data = (await res.json()) as ILinkGetUpdatesResponse;
      if (data.get_updates_buf) {
        this.syncBuf = data.get_updates_buf;
      }
      return data;
    } finally {
      clearTimeout(timer);
      this.abortController = undefined;
    }
  }

  /** Abort any in-flight long-poll. */
  abortPoll(): void {
    this.abortController?.abort();
  }

  // ---- Send messages ----

  async sendText(toUserId: string, contextToken: string, text: string): Promise<ILinkSendMessageResponse> {
    return this.post<ILinkSendMessageResponse>('/ilink/bot/sendmessage', {
      to_user_id: toUserId,
      context_token: contextToken,
      type: ILinkMessageType.TEXT,
      message_state: 2, // FINISH
      text_item: { text },
    });
  }

  async sendTextStreaming(toUserId: string, contextToken: string, text: string, state: 0 | 1 | 2): Promise<ILinkSendMessageResponse> {
    return this.post<ILinkSendMessageResponse>('/ilink/bot/sendmessage', {
      to_user_id: toUserId,
      context_token: contextToken,
      type: ILinkMessageType.TEXT,
      message_state: state, // 0=NEW, 1=GENERATING, 2=FINISH
      text_item: { text },
    });
  }

  async sendImage(
    toUserId: string,
    contextToken: string,
    downloadUrl: string,
    encryptQueryParam: string,
    aesKey: string,
  ): Promise<ILinkSendMessageResponse> {
    return this.post<ILinkSendMessageResponse>('/ilink/bot/sendmessage', {
      to_user_id: toUserId,
      context_token: contextToken,
      type: ILinkMessageType.IMAGE,
      message_state: 2,
      image_item: {
        image_url: downloadUrl,
        encrypt_query_param: encryptQueryParam,
        aes_key: aesKey,
      },
    });
  }

  async sendFile(
    toUserId: string,
    contextToken: string,
    fileName: string,
    downloadUrl: string,
    encryptQueryParam: string,
    aesKey: string,
    fileSize: number,
  ): Promise<ILinkSendMessageResponse> {
    return this.post<ILinkSendMessageResponse>('/ilink/bot/sendmessage', {
      to_user_id: toUserId,
      context_token: contextToken,
      type: ILinkMessageType.FILE,
      message_state: 2,
      file_item: {
        file_name: fileName,
        file_url: downloadUrl,
        encrypt_query_param: encryptQueryParam,
        aes_key: aesKey,
        file_size: fileSize,
      },
    });
  }

  // ---- Typing indicator ----

  async sendTyping(toUserId: string, contextToken: string, cancel = false): Promise<void> {
    try {
      await this.post('/ilink/bot/sendtyping', {
        to_user_id: toUserId,
        context_token: contextToken,
        typing_status: cancel ? 2 : 1,
      });
    } catch {
      // Typing indicator failures are non-critical
    }
  }

  // ---- CDN upload (for sending images/files) ----

  async uploadFile(filePath: string): Promise<{ downloadUrl: string; encryptQueryParam: string; aesKeyBase64: string; fileSize: number }> {
    const fileData = fs.readFileSync(filePath);
    const aesKey = crypto.randomBytes(16);
    const encrypted = aesEcbEncrypt(fileData, aesKey);
    const fileMd5 = crypto.createHash('md5').update(encrypted).digest('hex');

    // Get presigned upload URL
    const uploadInfo = await this.post<ILinkUploadUrlResponse>('/ilink/bot/getuploadurl', {
      file_name: path.basename(filePath),
      file_size: encrypted.length,
      file_md5: fileMd5,
    });

    if (!uploadInfo.upload_url || !uploadInfo.download_url) {
      throw new Error(`iLink getuploadurl failed: ${uploadInfo.errmsg}`);
    }

    // PUT encrypted file to CDN
    const putRes = await fetch(uploadInfo.upload_url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(encrypted),
    });
    if (!putRes.ok) {
      throw new Error(`CDN upload failed: HTTP ${putRes.status}`);
    }

    return {
      downloadUrl: uploadInfo.download_url,
      encryptQueryParam: uploadInfo.encrypt_query_param || '',
      aesKeyBase64: aesKey.toString('base64'),
      fileSize: fileData.length,
    };
  }

  // ---- CDN download (for receiving images/files) ----

  async downloadMedia(url: string, aesKeyBase64: string | undefined, savePath: string): Promise<void> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`CDN download failed: HTTP ${res.status}`);

    const encrypted = Buffer.from(await res.arrayBuffer());

    let data: Buffer;
    if (aesKeyBase64) {
      const key = Buffer.from(aesKeyBase64, 'base64');
      data = aesEcbDecrypt(encrypted, key);
    } else {
      data = encrypted;
    }

    fs.mkdirSync(path.dirname(savePath), { recursive: true });
    fs.writeFileSync(savePath, data);
  }

  // ---- Sync buffer persistence ----

  getSyncBuf(): string | undefined {
    return this.syncBuf;
  }

  setSyncBuf(buf: string): void {
    this.syncBuf = buf;
  }
}
