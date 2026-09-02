import { describe, it, expect, vi, afterEach } from 'vitest';
import { driveInteractiveTool } from '../src/engines/claude/pty/interactive-driver.js';
import type { PtyClaudeSession, PtyParsedQuestion } from '../src/engines/claude/pty/contract.js';

function createSession(snapshot: string) {
  return {
    snapshot: () => snapshot,
    screen: () => snapshot,
    sendKeys: vi.fn(),
    typePrompt: vi.fn().mockResolvedValue(undefined),
  } as unknown as PtyClaudeSession;
}

function createLogger() {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child: vi.fn(() => createLogger()) } as any;
}

const questions: PtyParsedQuestion[] = [
  { question: 'Deploy now?', header: 'Deploy', options: ['Yes', 'No'], multiSelect: false },
];

describe('driveInteractiveTool AskUserQuestion fallback', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('submits answers as a prompt when the menu never renders', async () => {
    vi.useFakeTimers();
    const session = createSession('idle claude screen after resume');

    const promise = driveInteractiveTool({
      session,
      tool: { name: 'AskUserQuestion', toolUseId: 'toolu_1', input: { questions: [] } },
      response: { kind: 'answers', answers: { Deploy: 'Yes' }, questions },
      logger: createLogger(),
    });
    await vi.advanceTimersByTimeAsync(21_000);
    await promise;

    expect(session.typePrompt).toHaveBeenCalledWith('Deploy: Yes');
    expect(session.sendKeys).not.toHaveBeenCalled();
  });

  it('still drives the menu when it renders', async () => {
    vi.useFakeTimers();
    const session = createSession('❯ 1. Yes  2. No  Enter to select');

    const promise = driveInteractiveTool({
      session,
      tool: { name: 'AskUserQuestion', toolUseId: 'toolu_1', input: { questions: [] } },
      response: { kind: 'answers', answers: { Deploy: 'Yes' }, questions },
      logger: createLogger(),
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await promise;

    expect(session.sendKeys).toHaveBeenCalledWith('1');
    expect(session.typePrompt).not.toHaveBeenCalled();
  });
});
