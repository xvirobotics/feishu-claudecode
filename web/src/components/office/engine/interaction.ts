/* ============================================================
   Interaction — Click detection on canvas
   ============================================================ */

import type { Position, AgentSprite } from '../types';
import { TILE_SIZE } from '../types';

export interface ClickResult {
  type: 'floor' | 'agent' | 'none';
  tilePos: Position;
  agentName?: string;
}

/**
 * Convert screen (canvas) coordinates to world tile coordinates,
 * accounting for camera offset.
 */
export function screenToWorld(
  screenX: number,
  screenY: number,
  cameraX: number,
  cameraY: number,
): Position {
  return {
    x: Math.floor((screenX + cameraX) / TILE_SIZE),
    y: Math.floor((screenY + cameraY) / TILE_SIZE),
  };
}

export function worldToScreen(
  worldX: number,
  worldY: number,
  cameraX: number,
  cameraY: number,
): { x: number; y: number } {
  return {
    x: worldX * TILE_SIZE - cameraX,
    y: worldY * TILE_SIZE - cameraY,
  };
}

/**
 * Determine what was clicked: an agent, a floor tile, or nothing.
 * Agents are checked first (priority over floor).
 */
export function detectClick(
  screenX: number,
  screenY: number,
  cameraX: number,
  cameraY: number,
  agents: Map<string, AgentSprite>,
): ClickResult {
  const tilePos = screenToWorld(screenX, screenY, cameraX, cameraY);

  // Check if click is on any agent (check seat position)
  for (const [name, agent] of agents) {
    const agentScreenX = agent.position.x * TILE_SIZE - cameraX;
    const agentScreenY = agent.position.y * TILE_SIZE - cameraY;
    // Hit test with a slightly generous bounding box
    if (
      screenX >= agentScreenX - 4 &&
      screenX <= agentScreenX + TILE_SIZE + 4 &&
      screenY >= agentScreenY - 16 && // name label above
      screenY <= agentScreenY + TILE_SIZE + 4
    ) {
      return { type: 'agent', tilePos: agent.position, agentName: name };
    }
  }

  return { type: 'floor', tilePos };
}

/**
 * Detect which agent (if any) the mouse is hovering over.
 */
export function detectHover(
  screenX: number,
  screenY: number,
  cameraX: number,
  cameraY: number,
  agents: Map<string, AgentSprite>,
): string | null {
  for (const [name, agent] of agents) {
    const ax = agent.position.x * TILE_SIZE - cameraX;
    const ay = agent.position.y * TILE_SIZE - cameraY;
    if (
      screenX >= ax - 4 &&
      screenX <= ax + TILE_SIZE + 4 &&
      screenY >= ay - 16 &&
      screenY <= ay + TILE_SIZE + 4
    ) {
      return name;
    }
  }
  return null;
}
