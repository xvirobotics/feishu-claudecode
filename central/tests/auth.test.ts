import { describe, it, expect, afterEach } from 'vitest';
import { makeKit, type TestKit } from './helpers.js';
import { hashToken } from '../src/auth/credentials.js';

let kit: TestKit | undefined;

afterEach(() => {
  kit?.cleanup();
  kit = undefined;
});

describe('CredentialsStore', () => {
  it('issues credentials with one-time token + persisted hash', () => {
    kit = makeKit('auth-issue');
    const result = kit.credentials.issue({
      botName: 'dkj-laptop',
      ownerName: 'dkj',
      role: 'member',
    });
    expect(result.token).toMatch(/^mt_/);
    expect(result.credential.role).toBe('member');
    expect(result.credential.writableNamespaces).toEqual(['/users/dkj-laptop']);
    expect((result.credential as any).tokenHash).toBeUndefined(); // public view strips hash

    const found = kit.credentials.findById(result.credential.id);
    expect(found?.tokenHash).toBe(hashToken(result.token));
  });

  it('lookupByToken returns the credential, caches subsequent lookups', () => {
    kit = makeKit('auth-lookup');
    const { token, credential } = kit.credentials.issue({
      botName: 'bot-a', ownerName: 'a', role: 'member',
    });
    const first = kit.credentials.lookupByToken(token);
    expect(first?.id).toBe(credential.id);
    const second = kit.credentials.lookupByToken(token);
    expect(second?.id).toBe(credential.id);
  });

  it('lookupByToken: null for unknown; revoked tokens still resolve so callers can distinguish', () => {
    kit = makeKit('auth-revoke');
    const { token, credential } = kit.credentials.issue({
      botName: 'bot-b', ownerName: 'b', role: 'member',
    });
    expect(kit.credentials.lookupByToken('mt_no_such_token')).toBeNull();
    kit.credentials.revoke(credential.id);
    // Cache invalidated on revoke → fresh lookup returns cred with revokedAt set,
    // so the middleware can return 'credential_revoked' (not 'invalid_token').
    const found = kit.credentials.lookupByToken(token);
    expect(found?.id).toBe(credential.id);
    expect(found?.revokedAt).not.toBeNull();
  });

  it('revoke returns null for missing id', () => {
    kit = makeKit('auth-revoke-missing');
    expect(kit.credentials.revoke('does-not-exist')).toBeNull();
  });

  it('list returns all credentials without tokenHash', () => {
    kit = makeKit('auth-list');
    kit.credentials.issue({ botName: 'a', ownerName: 'a', role: 'member' });
    kit.credentials.issue({ botName: 'b', ownerName: 'b', role: 'admin' });
    const list = kit.credentials.list();
    expect(list.length).toBe(2);
    for (const c of list) expect((c as any).tokenHash).toBeUndefined();
  });

  it('bootstrapAdmin issues exactly once', () => {
    kit = makeKit('auth-bootstrap');
    const path = `${kit.dir}/admin-bootstrap-token.txt`;
    const token = kit.credentials.bootstrapAdmin(path);
    expect(token).toBeTruthy();
    expect(token!.startsWith('mt_admin_')).toBe(true);

    // second call: no-op
    const again = kit.credentials.bootstrapAdmin(path);
    expect(again).toBeNull();
    expect(kit.credentials.hasAdmin()).toBe(true);
  });

  it('touchLastUsed batches deferred writes', () => {
    kit = makeKit('auth-touch');
    const { credential } = kit.credentials.issue({ botName: 'c', ownerName: 'c', role: 'member' });
    expect(credential.lastUsedAt).toBeNull();
    kit.credentials.touchLastUsed(credential.id);
    kit.credentials.touchLastUsed(credential.id);
    kit.credentials.flushLastUsed();
    const fresh = kit.credentials.findById(credential.id);
    expect(fresh?.lastUsedAt).not.toBeNull();
  });
});
