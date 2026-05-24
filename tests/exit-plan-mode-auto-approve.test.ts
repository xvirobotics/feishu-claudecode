import { describe, it, expect } from 'vitest';
import { makeCanUseTool } from '../src/engines/claude/exit-plan-mode.js';
import { PersistentClaudeExecutor } from '../src/engines/claude/persistent-executor.js';

/**
 * Outside a sub-agent context, the native ExitPlanMode tool's
 * checkPermissions returns `{behavior: "ask", message: "Exit plan mode?"}`
 * even under `permissionMode: 'bypassPermissions'`. The SDK routes that
 * "ask" through the can_use_tool control_request, NOT through PreToolUse
 * hooks ("PreToolUse hook denies bypass canUseTool" — sdk.d.ts) — so a
 * PreToolUse-based fix would log "auto-approving" but never actually
 * unblock the gate; the bridge gets back an is_error tool_result and the
 * agent stays in plan mode.
 *
 * The fix: wire `canUseTool` on the SDK query options, which IS the
 * channel the "ask" lands on. The `allow` branch MUST include
 * `updatedInput: Record<string, unknown>` — the SDK's Zod schema for
 * PermissionResult rejects `{behavior: 'allow'}` without it
 * (ZodError: invalid_type expected record, received undefined at updatedInput).
 */

const collected: { level: string; obj: unknown; msg?: string }[] = [];
const mockLogger = {
  debug: () => {},
  info: (obj: unknown, msg?: string) => { collected.push({ level: 'info', obj, msg }); },
  warn: (obj: unknown, msg?: string) => { collected.push({ level: 'warn', obj, msg }); },
  error: () => {},
} as any;

describe('makeCanUseTool (ExitPlanMode auto-approve)', () => {
  it('returns behavior=allow with updatedInput echoed back for ExitPlanMode', async () => {
    collected.length = 0;
    const canUseTool = makeCanUseTool(mockLogger);
    const input = { plan: 'p' };
    const result = await canUseTool('ExitPlanMode', input, { toolUseID: 'toolu_plan_1' });
    // updatedInput MUST be present — the SDK's Zod schema rejects `allow` without it
    expect(result).toEqual({ behavior: 'allow', updatedInput: input });
    const info = collected.find((c) => c.level === 'info');
    expect(info?.msg).toBe('canUseTool: auto-approving ExitPlanMode');
    expect((info?.obj as any).toolUseId).toBe('toolu_plan_1');
  });

  it('allows non-ExitPlanMode tools too (safety net) with updatedInput', async () => {
    collected.length = 0;
    const canUseTool = makeCanUseTool(mockLogger);
    const input = { command: 'ls' };
    const result = await canUseTool('Bash', input, { toolUseID: 'toolu_bash_1' });
    expect(result).toEqual({ behavior: 'allow', updatedInput: input });
    const warn = collected.find((c) => c.level === 'warn');
    expect(warn?.msg).toContain('unexpected ask under bypassPermissions');
    expect((warn?.obj as any).toolName).toBe('Bash');
  });

  it('resolves synchronously (the SDK waits on this — must not block)', async () => {
    const canUseTool = makeCanUseTool(mockLogger);
    let resolved = false;
    const p = canUseTool('ExitPlanMode', {}, { toolUseID: 'toolu_plan_2' }).then((r) => {
      resolved = true;
      return r;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(true);
    await p;
  });
});

describe('PersistentClaudeExecutor wires canUseTool / drops PreToolUse ExitPlanMode entry', () => {
  function makeExec(): PersistentClaudeExecutor {
    return new PersistentClaudeExecutor({
      cwd: '/tmp',
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any,
      idleTimeoutMs: 0,
    });
  }

  it('does NOT register a PreToolUse entry for ExitPlanMode (the old hook is dead)', () => {
    const exec = makeExec();
    const hooks = (exec as any).buildHooks();
    const exitEntry = hooks.PreToolUse.find((e: any) => e.matcher === 'ExitPlanMode');
    expect(exitEntry, 'PreToolUse ExitPlanMode hook must be removed — the gate is on canUseTool now').toBeUndefined();
  });

  it('keeps AskUserQuestion entry at PreToolUse[0] (no ordering regression)', () => {
    const exec = makeExec();
    const hooks = (exec as any).buildHooks();
    expect(hooks.PreToolUse[0].matcher).toBe('AskUserQuestion');
  });
});
