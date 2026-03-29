/* ============================================================
   Office Layout Generator
   Auto-generates a tile map from a list of bot names.
   ============================================================ */

import { TileType, type TileMap, type Room, type Position } from '../types';

interface LayoutInput {
  name: string;
  specialties?: string[];
  platform?: string;
}

interface LayoutResult {
  tileMap: TileMap;
  rooms: Room[];
  agentPositions: Map<string, { seat: Position; desk: Position }>;
  playerSpawn: Position;
}

/** Group bots into rooms by first specialty or platform */
function groupBots(bots: LayoutInput[]): Map<string, LayoutInput[]> {
  const groups = new Map<string, LayoutInput[]>();
  for (const bot of bots) {
    const key = bot.specialties?.[0] || bot.platform || 'general';
    const arr = groups.get(key) || [];
    arr.push(bot);
    groups.set(key, arr);
  }
  return groups;
}

/** Create a single room with desks for n agents */
function createRoom(
  id: string,
  name: string,
  agentCount: number,
  offsetX: number,
  offsetY: number,
): { room: Room; desks: Position[]; seats: Position[]; width: number; height: number } {
  // Layout: 2 columns of desks, each desk takes 2x2 area (desk + seat)
  const cols = 2;
  const rows = Math.ceil(agentCount / cols);
  // Room inner size: cols * 3 wide (desk spacing) + 1 padding, rows * 2 + 1 padding
  const innerW = cols * 4;
  const innerH = rows * 3 + 1;
  const width = innerW + 2; // +2 for walls
  const height = innerH + 2;

  const desks: Position[] = [];
  const seats: Position[] = [];

  for (let i = 0; i < agentCount; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const dx = offsetX + 1 + col * 4 + 1;
    const dy = offsetY + 1 + row * 3 + 1;
    desks.push({ x: dx, y: dy });
    seats.push({ x: dx, y: dy + 1 }); // agent sits south of desk
  }

  return {
    room: {
      id,
      name,
      x: offsetX,
      y: offsetY,
      width,
      height,
      agents: [],
    },
    desks,
    seats,
    width,
    height,
  };
}

export function generateLayout(bots: LayoutInput[]): LayoutResult {
  if (bots.length === 0) {
    return {
      tileMap: { width: 10, height: 10, tiles: Array.from({ length: 10 }, () => Array(10).fill(TileType.FLOOR)) },
      rooms: [],
      agentPositions: new Map(),
      playerSpawn: { x: 5, y: 5 },
    };
  }

  const groups = groupBots(bots);
  const roomDefs: { id: string; name: string; bots: LayoutInput[] }[] = [];
  let i = 0;
  for (const [name, members] of groups) {
    roomDefs.push({ id: `room-${i}`, name, bots: members });
    i++;
  }

  // Corridor height
  const corridorH = 3;

  // Calculate room sizes and total width
  const roomResults: ReturnType<typeof createRoom>[] = [];
  let totalWidth = 1; // left margin
  const roomY = 1; // top margin

  for (const def of roomDefs) {
    const result = createRoom(def.id, def.name, def.bots.length, totalWidth, roomY);
    roomResults.push(result);
    totalWidth += result.width + 1; // gap between rooms
  }
  totalWidth = Math.max(totalWidth, 12);

  const maxRoomHeight = Math.max(...roomResults.map((r) => r.height), 6);
  const corridorY = roomY + maxRoomHeight;
  const totalHeight = corridorY + corridorH + 2;

  // Initialize tile map with VOID
  const tiles: TileType[][] = Array.from({ length: totalHeight }, () =>
    Array(totalWidth).fill(TileType.VOID),
  );

  const rooms: Room[] = [];
  const agentPositions = new Map<string, { seat: Position; desk: Position }>();

  // Draw each room
  for (let ri = 0; ri < roomDefs.length; ri++) {
    const def = roomDefs[ri];
    const result = roomResults[ri];
    const { room } = result;

    // Draw room floor and walls
    for (let ry = room.y; ry < room.y + result.height; ry++) {
      for (let rx = room.x; rx < room.x + result.width; rx++) {
        if (ry < 0 || ry >= totalHeight || rx < 0 || rx >= totalWidth) continue;
        if (
          ry === room.y ||
          ry === room.y + result.height - 1 ||
          rx === room.x ||
          rx === room.x + result.width - 1
        ) {
          tiles[ry][rx] = TileType.WALL;
        } else {
          tiles[ry][rx] = TileType.FLOOR;
        }
      }
    }

    // Place door at bottom center of room
    const doorX = room.x + Math.floor(result.width / 2);
    const doorY = room.y + result.height - 1;
    if (doorY < totalHeight && doorX < totalWidth) {
      tiles[doorY][doorX] = TileType.DOOR;
    }

    // Place desks and chairs
    for (let di = 0; di < result.desks.length; di++) {
      const desk = result.desks[di];
      const seat = result.seats[di];
      if (desk.y < totalHeight && desk.x < totalWidth) tiles[desk.y][desk.x] = TileType.DESK;
      if (seat.y < totalHeight && seat.x < totalWidth) tiles[seat.y][seat.x] = TileType.CHAIR;
    }

    // Assign agents to positions
    const agentNames: string[] = [];
    for (let ai = 0; ai < def.bots.length; ai++) {
      agentPositions.set(def.bots[ai].name, {
        seat: result.seats[ai],
        desk: result.desks[ai],
      });
      agentNames.push(def.bots[ai].name);
    }

    rooms.push({ ...room, agents: agentNames });
  }

  // Draw corridor
  for (let cy = corridorY; cy < corridorY + corridorH && cy < totalHeight; cy++) {
    for (let cx = 0; cx < totalWidth; cx++) {
      if (tiles[cy][cx] === TileType.VOID) {
        tiles[cy][cx] = TileType.CARPET;
      }
    }
  }

  // Add some plants for decoration
  const plantPositions = [
    { x: 0, y: corridorY },
    { x: totalWidth - 1, y: corridorY },
    { x: 0, y: corridorY + corridorH - 1 },
    { x: totalWidth - 1, y: corridorY + corridorH - 1 },
  ];
  for (const p of plantPositions) {
    if (p.y < totalHeight && p.x < totalWidth && tiles[p.y][p.x] !== TileType.WALL) {
      tiles[p.y][p.x] = TileType.PLANT;
    }
  }

  const playerSpawn: Position = {
    x: Math.floor(totalWidth / 2),
    y: corridorY + 1,
  };
  // Ensure spawn tile is walkable
  if (playerSpawn.y < totalHeight && playerSpawn.x < totalWidth) {
    tiles[playerSpawn.y][playerSpawn.x] = TileType.CARPET;
  }

  return {
    tileMap: { width: totalWidth, height: totalHeight, tiles },
    rooms,
    agentPositions,
    playerSpawn,
  };
}
