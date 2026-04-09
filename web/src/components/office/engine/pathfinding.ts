/* ============================================================
   A* Pathfinding on Tile Grid (4-directional)
   ============================================================ */

import { type TileMap, type Position, WALKABLE_TILES, TileType } from '../types';

interface Node {
  x: number;
  y: number;
  g: number; // cost from start
  h: number; // heuristic to end
  f: number; // g + h
  parent: Node | null;
}

function manhattan(a: Position, b: Position): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

const DIRS = [
  { x: 0, y: -1 }, // up
  { x: 0, y: 1 },  // down
  { x: -1, y: 0 }, // left
  { x: 1, y: 0 },  // right
];

function isWalkable(tileMap: TileMap, x: number, y: number): boolean {
  if (x < 0 || x >= tileMap.width || y < 0 || y >= tileMap.height) return false;
  return WALKABLE_TILES.has(tileMap.tiles[y][x]);
}

/**
 * Find shortest path from start to end on a tile map.
 * Returns array of positions (excluding start, including end), or null if no path.
 */
export function findPath(
  tileMap: TileMap,
  start: Position,
  end: Position,
): Position[] | null {
  if (!isWalkable(tileMap, end.x, end.y)) return null;
  if (start.x === end.x && start.y === end.y) return [];

  const key = (x: number, y: number) => `${x},${y}`;
  const open: Node[] = [];
  const closed = new Set<string>();

  const startNode: Node = {
    x: start.x,
    y: start.y,
    g: 0,
    h: manhattan(start, end),
    f: manhattan(start, end),
    parent: null,
  };
  open.push(startNode);

  while (open.length > 0) {
    // Find node with lowest f
    let lowestIdx = 0;
    for (let i = 1; i < open.length; i++) {
      if (open[i].f < open[lowestIdx].f) lowestIdx = i;
    }
    const current = open[lowestIdx];
    open.splice(lowestIdx, 1);

    if (current.x === end.x && current.y === end.y) {
      // Reconstruct path
      const path: Position[] = [];
      let node: Node | null = current;
      while (node && !(node.x === start.x && node.y === start.y)) {
        path.unshift({ x: node.x, y: node.y });
        node = node.parent;
      }
      return path;
    }

    closed.add(key(current.x, current.y));

    for (const dir of DIRS) {
      const nx = current.x + dir.x;
      const ny = current.y + dir.y;
      const nk = key(nx, ny);

      if (closed.has(nk) || !isWalkable(tileMap, nx, ny)) continue;

      const g = current.g + 1;
      const existing = open.find((n) => n.x === nx && n.y === ny);
      if (existing) {
        if (g < existing.g) {
          existing.g = g;
          existing.f = g + existing.h;
          existing.parent = current;
        }
      } else {
        const h = manhattan({ x: nx, y: ny }, end);
        open.push({ x: nx, y: ny, g, h, f: g + h, parent: current });
      }
    }
  }

  return null; // no path found
}

/**
 * Find the nearest walkable tile to the target.
 * Useful when clicking on a non-walkable tile (desk, wall).
 */
export function findNearestWalkable(
  tileMap: TileMap,
  target: Position,
): Position | null {
  if (isWalkable(tileMap, target.x, target.y)) return target;

  // BFS outward
  const visited = new Set<string>();
  const queue: Position[] = [target];
  visited.add(`${target.x},${target.y}`);

  while (queue.length > 0) {
    const pos = queue.shift()!;
    for (const dir of DIRS) {
      const nx = pos.x + dir.x;
      const ny = pos.y + dir.y;
      const k = `${nx},${ny}`;
      if (visited.has(k)) continue;
      visited.add(k);
      if (nx < 0 || nx >= tileMap.width || ny < 0 || ny >= tileMap.height) continue;
      if (isWalkable(tileMap, nx, ny)) return { x: nx, y: ny };
      queue.push({ x: nx, y: ny });
    }
  }

  return null;
}
