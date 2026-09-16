import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createHookBridge } from '../src/engines/claude/pty/hook-bridge.js';

describe('Claude PTY hook bridge settings', () => {
  it('acknowledges the bypass mode already selected by the PTY launch flag', async () => {
    const bridge = createHookBridge();
    try {
      const settingsPath = await bridge.writeSettings();
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));

      expect(settings.permissions).toEqual({ defaultMode: 'bypassPermissions' });
      expect(settings.skipDangerousModePermissionPrompt).toBe(true);
      expect(settings.hooks.Stop).toHaveLength(1);
    } finally {
      await bridge.dispose();
    }
  });
});
