/**
 * Cloud-side Feishu OAuth — `/api/auth/feishu/{login,callback}`.
 *
 * Mirror of the local bot's `src/feishu/oauth.ts`, adapted so that:
 *   - credentials (`feishuAppId`/`feishuAppSecret`) are NOT held by the cloud
 *     at rest. They arrive over the WS register frame as part of each bot's
 *     `BotMeta` and live only in `InstanceRegistry` memory; we read them on
 *     demand for each login/callback.
 *   - cookies minted here use the same HS256 wire format as
 *     `src/feishu/oauth.ts` signSession, so a session minted on cloud verifies
 *     on the local bot's transcript route too (and vice versa) when the same
 *     `METABOT_SESSION_SECRET` is configured on both sides.
 *   - the OAuth state carries `instanceId` in addition to `returnUrl`/`botName`
 *     so the callback can unambiguously look up the originating bot's
 *     credentials (multi-instance deployments may run the same bot name on
 *     more than one machine).
 *
 * Redirect URI is `${cloudPublicBaseUrl}/api/auth/feishu/callback` — the
 * operator must add this URL to every bot's Feishu app "Redirect URLs"
 * allowlist in the open-platform admin console.
 */
import crypto from 'node:crypto';
import type { Express, Request, Response } from 'express';
import type { InstanceRegistry } from '../ws/instance-registry.js';

const STATE_TTL_MS    = 10 * 60 * 1000;        // 10 min
const SESSION_TTL_SEC = 7 * 24 * 60 * 60;      // 7 days
const TOKEN_CACHE_TTL_BUFFER_SEC = 60;

interface AppTokenEntry { token: string; expireAt: number; }
const appTokenCache = new Map<string, AppTokenEntry>();

interface OAuthStatePayload {
  returnUrl:  string;
  botName:    string;
  instanceId: string;
  nonce:      string;
  exp:        number;   // ms epoch
}

interface SessionPayload {
  open_id: string;
  name:    string;
  iat:     number;
  exp:     number;
}

// ── base64url ──────────────────────────────────────────────────────────────
function b64urlEncode(buf: Buffer | string): string {
  const b = typeof buf === 'string' ? Buffer.from(buf, 'utf-8') : buf;
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}
function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch { return false; }
}

// ── state token ────────────────────────────────────────────────────────────
function signState(payload: Omit<OAuthStatePayload, 'nonce' | 'exp'>, secret: string): string {
  const full: OAuthStatePayload = {
    ...payload,
    nonce: crypto.randomBytes(12).toString('hex'),
    exp:   Date.now() + STATE_TTL_MS,
  };
  const body = b64urlEncode(JSON.stringify(full));
  const sig  = b64urlEncode(crypto.createHmac('sha256', secret).update(body).digest());
  return `${body}.${sig}`;
}
function verifyState(state: string, secret: string): OAuthStatePayload | null {
  const parts = state.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = b64urlEncode(crypto.createHmac('sha256', secret).update(body).digest());
  if (!timingSafeEqualStr(sig, expected)) return null;
  let payload: OAuthStatePayload;
  try { payload = JSON.parse(b64urlDecode(body).toString('utf-8')) as OAuthStatePayload; } catch { return null; }
  if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
  if (typeof payload.returnUrl !== 'string' || typeof payload.botName !== 'string' || typeof payload.instanceId !== 'string') return null;
  return payload;
}

// ── session JWT ────────────────────────────────────────────────────────────
function signSession(payload: Pick<SessionPayload, 'open_id' | 'name'>, secret: string): string {
  const now    = Math.floor(Date.now() / 1000);
  const header = b64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const full: SessionPayload = {
    open_id: payload.open_id,
    name:    payload.name,
    iat:     now,
    exp:     now + SESSION_TTL_SEC,
  };
  const body = b64urlEncode(JSON.stringify(full));
  const sig  = b64urlEncode(crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest());
  return `${header}.${body}.${sig}`;
}

// ── Feishu app/user token exchanges ────────────────────────────────────────
async function getAppAccessToken(appId: string, appSecret: string): Promise<string> {
  const cached = appTokenCache.get(appId);
  if (cached && cached.expireAt > Date.now()) return cached.token;
  const resp = await fetch('https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body:    JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const json = (await resp.json()) as { code?: number; msg?: string; app_access_token?: string; expire?: number };
  if (!resp.ok || json.code !== 0 || !json.app_access_token) {
    throw new Error(`Feishu app_access_token failed: code=${json.code} msg=${json.msg}`);
  }
  const ttl = Math.max(60, (json.expire ?? 7200) - TOKEN_CACHE_TTL_BUFFER_SEC);
  appTokenCache.set(appId, { token: json.app_access_token, expireAt: Date.now() + ttl * 1000 });
  return json.app_access_token;
}

interface FeishuUserProfile { openId: string; name: string; avatarUrl?: string; }

async function exchangeCodeForUser(appId: string, appSecret: string, code: string): Promise<FeishuUserProfile> {
  const appToken = await getAppAccessToken(appId, appSecret);
  const tokenResp = await fetch('https://open.feishu.cn/open-apis/authen/v1/oidc/access_token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Authorization': `Bearer ${appToken}` },
    body:    JSON.stringify({ grant_type: 'authorization_code', code }),
  });
  const tokenJson = (await tokenResp.json()) as {
    code?: number; msg?: string;
    data?: { access_token?: string; open_id?: string };
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
    name: infoJson.data.name || '',
    ...(infoJson.data.avatar_url ? { avatarUrl: infoJson.data.avatar_url } : {}),
  };
}

// ── route options ──────────────────────────────────────────────────────────
export interface FeishuAuthRouteOptions {
  registry:      InstanceRegistry;
  /** HS256 secret — shared with `requireFeishuAuth` cookie verify. */
  sessionSecret: string;
  /**
   * Public base URL of this cloud relay (e.g. `https://teamclaude.xvirobotics.com:18443`).
   * Used to build the OAuth redirect URI. Must match what's been added to the
   * Feishu app's "Redirect URLs" allowlist in the open-platform admin console.
   */
  publicBaseUrl: string;
  logger?: (msg: string) => void;
}

// ── safe return-path validator ─────────────────────────────────────────────
// Avoid open-redirect: only accept same-origin paths that start with `/`.
function isSafeReturnPath(p: string): boolean {
  if (typeof p !== 'string' || p.length === 0) return false;
  if (!p.startsWith('/')) return false;
  if (p.startsWith('//')) return false; // protocol-relative
  if (p.startsWith('/\\')) return false;
  return true;
}

// ── route handlers ─────────────────────────────────────────────────────────

export function mountFeishuAuthRoutes(app: Express, opts: FeishuAuthRouteOptions): void {
  const log = opts.logger ?? (() => {});
  const redirectUri = `${opts.publicBaseUrl.replace(/\/+$/, '')}/api/auth/feishu/callback`;

  app.get('/api/auth/feishu/login', (req: Request, res: Response) => {
    const ret  = typeof req.query.return === 'string' ? req.query.return : '';
    const bot  = typeof req.query.bot    === 'string' ? req.query.bot    : '';
    const iRaw = typeof req.query.i      === 'string' ? req.query.i      : '';
    if (!isSafeReturnPath(ret) || !bot) {
      res.status(400).type('text/plain').send('bad request: invalid return path or missing bot');
      return;
    }
    // Try (instance, bot) first; fall back to bot-name-only scan if `i=`
    // was omitted by an older middleware version.
    const hit = iRaw
      ? opts.registry.findBotOnInstance(iRaw, bot)
      : opts.registry.findBotAnywhere(bot);
    if (!hit) {
      res.status(503).type('text/plain').send(`bot not connected: ${bot}`);
      return;
    }
    const { record, bot: meta } = hit;
    if (!meta.feishuAppId || !meta.feishuAppSecret) {
      res.status(503).type('text/plain').send(`bot ${bot} did not ship Feishu credentials in its register frame`);
      return;
    }
    const state = signState(
      { returnUrl: ret, botName: bot, instanceId: record.instanceId },
      opts.sessionSecret,
    );
    const params = new URLSearchParams({
      app_id:       meta.feishuAppId,
      redirect_uri: redirectUri,
      state,
    });
    const url = `https://passport.feishu.cn/suite/passport/oauth/authorize?${params.toString()}`;
    log(`auth/login: bot=${bot} instance=${record.instanceId} return=${ret}`);
    res.redirect(302, url);
  });

  app.get('/api/auth/feishu/callback', async (req: Request, res: Response) => {
    const code  = typeof req.query.code  === 'string' ? req.query.code  : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    if (!code || !state) {
      res.status(400).type('text/plain').send('bad request: missing code or state');
      return;
    }
    const parsed = verifyState(state, opts.sessionSecret);
    if (!parsed) {
      res.status(400).type('text/plain').send('bad request: invalid or expired state');
      return;
    }
    const hit = opts.registry.findBotOnInstance(parsed.instanceId, parsed.botName);
    if (!hit) {
      res.status(503).type('text/plain').send(`bot not connected: ${parsed.botName}@${parsed.instanceId}`);
      return;
    }
    const { bot: meta } = hit;
    if (!meta.feishuAppId || !meta.feishuAppSecret) {
      res.status(503).type('text/plain').send(`bot ${parsed.botName} did not ship Feishu credentials`);
      return;
    }
    let user: FeishuUserProfile;
    try {
      user = await exchangeCodeForUser(meta.feishuAppId, meta.feishuAppSecret, code);
    } catch (err) {
      log(`auth/callback: exchange failed bot=${parsed.botName} err=${(err as Error).message}`);
      res.status(502).type('text/plain').send(`Feishu OAuth exchange failed: ${(err as Error).message}`);
      return;
    }
    const token = signSession({ open_id: user.openId, name: user.name }, opts.sessionSecret);
    // 7-day cookie; HttpOnly so SPA JS can't read it; Secure on https.
    const isHttps = (req.protocol === 'https')
      || ((req.headers['x-forwarded-proto'] ?? '') === 'https');
    const cookieParts = [
      `mb_session=${encodeURIComponent(token)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${SESSION_TTL_SEC}`,
    ];
    if (isHttps) cookieParts.push('Secure');
    res.setHeader('Set-Cookie', cookieParts.join('; '));
    log(`auth/callback: bot=${parsed.botName} open_id=${user.openId} → ${parsed.returnUrl}`);
    res.redirect(302, parsed.returnUrl);
  });
}
