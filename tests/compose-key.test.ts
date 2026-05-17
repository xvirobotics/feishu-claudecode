import { describe, it, expect } from 'vitest';
import {
  composeScopeKey,
  chatIdFromScopeKey,
  userIdFromScopeKey,
} from '../src/session/compose-key.js';

describe('composeScopeKey', () => {
  it('returns chatId unchanged when perUserContext is off', () => {
    expect(composeScopeKey('oc_abc', 'ou_xyz', false)).toBe('oc_abc');
    expect(composeScopeKey('oc_abc', 'ou_xyz', undefined)).toBe('oc_abc');
  });

  it('returns chatId unchanged when userId is missing', () => {
    expect(composeScopeKey('oc_abc', undefined, true)).toBe('oc_abc');
    expect(composeScopeKey('oc_abc', '', true)).toBe('oc_abc');
  });

  it('joins chatId and userId with a colon when both are present and flag is on', () => {
    expect(composeScopeKey('oc_abc', 'ou_xyz', true)).toBe('oc_abc:ou_xyz');
  });
});

describe('chatIdFromScopeKey', () => {
  it('returns the input unchanged for chatId-only keys', () => {
    expect(chatIdFromScopeKey('oc_abc')).toBe('oc_abc');
  });

  it('extracts the chatId from a composed key', () => {
    expect(chatIdFromScopeKey('oc_abc:ou_xyz')).toBe('oc_abc');
  });
});

describe('userIdFromScopeKey', () => {
  it('returns undefined for chatId-only keys', () => {
    expect(userIdFromScopeKey('oc_abc')).toBeUndefined();
  });

  it('extracts the userId from a composed key', () => {
    expect(userIdFromScopeKey('oc_abc:ou_xyz')).toBe('ou_xyz');
  });

  it('returns undefined when the userId segment is empty', () => {
    expect(userIdFromScopeKey('oc_abc:')).toBeUndefined();
  });
});
