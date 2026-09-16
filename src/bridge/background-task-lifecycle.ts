import type { CardState } from '../types.js';

export type ActivityLifecycleType = 'task_waiting' | 'task_completed' | 'task_failed';

/** True while the turn has spawned background work that has not finished yet. */
export function hasRunningBackgroundWork(state: CardState): boolean {
  return state.backgroundEvents?.some((event) => event.status === 'running') === true;
}

export function activityTypeForState(state: CardState): ActivityLifecycleType {
  if (state.status === 'error') return 'task_failed';
  if (hasRunningBackgroundWork(state)) return 'task_waiting';
  return state.status === 'complete' ? 'task_completed' : 'task_failed';
}
