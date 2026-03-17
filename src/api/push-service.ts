import * as http2 from 'node:http2';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import type { Logger } from '../utils/logger.js';
import type { DeviceStore } from './device-store.js';
import type { CardState } from '../types.js';

export interface APNsConfig {
  keyPath: string;       // Path to .p8 key file
  keyId: string;         // 10-char key ID from Apple
  teamId: string;        // 10-char team ID
  bundleId: string;      // e.g. com.metabot.app
  production: boolean;   // true = api.push.apple.com, false = sandbox
}

/**
 * APNs push notification service using HTTP/2 with token-based (JWT) auth.
 * Zero npm dependencies — uses Node.js built-in http2 module.
 */
export class PushService {
  private config: APNsConfig;
  private deviceStore: DeviceStore;
  private logger: Logger;
  private signingKey: crypto.KeyObject;
  private session: http2.ClientHttp2Session | null = null;
  private jwt: string | null = null;
  private jwtExpiry = 0;

  constructor(config: APNsConfig, deviceStore: DeviceStore, logger: Logger) {
    this.config = config;
    this.deviceStore = deviceStore;
    this.logger = logger.child({ module: 'apns' });

    // Load the .p8 private key
    const keyData = fs.readFileSync(config.keyPath, 'utf-8');
    this.signingKey = crypto.createPrivateKey(keyData);
    this.logger.info({ keyId: config.keyId, bundleId: config.bundleId, production: config.production }, 'APNs push service initialized');
  }

  /** Check if the push service is configured and ready. */
  isConfigured(): boolean {
    return !!this.signingKey;
  }

  /**
   * Send push notification to all devices registered for a chatId.
   * Skips sending if the chatId has no registered tokens.
   */
  async notifyTaskComplete(chatId: string, state: CardState, botName: string): Promise<void> {
    const tokens = this.deviceStore.getTokens(chatId);
    if (tokens.length === 0) return;

    const statusEmoji = state.status === 'complete' ? '✅' : '❌';
    const title = `${statusEmoji} ${botName}`;

    // Truncate response text for notification body
    let body = state.responseText || (state.status === 'error' ? (state.errorMessage || 'Task failed') : 'Task completed');
    if (body.length > 200) body = body.slice(0, 197) + '...';
    // Strip markdown for cleaner notification text
    body = body.replace(/[*_`#\[\]]/g, '').replace(/\n{2,}/g, '\n').trim();

    const results = await Promise.allSettled(
      tokens.map((token) => this.sendNotification(token, { title, body, chatId, botName })),
    );

    let sent = 0;
    let failed = 0;
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) sent++;
      else failed++;
    }

    if (sent > 0 || failed > 0) {
      this.logger.info({ chatId, sent, failed, total: tokens.length }, 'Push notifications sent');
    }
  }

  /** Notify when AI has a question waiting for user input */
  async notifyPendingQuestion(chatId: string, question: string, botName: string): Promise<void> {
    const tokens = this.deviceStore.getTokens(chatId);
    if (tokens.length === 0) return;

    const title = `❓ ${botName}`;
    let body = question || 'Waiting for your response';
    if (body.length > 200) body = body.slice(0, 197) + '...';
    body = body.replace(/[*_`#[\]]/g, '').replace(/\n{2,}/g, '\n').trim();

    const results = await Promise.allSettled(
      tokens.map((token) => this.sendNotification(token, { title, body, chatId, botName })),
    );

    let sent = 0;
    let failed = 0;
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) sent++;
      else failed++;
    }
    if (sent > 0 || failed > 0) {
      this.logger.info({ chatId, sent, failed }, 'Pending question push sent');
    }
  }

  /** Notify for incoming RTC voice call */
  async notifyIncomingCall(chatId: string, botName: string, callData?: Record<string, string>): Promise<void> {
    const tokens = this.deviceStore.getTokens(chatId);
    if (tokens.length === 0) return;

    const title = `📞 ${botName}`;
    const body = 'Incoming voice call';

    const results = await Promise.allSettled(
      tokens.map((token) => this.sendNotification(token, {
        title, body, chatId, botName, type: 'incoming_call', ...callData,
      })),
    );

    let sent = 0;
    let failed = 0;
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) sent++;
      else failed++;
    }
    if (sent > 0 || failed > 0) {
      this.logger.info({ chatId, sent, failed }, 'Incoming call push sent');
    }
  }

  /** Send a single push notification to a device token. Returns true on success. */
  async sendNotification(
    deviceToken: string,
    payload: { title: string; body: string; chatId: string; botName?: string; [key: string]: unknown },
  ): Promise<boolean> {
    const { title, body, chatId, botName, ...extra } = payload;
    const apnsPayload: Record<string, unknown> = {
      aps: {
        alert: { title, body },
        sound: title.startsWith('📞') ? 'default' : 'default',
        badge: 1,
        'thread-id': chatId,
        'mutable-content': 1,
      },
      chatId,
      botName,
      ...extra,
    };

    try {
      const session = this.getSession();
      const jwt = this.getJWT();

      const headers = {
        [http2.constants.HTTP2_HEADER_METHOD]: 'POST',
        [http2.constants.HTTP2_HEADER_PATH]: `/3/device/${deviceToken}`,
        'authorization': `bearer ${jwt}`,
        'apns-topic': this.config.bundleId,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-expiration': '0',
      };

      const body = JSON.stringify(apnsPayload);

      return await new Promise<boolean>((resolve) => {
        const req = session.request(headers);
        let status = 0;
        let responseData = '';

        req.on('response', (responseHeaders) => {
          status = Number(responseHeaders[http2.constants.HTTP2_HEADER_STATUS]) || 0;
        });

        req.on('data', (chunk: Buffer) => {
          responseData += chunk.toString();
        });

        req.on('end', () => {
          if (status === 200) {
            resolve(true);
          } else if (status === 410) {
            // Token is no longer valid — remove it
            this.logger.info({ tokenPrefix: deviceToken.slice(0, 8) }, 'APNs token expired (410), removing');
            this.deviceStore.removeToken(deviceToken);
            resolve(false);
          } else {
            this.logger.warn({ status, response: responseData, tokenPrefix: deviceToken.slice(0, 8) }, 'APNs send failed');
            resolve(false);
          }
        });

        req.on('error', (err) => {
          this.logger.warn({ err, tokenPrefix: deviceToken.slice(0, 8) }, 'APNs request error');
          resolve(false);
        });

        req.end(body);

        // Timeout after 10s
        req.setTimeout(10_000, () => {
          req.close();
          resolve(false);
        });
      });
    } catch (err) {
      this.logger.warn({ err }, 'APNs send exception');
      return false;
    }
  }

  /** Close the HTTP/2 session. */
  destroy(): void {
    if (this.session && !this.session.closed && !this.session.destroyed) {
      this.session.close();
    }
    this.session = null;
  }

  private getSession(): http2.ClientHttp2Session {
    if (this.session && !this.session.closed && !this.session.destroyed) {
      return this.session;
    }

    const host = this.config.production
      ? 'https://api.push.apple.com'
      : 'https://api.sandbox.push.apple.com';

    this.session = http2.connect(host);
    this.session.on('error', (err) => {
      this.logger.warn({ err }, 'APNs HTTP/2 session error');
      this.session = null;
    });
    this.session.on('close', () => {
      this.session = null;
    });

    return this.session;
  }

  /** Generate or return cached JWT for APNs auth. Cached for 50 minutes. */
  private getJWT(): string {
    const now = Math.floor(Date.now() / 1000);
    if (this.jwt && now < this.jwtExpiry) return this.jwt;

    // Create JWT header + claims
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: this.config.keyId })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({ iss: this.config.teamId, iat: now })).toString('base64url');

    // Sign with ES256
    const signature = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), this.signingKey);

    this.jwt = `${header}.${claims}.${signature.toString('base64url')}`;
    this.jwtExpiry = now + 50 * 60; // Cache for 50 minutes (APNs allows 1 hour)

    return this.jwt;
  }
}
