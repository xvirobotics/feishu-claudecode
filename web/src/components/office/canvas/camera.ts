/* ============================================================
   Camera — Viewport following the player
   ============================================================ */

import { TILE_SIZE } from '../types';

export interface Camera {
  x: number;
  y: number;
  targetX: number;
  targetY: number;
}

export function createCamera(): Camera {
  return { x: 0, y: 0, targetX: 0, targetY: 0 };
}

/**
 * Update camera to follow the player with smooth easing.
 * Player is kept centered in the viewport.
 */
export function updateCamera(
  camera: Camera,
  playerX: number,
  playerY: number,
  canvasWidth: number,
  canvasHeight: number,
  mapWidth: number,
  mapHeight: number,
  dt: number,
): void {
  // Target: center player in viewport
  camera.targetX = playerX * TILE_SIZE + TILE_SIZE / 2 - canvasWidth / 2;
  camera.targetY = playerY * TILE_SIZE + TILE_SIZE / 2 - canvasHeight / 2;

  // Clamp to map bounds
  const maxX = mapWidth * TILE_SIZE - canvasWidth;
  const maxY = mapHeight * TILE_SIZE - canvasHeight;
  camera.targetX = Math.max(0, Math.min(camera.targetX, maxX));
  camera.targetY = Math.max(0, Math.min(camera.targetY, maxY));

  // Allow negative if map is smaller than viewport (center the map)
  if (mapWidth * TILE_SIZE < canvasWidth) {
    camera.targetX = -(canvasWidth - mapWidth * TILE_SIZE) / 2;
  }
  if (mapHeight * TILE_SIZE < canvasHeight) {
    camera.targetY = -(canvasHeight - mapHeight * TILE_SIZE) / 2;
  }

  // Smooth easing
  const ease = 1 - Math.pow(0.001, dt);
  camera.x += (camera.targetX - camera.x) * ease;
  camera.y += (camera.targetY - camera.y) * ease;
}
