import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import type * as http from 'node:http';
import { requireFeishuAuth, unionAllowLists } from '../src/api/middleware/feishu-auth.js';
import { signSession } from '../src/feishu/oauth.js';

const TEST_SECRET = 'test-secret-for-feishu-auth-middleware-12345678';

/**
 * Helper: build a minimal IncomingMessage-shaped object with the requested
 * cookies. We only need `.headers.cookie` — the middleware never looks at
 * anything else.
 */
function makeReq(cookies?: Record<string, string>): http.IncomingMessage {
  const cookie = cookies
    ? Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ')
    : undefined;
  return { headers: cookie ? { cookie } : {} } as unknown as http.IncomingMessage;
}

beforeAll(() => {
  // requireFeishuAuth / verifySession both read METABOT_SESSION_SECRET; pin it
  // so the cookie we sign with TEST_SECRET below is verifiable.
  process.env.METABOT_SESSION_SECRET = TEST_SECRET;
});

describe('requireFeishuAuth', () => {
  it('returns 401 with a correctly-shaped loginUrl when no cookie is present', () => {
    const result = requireFeishuAuth(makeReq(), {
      allowOpenIds: ['ou_owner'],
      returnPath:   '/web/transcript/oc_chat?turn=2',
      botName:      'my-bot',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return; // narrow for TS
    expect(result.status).toBe(401);
    // loginUrl must encode the returnPath and include the bot name.
    expect(result.loginUrl).toContain('/api/auth/feishu/login?');
    expect(result.loginUrl).toContain(`return=${encodeURIComponent('/web/transcript/oc_chat?turn=2')}`);
    expect(result.loginUrl).toContain('bot=my-bot');
  });

  it('returns ok when the cookie is valid and the open_id is in the allowlist', () => {
    const token  = signSession({ open_id: 'ou_owner', name: 'Owner' });
    const result = requireFeishuAuth(makeReq({ mb_session: encodeURIComponent(token) }), {
      allowOpenIds: ['ou_owner', 'ou_other'],
      returnPath:   '/web/transcript/foo',
      botName:      'b',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.openId).toBe('ou_owner');
    expect(result.name).toBe('Owner');
  });

  it('returns 403 when the cookie is valid but the open_id is not in the allowlist', () => {
    const token  = signSession({ open_id: 'ou_stranger', name: 'Stranger' });
    const result = requireFeishuAuth(makeReq({ mb_session: encodeURIComponent(token) }), {
      allowOpenIds: ['ou_owner'],
      returnPath:   '/web/transcript/foo',
      botName:      'b',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(403);
    expect(result.loginUrl).toBeUndefined();
  });

  it('returns 403 even with a valid cookie when allowOpenIds is empty (closed by default)', () => {
    const token  = signSession({ open_id: 'ou_owner', name: 'Owner' });
    const result = requireFeishuAuth(makeReq({ mb_session: encodeURIComponent(token) }), {
      allowOpenIds: [],
      returnPath:   '/web/anything',
      botName:      'b',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(403);
  });
});

describe('unionAllowLists', () => {
  const SAVED_ENV = process.env.METABOT_TRANSCRIPT_ALLOW_OPEN_IDS;

  afterEach(() => {
    if (SAVED_ENV === undefined) delete process.env.METABOT_TRANSCRIPT_ALLOW_OPEN_IDS;
    else process.env.METABOT_TRANSCRIPT_ALLOW_OPEN_IDS = SAVED_ENV;
  });

  it('forTranscript=true unions accessAllowOpenIds + transcriptAllowOpenIds + env fallback', () => {
    process.env.METABOT_TRANSCRIPT_ALLOW_OPEN_IDS = 'ou_env_a, ou_env_b';
    const result = unionAllowLists(
      { accessAllowOpenIds: ['ou_access'], transcriptAllowOpenIds: ['ou_transcript'] },
      true,
    );
    // Order isn't part of the contract; assert set equality.
    expect(new Set(result)).toEqual(new Set(['ou_access', 'ou_transcript', 'ou_env_a', 'ou_env_b']));
  });

  it('forTranscript=false ignores both env fallback and transcriptAllowOpenIds', () => {
    process.env.METABOT_TRANSCRIPT_ALLOW_OPEN_IDS = 'ou_env_x';
    const result = unionAllowLists(
      { accessAllowOpenIds: ['ou_access'], transcriptAllowOpenIds: ['ou_transcript'] },
      false,
    );
    expect(result).toEqual(['ou_access']);
  });

  it('handles null bot gracefully', () => {
    delete process.env.METABOT_TRANSCRIPT_ALLOW_OPEN_IDS;
    expect(unionAllowLists(null, true)).toEqual([]);
    expect(unionAllowLists(null, false)).toEqual([]);
  });
});
