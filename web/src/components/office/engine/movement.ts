/* ============================================================
   Player Movement — Lerp between tiles on a path
   ============================================================ */

import type { Position, Direction } from '../types';

const MOVE_SPEED = 5; // tiles per second

export interface MovementState {
  /** Current visual position (fractional, for smooth animation) */
  visualX: number;
  visualY: number;
  /** Current tile position (integer) */
  tileX: number;
  tileY: number;
  /** Remaining path to walk */
  path: Position[];
  /** Current direction the player is facing */
  direction: Direction;
  /** Progress to next tile (0..1) */
  progress: number;
  /** Is the player currently moving? */
  isMoving: boolean;
  /** Animation frame counter */
  frame: number;
  frameTimer: number;
}

export function createMovementState(start: Position): MovementState {
  return {
    visualX: start.x,
    visualY: start.y,
    tileX: start.x,
    tileY: start.y,
    path: [],
    direction: 'down',
    progress: 0,
    isMoving: false,
    frame: 0,
    frameTimer: 0,
  };
}

export function setPath(state: MovementState, path: Position[]): void {
  state.path = [...path];
  state.progress = 0;
  state.isMoving = path.length > 0;
}

/** Update movement each frame. Returns true if position changed. */
export function updateMovement(state: MovementState, dt: number): boolean {
  if (!state.isMoving || state.path.length === 0) {
    state.isMoving = false;
    return false;
  }

  // Advance animation frame
  state.frameTimer += dt;
  if (state.frameTimer > 0.15) {
    state.frame = (state.frame + 1) % 4;
    state.frameTimer = 0;
  }

  const target = state.path[0];

  // Determine direction
  const dx = target.x - state.tileX;
  const dy = target.y - state.tileY;
  if (Math.abs(dx) > Math.abs(dy)) {
    state.direction = dx > 0 ? 'right' : 'left';
  } else {
    state.direction = dy > 0 ? 'down' : 'up';
  }

  // Advance progress
  state.progress += MOVE_SPEED * dt;

  if (state.progress >= 1) {
    // Arrived at next tile
    state.tileX = target.x;
    state.tileY = target.y;
    state.visualX = target.x;
    state.visualY = target.y;
    state.progress = 0;
    state.path.shift();

    if (state.path.length === 0) {
      state.isMoving = false;
      state.frame = 0;
    }
  } else {
    // Lerp between current tile and target
    state.visualX = state.tileX + dx * state.progress;
    state.visualY = state.tileY + dy * state.progress;
  }

  return true;
}
