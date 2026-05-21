/**
 * Feishu user OAuth helpers — drives the "查看完整对话" transcript page login.
 *
 * What this file gives the rest of MetaBot:
 *   - buildAuthorizeUrl()  — assemble the passport.feishu.cn/oauth/authorize URL
 *     with an HMAC-signed `state` (carries returnUrl + nonce + exp).
 *   - exchangeCodeForUser() — exchange an authorization code for an
 *     access_token, then fetch the user's open_id + name + avatar.
 *   - signSession()/verifySession() — issue and verify a 7-day HS256
 *     "session" JWT stored in the `mb_session` HttpOnly cookie.
 *   - signState()/verifyState() — short-lived HS256 wrapper for the OAuth
 *     state parameter so callbacks can't be forged.
 *
 * No external dependencies — we hand-roll a tiny JWT (header.payload.sig
 * base64url) so we don't have to pull in `jsonwebtoken` for this one feature.
 *
 * Token endpoints (verified via Feishu open platform docs, May 2026):
 *   POST https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal
 *     body: { app_id, app_secret }
 *   POST https://open.feishu.cn/open-apis/authen/v1/oidc/access_token
 *     header: Authorization: Bearer <app_access_token>
 *     body: { grant_type: 'authorization_code', code }
 *   GET  https://open.feishu.cn/open-apis/authen/v1/user_info
 *     header: Authorization: Bearer <user_access_token>
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const STATE_TTL_MS    = 10 * 60 * 1000;        // 10 minutes
const SESSION_TTL_SEC = 7 * 24 * 60 * 60;      // 7 days
const TOKEN_CACHE_TTL_BUFFER_SEC = 60;         // refresh 60 s before stated expiry

/** Bot context shape the OAuth helpers need — keeps this module decoupled
 *  from the heavier `BotConfig` type so tests can construct fakes easily. */
export interface OAuthBotContext {
  appId:     string;
  appSecret: string;
}

/** Result of a successful OAuth dance. */
export interface FeishuUserProfile {
  openId:           string;
  name:             string;
  avatarUrl?:       string;
  userAccessToken:  string;
}

/** Payload carried inside the state parameter. */
interface OAuthStatePayload {
  returnUrl: string;
  /** Bot the user is authenticating against — drives which transcript bot
   *  the callback should use to call open-apis. */
  botName:   string;
  nonce:     string;
  exp:       number;   // ms epoch
}

/** Payload carried inside the `mb_session` cookie JWT. */
export interface SessionPayload {
  open_id: string;
  name:    string;
  iat:     number; // sec epoch
  exp:     number; // sec epoch
}

// ── base64url helpers ────────────────────────────────────────────────────

function b64urlEncode(buf: Buffer | string): string {
  const b = typeof buf === 'string' ? Buffer.from(buf, 'utf-8') : buf;
  return b
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

// ── secret bootstrap ─────────────────────────────────────────────────────

/**
 * Load (or lazily mint and persist) the secret used for both the cookie JWT
 * and the OAuth state HMAC. Persistence target: `.env.local` in the project
 * root — this is `dotenv`-friendly, so subsequent restarts pick it up
 * automatically. Existing secrets in `process.env.METABOT_SESSION_SECRET`
 * always win (so ops can override via a secret store).
 */
export function loadOrCreateSessionSecret(envFilePath?: string): string {
  const existing = process.env.METABOT_SESSION_SECRET;
  if (existing && existing.length >= 16) return existing;

  const generated = crypto.randomBytes(32).toString('hex');
  process.env.METABOT_SESSION_SECRET = generated;

  // Best-effort persistence — if we can't write, the secret is process-
  // local. That's acceptable: a restart just means users re-log via OAuth.
  const target = envFilePath || path.join(process.cwd(), '.env.local');
  try {
    let body = '';
    if (fs.existsSync(target)) {
      body = fs.readFileSync(target, 'utf-8');
      // Strip any prior METABOT_SESSION_SECRET line so we don't accumulate.
      body = body
        .split('\n')
        .filter((l) => !l.startsWith('METABOT_SESSION_SECRET='))
        .join('\n');
      if (body && !body.endsWith('\n')) body += '\n';
    }
    body += `METABOT_SESSION_SECRET=${generated}\n`;
    fs.writeFileSync(target, body, { mode: 0o600 });
  } catch {
    // Swallow — process.env override is good enough for one process lifetime.
  }
  return generated;
}

// ── state token (returnUrl wrapper used during OAuth callback) ───────────

export function signState(payload: Omit<OAuthStatePayload, 'nonce' | 'exp'>, secret?: string): string {
  const s = secret ?? loadOrCreateSessionSecret();
  const full: OAuthStatePayload = {
    ...payload,
    nonce: crypto.randomBytes(12).toString('hex'),
    exp:   Date.now() + STATE_TTL_MS,
  };
  const body = b64urlEncode(JSON.stringify(full));
  const sig  = b64urlEncode(crypto.createHmac('sha256', s).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyState(state: string, secret?: string): OAuthStatePayload | null {
  const s = secret ?? loadOrCreateSessionSecret();
  const parts = state.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = b64urlEncode(crypto.createHmac('sha256', s).update(body).digest());
  if (!timingSafeEqualStr(sig, expected)) return null;
  let payload: OAuthStatePayload;
  try {
    payload = JSON.parse(b64urlDecode(body).toString('utf-8')) as OAuthStatePayload;
  } catch {
    return null;
  }
  if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
  if (typeof payload.returnUrl !== 'string' || typeof payload.botName !== 'string') return null;
  return payload;
}

// ── session JWT (mb_session cookie) ──────────────────────────────────────

export function signSession(payload: Pick<SessionPayload, 'open_id' | 'name'>, secret?: string): string {
  const s = secret ?? loadOrCreateSessionSecret();
  const now = Math.floor(Date.now() / 1000);
  const header  = b64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const full: SessionPayload = {
    open_id: payload.open_id,
    name:    payload.name,
    iat:     now,
    exp:     now + SESSION_TTL_SEC,
  };
  const body = b64urlEncode(JSON.stringify(full));
  const sig  = b64urlEncode(crypto.createHmac('sha256', s).update(`${header}.${body}`).digest());
  return `${header}.${body}.${sig}`;
}

export function verifySession(token: string, secret?: string): SessionPayload | null {
  const s = secret ?? loadOrCreateSessionSecret();
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = b64urlEncode(crypto.createHmac('sha256', s).update(`${header}.${body}`).digest());
  if (!timingSafeEqualStr(sig, expected)) return null;
  let payload: SessionPayload;
  try {
    payload = JSON.parse(b64urlDecode(body).toString('utf-8')) as SessionPayload;
  } catch {
    return null;
  }
  if (typeof payload.exp !== 'number') return null;
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  if (typeof payload.open_id !== 'string' || !payload.open_id) return null;
  return payload;
}

// ── app access token cache (per appId) ───────────────────────────────────

interface AppTokenEntry {
  token:    string;
  expireAt: number; // ms epoch
}
const appTokenCache: Map<string, AppTokenEntry> = new Map();

export async function getAppAccessToken(ctx: OAuthBotContext): Promise<string> {
  const cached = appTokenCache.get(ctx.appId);
  if (cached && cached.expireAt > Date.now()) return cached.token;

  const resp = await fetch('https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body:    JSON.stringify({ app_id: ctx.appId, app_secret: ctx.appSecret }),
  });
  const json = (await resp.json()) as { code?: number; msg?: string; app_access_token?: string; expire?: number };
  if (!resp.ok || json.code !== 0 || !json.app_access_token) {
    throw new Error(`Feishu app_access_token failed: code=${json.code} msg=${json.msg}`);
  }
  const ttl = Math.max(60, (json.expire ?? 7200) - TOKEN_CACHE_TTL_BUFFER_SEC);
  appTokenCache.set(ctx.appId, {
    token:    json.app_access_token,
    expireAt: Date.now() + ttl * 1000,
  });
  return json.app_access_token;
}

// ── public API: build authorize URL ──────────────────────────────────────

/**
 * Build the passport.feishu.cn authorize URL. The `state` is HMAC-signed
 * so the callback can recover `returnUrl` + `botName` without trusting the
 * client.
 */
export function buildAuthorizeUrl(
  ctx: OAuthBotContext & { botName: string },
  redirectUri: string,
  returnUrl: string,
  secret?: string,
): string {
  const state = signState({ returnUrl, botName: ctx.botName }, secret);
  const params = new URLSearchParams({
    app_id:       ctx.appId,
    redirect_uri: redirectUri,
    state,
  });
  // Note: scopes are inherited from the app config in the Feishu open
  // platform; the OAuth endpoint doesn't accept arbitrary scope strings for
  // OIDC user_info (we only need `contact:user.base:readonly` which is
  // enabled by default for self-built apps).
  return `https://passport.feishu.cn/suite/passport/oauth/authorize?${params.toString()}`;
}

// ── public API: exchange code → user profile ─────────────────────────────

/**
 * Exchange an OAuth authorization code for the user's open_id + display name.
 * Step 1: app_access_token (cached).
 * Step 2: POST /authen/v1/oidc/access_token  →  user_access_token, open_id
 * Step 3: GET  /authen/v1/user_info          →  name, avatar
 */
export async function exchangeCodeForUser(ctx: OAuthBotContext, code: string): Promise<FeishuUserProfile> {
  const appToken = await getAppAccessToken(ctx);

  const tokenResp = await fetch('https://open.feishu.cn/open-apis/authen/v1/oidc/access_token', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json; charset=utf-8',
      'Authorization': `Bearer ${appToken}`,
    },
    body: JSON.stringify({ grant_type: 'authorization_code', code }),
  });
  const tokenJson = (await tokenResp.json()) as {
    code?: number; msg?: string;
    data?: { access_token?: string; open_id?: string; expires_in?: number };
  };
  if (!tokenResp.ok || tokenJson.code !== 0 || !tokenJson.data?.access_token) {
    throw new Error(`Feishu OIDC access_token failed: code=${tokenJson.code} msg=${tokenJson.msg}`);
  }
  const userAccessToken = tokenJson.data.access_token;
  const openIdFromToken = tokenJson.data.open_id;

  const infoResp = await fetch('https://open.feishu.cn/open-apis/authen/v1/user_info', {
    method:  'GET',
    headers: { 'Authorization': `Bearer ${userAccessToken}` },
  });
  const infoJson = (await infoResp.json()) as {
    code?: number; msg?: string;
    data?: { open_id?: string; name?: string; avatar_url?: string };
  };
  if (!infoResp.ok || infoJson.code !== 0 || !infoJson.data) {
    throw new Error(`Feishu user_info failed: code=${infoJson.code} msg=${infoJson.msg}`);
  }
  const openId = infoJson.data.open_id || openIdFromToken;
  if (!openId) throw new Error('Feishu user_info returned no open_id');

  return {
    openId,
    name:            infoJson.data.name || '',
    ...(infoJson.data.avatar_url ? { avatarUrl: infoJson.data.avatar_url } : {}),
    userAccessToken,
  };
}

// ── cookie parsing helper ────────────────────────────────────────────────

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

// ── timing-safe string compare ───────────────────────────────────────────

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}
