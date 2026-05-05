import { describe, expect, it } from 'vitest';
import { isStaleSessionError, normalizePromptForEngine } from '../src/bridge/message-bridge.js';

describe('isStaleSessionError', () => {
  it('matches the GitHub issue error text', () => {
    expect(
      isStaleSessionError('Error: No conversation found with session ID: d0cfbde2-1357-4da0-acd6-ee36d1da056c'),
    ).toBe(true);
  });

  it('matches other stale session variants', () => {
    expect(isStaleSessionError('invalid session provided')).toBe(true);
    expect(isStaleSessionError('Conversation not found')).toBe(true);
  });

  it('matches Codex stale thread resume errors', () => {
    expect(
      isStaleSessionError('Error: Codex exited with code 1: Error: thread/resume: thread/resume failed: no rollout found for thread id ea0dd6d2-7418-4545-8427-63cc8aed81f2'),
    ).toBe(true);
  });

  it('matches conversation corruption errors (duplicate tool_result)', () => {
    expect(
      isStaleSessionError('API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.148.content.1: each tool_use must have a single result. Found multiple `tool_result` blocks with id: toolu_01TPsHXcmpuz5cAY97fM5vXv"}}'),
    ).toBe(true);
    expect(
      isStaleSessionError('each tool_use must have a single result'),
    ).toBe(true);
    expect(
      isStaleSessionError('Found multiple tool_result blocks with id: toolu_abc'),
    ).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(isStaleSessionError('Task timed out (24 hour limit)')).toBe(false);
    expect(isStaleSessionError('permission denied')).toBe(false);
    expect(isStaleSessionError(undefined)).toBe(false);
  });
});

describe('normalizePromptForEngine', () => {
  it('converts slash skill invocations to Codex explicit skill syntax', () => {
    expect(normalizePromptForEngine('/metaskill ios app', 'codex')).toBe('$metaskill ios app');
    expect(normalizePromptForEngine('/skill-name', 'codex')).toBe('$skill-name');
  });

  it('leaves non-Codex and non-skill prompts unchanged', () => {
    expect(normalizePromptForEngine('/metaskill ios app', 'claude')).toBe('/metaskill ios app');
    expect(normalizePromptForEngine('/metaskill ios app', 'kimi')).toBe('/metaskill ios app');
    expect(normalizePromptForEngine('hello /metaskill', 'codex')).toBe('hello /metaskill');
    expect(normalizePromptForEngine('/bad/path', 'codex')).toBe('/bad/path');
  });
});
