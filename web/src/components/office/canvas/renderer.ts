/* ============================================================
   Office Renderer — Draws the full office scene each frame
   ============================================================ */

import type { TileMap, AgentSprite, Direction, Room } from '../types';
import { TileType, TILE_SIZE } from '../types';
import { drawTile, drawAgent, drawPlayer, drawRoomLabel, agentColor } from './sprites';
import type { Camera } from './camera';

/**
 * Render the static tile map to an offscreen canvas (for caching).
 */
export function renderStaticLayer(
  tileMap: TileMap,
  rooms: Room[],
): HTMLCanvasElement {
  const offscreen = document.createElement('canvas');
  offscreen.width = tileMap.width * TILE_SIZE;
  offscreen.height = tileMap.height * TILE_SIZE;
  const ctx = offscreen.getContext('2d')!;

  // Background
  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, offscreen.width, offscreen.height);

  // Draw all tiles
  for (let y = 0; y < tileMap.height; y++) {
    for (let x = 0; x < tileMap.width; x++) {
      const tile = tileMap.tiles[y][x];
      if (tile !== TileType.VOID) {
        drawTile(ctx, x, y, tile);
      }
    }
  }

  // Draw room labels
  for (const room of rooms) {
    drawRoomLabel(ctx, room.x, room.y, room.width, room.name);
  }

  return offscreen;
}

/**
 * Render the full scene to the main canvas each frame.
 */
export function renderFrame(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  camera: Camera,
  staticLayer: HTMLCanvasElement,
  agents: Map<string, AgentSprite>,
  playerX: number,
  playerY: number,
  playerDirection: Direction,
  playerFrame: number,
  playerIsMoving: boolean,
  selectedAgent: string | null,
  hoveredAgent: string | null,
  frame: number,
): void {
  // Clear
  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  // Draw static layer (tile map)
  ctx.drawImage(staticLayer, -camera.x, -camera.y);

  // Sort agents and player by Y for correct overlap
  type Drawable = { type: 'agent'; name: string; agent: AgentSprite } | { type: 'player' };
  const drawables: Drawable[] = [];

  for (const [name, agent] of agents) {
    drawables.push({ type: 'agent', name, agent });
  }
  drawables.push({ type: 'player' });

  drawables.sort((a, b) => {
    const ay = a.type === 'player' ? playerY : a.agent.position.y;
    const by = b.type === 'player' ? playerY : b.agent.position.y;
    return ay - by;
  });

  // Draw all entities
  for (const d of drawables) {
    if (d.type === 'agent') {
      const a = d.agent;
      const screenX = a.position.x * TILE_SIZE - camera.x;
      const screenY = a.position.y * TILE_SIZE - camera.y;
      // Frustum culling
      if (
        screenX > -TILE_SIZE * 2 &&
        screenX < canvasWidth + TILE_SIZE * 2 &&
        screenY > -TILE_SIZE * 2 &&
        screenY < canvasHeight + TILE_SIZE * 2
      ) {
        ctx.save();
        ctx.translate(-camera.x, -camera.y);
        drawAgent(
          ctx,
          a.position.x,
          a.position.y,
          a.color,
          a.status,
          d.name,
          frame,
          d.name === selectedAgent,
          a.isLead,
        );
        // Hover highlight
        if (d.name === hoveredAgent && d.name !== selectedAgent) {
          const px = a.position.x * TILE_SIZE;
          const py = a.position.y * TILE_SIZE;
          ctx.strokeStyle = 'rgba(255,255,255,0.4)';
          ctx.lineWidth = 1;
          ctx.strokeRect(px - 2, py - 18, TILE_SIZE + 4, TILE_SIZE + 22);
        }
        ctx.restore();
      }
    } else {
      // Draw player
      ctx.save();
      ctx.translate(-camera.x, -camera.y);
      drawPlayer(ctx, playerX, playerY, playerDirection, playerFrame, playerIsMoving);
      ctx.restore();
    }
  }

  // Click target indicator (subtle)
  // (Handled by interaction layer if needed)
}
