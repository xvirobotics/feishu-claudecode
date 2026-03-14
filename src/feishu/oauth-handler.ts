/**
 * Feishu OAuth 2.0 handler: authorization URL generation, code exchange, token refresh.
 * Uses the OIDC endpoints (v1) for user_access_token management.
 */
import * as crypto from 'node:crypto';
import type { Logger } from '../utils/logger.js';
import { OAuthStore, type OAuthToken } from './oauth-store.js';

const AUTH_BASE_URL = 'https://open.feishu.cn/open-apis/authen/v1/authorize';
const TOKEN_URL = 'https://open.feishu.cn/open-apis/authen/v1/oidc/access_token';
const REFRESH_URL = 'https://open.feishu.cn/open-apis/authen/v1/oidc/refresh_access_token';

interface TokenResponse {
  code: number;
  msg: string;
  data?: {
    access_token: string;
    refresh_token: string;
    token_type: string;
    expires_in: number;
    scope: string;
    open_id?: string;
    union_id?: string;
  };
}

/** Pending OAuth state → userId mapping (in-memory, short-lived). */
const pendingStates = new Map<string, { userId: string; chatId: string; createdAt: number }>();
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export class OAuthHandler {
  private store: OAuthStore;

  constructor(
    private appId: string,
    private appSecret: string,
    databaseDir: string,
    private logger: Logger,
  ) {
    this.store = new OAuthStore(databaseDir, logger);
  }

  /**
   * Build the Feishu OAuth authorization URL.
   * Returns { url, state } — state is used to correlate the callback.
   */
  buildAuthUrl(redirectUri: string, userId: string, chatId: string, scopes: string): { url: string; state: string } {
    const state = crypto.randomBytes(16).toString('hex');
    pendingStates.set(state, { userId, chatId, createdAt: Date.now() });

    // Cleanup expired states
    for (const [key, val] of pendingStates) {
      if (Date.now() - val.createdAt > STATE_TTL_MS) {
        pendingStates.delete(key);
      }
    }

    const params = new URLSearchParams({
      app_id: this.appId,
      redirect_uri: redirectUri,
      response_type: 'code',
      state,
      scope: scopes,
    });

    return { url: `${AUTH_BASE_URL}?${params.toString()}`, state };
  }

  /** Validate and consume a pending state. Returns userId+chatId or undefined. */
  consumeState(state: string): { userId: string; chatId: string } | undefined {
    const pending = pendingStates.get(state);
    if (!pending) return undefined;
    if (Date.now() - pending.createdAt > STATE_TTL_MS) {
      pendingStates.delete(state);
      return undefined;
    }
    pendingStates.delete(state);
    return { userId: pending.userId, chatId: pending.chatId };
  }

  /** Exchange authorization code for user_access_token. */
  async exchangeCode(code: string): Promise<OAuthToken> {
    const resp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: this.appId,
        client_secret: this.appSecret,
        code,
      }),
    });

    const json = await resp.json() as TokenResponse;
    if (json.code !== 0 || !json.data) {
      throw new Error(`OAuth token exchange failed: ${json.msg} (code: ${json.code})`);
    }

    const now = new Date();
    const token: OAuthToken = {
      userId: json.data.open_id || '',
      accessToken: json.data.access_token,
      refreshToken: json.data.refresh_token,
      expiresAt: Math.floor(now.getTime() / 1000) + json.data.expires_in,
      scopes: json.data.scope || '',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    this.store.saveToken(token);
    this.logger.info({ userId: token.userId, scopes: token.scopes }, 'OAuth token saved');
    return token;
  }

  /** Refresh an expired user_access_token. */
  async refreshToken(userId: string): Promise<OAuthToken | undefined> {
    const existing = this.store.getToken(userId);
    if (!existing) return undefined;

    const resp = await fetch(REFRESH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: this.appId,
        client_secret: this.appSecret,
        refresh_token: existing.refreshToken,
      }),
    });

    const json = await resp.json() as TokenResponse;
    if (json.code !== 0 || !json.data) {
      this.logger.error({ userId, code: json.code, msg: json.msg }, 'OAuth token refresh failed');
      // If refresh fails, delete the stale token
      this.store.deleteToken(userId);
      return undefined;
    }

    const now = new Date();
    const token: OAuthToken = {
      userId,
      accessToken: json.data.access_token,
      refreshToken: json.data.refresh_token,
      expiresAt: Math.floor(now.getTime() / 1000) + json.data.expires_in,
      scopes: json.data.scope || existing.scopes,
      createdAt: existing.createdAt,
      updatedAt: now.toISOString(),
    };

    this.store.saveToken(token);
    this.logger.info({ userId }, 'OAuth token refreshed');
    return token;
  }

  /**
   * Get a valid user_access_token, auto-refreshing if needed.
   * Returns the token string or undefined if not authorized.
   */
  async getValidToken(userId: string): Promise<string | undefined> {
    const token = this.store.getToken(userId);
    if (!token) return undefined;

    if (!this.store.isExpired(token)) {
      return token.accessToken;
    }

    // Try refresh
    const refreshed = await this.refreshToken(userId);
    return refreshed?.accessToken;
  }

  /** Check if a user has an active OAuth token. */
  hasToken(userId: string): boolean {
    return !!this.store.getToken(userId);
  }

  /** Get token info (without the actual token values, for status display). */
  getTokenInfo(userId: string): { authorized: boolean; scopes: string; expiresAt: number; updatedAt: string } | undefined {
    const token = this.store.getToken(userId);
    if (!token) return undefined;
    return {
      authorized: true,
      scopes: token.scopes,
      expiresAt: token.expiresAt,
      updatedAt: token.updatedAt,
    };
  }

  /** Revoke (delete) a user's OAuth token. */
  revoke(userId: string): boolean {
    return this.store.deleteToken(userId);
  }

  close(): void {
    this.store.close();
  }
}
