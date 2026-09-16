import { describe, expect, it } from 'vitest';
import {
  activityTypeForState,
  hasRunningBackgroundWork,
} from '../src/bridge/background-task-lifecycle.js';
import type { CardState } from '../src/types.js';

function makeState(overrides: Partial<CardState> = {}): CardState {
  return {
    status: 'complete',
    userPrompt: 'publish',
    responseText: 'monitor started',
    toolCalls: [],
    ...overrides,
  };
}

describe('hasRunningBackgroundWork', () => {
  it('is false without background events', () => {
    expect(hasRunningBackgroundWork(makeState())).toBe(false);
  });

  it('is true while an event is running', () => {
    expect(
      hasRunningBackgroundWork(
        makeState({
          backgroundEvents: [{ taskId: 'monitor', description: 'release monitor', status: 'running' }],
        }),
      ),
    ).toBe(true);
  });

  it('is false once every event finished', () => {
    expect(
      hasRunningBackgroundWork(
        makeState({
          backgroundEvents: [
            { taskId: 'a', description: 'a', status: 'completed' },
            { taskId: 'b', description: 'b', status: 'failed' },
          ],
        }),
      ),
    ).toBe(false);
  });
});

describe('activityTypeForState', () => {
  it('keeps a successful turn waiting while background work is active', () => {
    expect(
      activityTypeForState(
        makeState({
          backgroundEvents: [{ taskId: 'monitor', description: 'release monitor', status: 'running' }],
        }),
      ),
    ).toBe('task_waiting');
  });

  it('reports completion once background work is done', () => {
    expect(activityTypeForState(makeState())).toBe('task_completed');
  });

  it('still reports failures while background work is active', () => {
    expect(
      activityTypeForState(
        makeState({
          status: 'error',
          backgroundEvents: [{ taskId: 'monitor', description: 'release monitor', status: 'running' }],
        }),
      ),
    ).toBe('task_failed');
  });
});
