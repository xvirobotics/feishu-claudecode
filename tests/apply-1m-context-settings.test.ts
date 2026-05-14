import { describe, it, expect } from 'vitest';
import { apply1MContextSettings } from '../src/engines/claude/executor.js';

describe('apply1MContextSettings', () => {
  it('sets betas when model has [1m] suffix and leaves env untouched', () => {
    const q: Record<string, unknown> = { model: 'claude-opus-4-7[1m]' };
    apply1MContextSettings(q);
    expect(q.betas).toEqual(['context-1m-2025-08-07']);
    expect(q.env).toBeUndefined();
  });

  it('sets CLAUDE_CODE_DISABLE_1M_CONTEXT=1 when model lacks [1m]', () => {
    const q: Record<string, unknown> = { model: 'claude-opus-4-7' };
    apply1MContextSettings(q);
    expect(q.betas).toBeUndefined();
    expect((q.env as Record<string, string>).CLAUDE_CODE_DISABLE_1M_CONTEXT).toBe('1');
  });

  it('preserves pre-existing env entries when adding the disable flag', () => {
    const q: Record<string, unknown> = {
      model: 'claude-sonnet-4-6',
      env: { FOO: 'bar' },
    };
    apply1MContextSettings(q);
    expect(q.env).toEqual({ FOO: 'bar', CLAUDE_CODE_DISABLE_1M_CONTEXT: '1' });
  });

  it('handles undefined model as "lacks [1m]"', () => {
    const q: Record<string, unknown> = {};
    apply1MContextSettings(q);
    expect((q.env as Record<string, string>).CLAUDE_CODE_DISABLE_1M_CONTEXT).toBe('1');
  });
});
