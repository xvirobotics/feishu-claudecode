/* ============================================================
   Office Layout Generator
   Creates a large office where each bot has its own room
   containing its sub-agents at individual desks.
   ============================================================ */

import { TileType, type TileMap, type Room, type Position } from '../types';

export interface SubAgent {
  name: string;
  description?: string;
  model?: string;
}

export interface LayoutInput {
  name: string;
  specialties?: string[];
  platform?: string;
  agents?: SubAgent[];
}

export interface LayoutResult {
  tileMap: TileMap;
  rooms: Room[];
  /** Key: "botName" for the lead, "botName/subAgentName" for sub-agents */
  agentPositions: Map<string, { seat: Position; desk: Position }>;
  playerSpawn: Position;
}

interface RoomLayout {
  room: Room;
  desks: Position[];
  seats: Position[];
  width: number;
  height: number;
}

/**
 * Create a room for a bot and its sub-agents.
 * The bot lead sits at a prominent desk; sub-agents fill rows behind.
 */
function createTeamRoom(
  id: string,
  name: string,
  memberCount: number, // lead + sub-agents
  offsetX: number,
  offsetY: number,
): RoomLayout {
  const cols = Math.min(memberCount, 3);
  const rows = Math.ceil(memberCount / cols);
  const innerW = cols * 4 + 1;
  const innerH = rows * 3 + 2; // extra row for room label
  const width = innerW + 2;
  const height = innerH + 2;

  const desks: Position[] = [];
  const seats: Position[] = [];

  for (let i = 0; i < memberCount; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const dx = offsetX + 1 + col * 4 + 1;
    const dy = offsetY + 2 + row * 3 + 1; // +2 for label space
    desks.push({ x: dx, y: dy });
    seats.push({ x: dx, y: dy + 1 });
  }

  return {
    room: { id, name, x: offsetX, y: offsetY, width, height, agents: [] },
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

  // Each bot gets its own room. Members = lead (the bot) + its sub-agents.
  const teamRooms: { bot: LayoutInput; members: string[]; memberCount: number }[] = [];
  for (const bot of bots) {
    const subNames = (bot.agents || []).map((a) => a.name);
    teamRooms.push({
      bot,
      members: [bot.name, ...subNames],
      memberCount: 1 + subNames.length,
    });
  }

  // Arrange rooms in a grid layout (multiple rows of rooms)
  const maxRoomsPerRow = Math.min(teamRooms.length, 4);
  const rowCount = Math.ceil(teamRooms.length / maxRoomsPerRow);
  const corridorH = 3;

  // First pass: compute room sizes
  const roomLayouts: RoomLayout[] = [];
  for (let i = 0; i < teamRooms.length; i++) {
    const t = teamRooms[i];
    // Placeholder position, will recompute
    roomLayouts.push(createTeamRoom(`room-${i}`, t.bot.name, t.memberCount, 0, 0));
  }

  // Compute row widths and heights
  const rowInfos: { roomIndices: number[]; maxHeight: number; totalWidth: number }[] = [];
  for (let r = 0; r < rowCount; r++) {
    const startIdx = r * maxRoomsPerRow;
    const endIdx = Math.min(startIdx + maxRoomsPerRow, teamRooms.length);
    const indices = [];
    let maxH = 0;
    let totalW = 1; // left margin
    for (let i = startIdx; i < endIdx; i++) {
      indices.push(i);
      maxH = Math.max(maxH, roomLayouts[i].height);
      totalW += roomLayouts[i].width + 1;
    }
    rowInfos.push({ roomIndices: indices, maxHeight: maxH, totalWidth: totalW });
  }

  const maxTotalWidth = Math.max(...rowInfos.map((r) => r.totalWidth), 16);

  // Second pass: place rooms with correct offsets
  let currentY = 1;
  const finalRooms: RoomLayout[] = [];

  for (let r = 0; r < rowInfos.length; r++) {
    const info = rowInfos[r];
    let currentX = 1;

    for (const idx of info.roomIndices) {
      const t = teamRooms[idx];
      const layout = createTeamRoom(`room-${idx}`, t.bot.name, t.memberCount, currentX, currentY);
      finalRooms[idx] = layout;
      currentX += layout.width + 1;
    }

    currentY += info.maxHeight;

    // Add corridor after each row of rooms
    currentY += corridorH;
  }

  const totalHeight = currentY + 1;
  const totalWidth = maxTotalWidth;

  // Initialize tile map
  const tiles: TileType[][] = Array.from({ length: totalHeight }, () =>
    Array(totalWidth).fill(TileType.VOID),
  );

  const rooms: Room[] = [];
  const agentPositions = new Map<string, { seat: Position; desk: Position }>();

  // Draw rooms
  for (let idx = 0; idx < teamRooms.length; idx++) {
    const t = teamRooms[idx];
    const layout = finalRooms[idx];
    if (!layout) continue;
    const { room } = layout;

    // Draw floor and walls
    for (let ry = room.y; ry < room.y + layout.height; ry++) {
      for (let rx = room.x; rx < room.x + layout.width; rx++) {
        if (ry < 0 || ry >= totalHeight || rx < 0 || rx >= totalWidth) continue;
        const isWall =
          ry === room.y ||
          ry === room.y + layout.height - 1 ||
          rx === room.x ||
          rx === room.x + layout.width - 1;
        tiles[ry][rx] = isWall ? TileType.WALL : TileType.FLOOR;
      }
    }

    // Door at bottom center
    const doorX = room.x + Math.floor(layout.width / 2);
    const doorY = room.y + layout.height - 1;
    if (doorY < totalHeight && doorX < totalWidth) tiles[doorY][doorX] = TileType.DOOR;

    // Place desks and chairs, assign positions
    const agentNames: string[] = [];
    for (let mi = 0; mi < t.members.length; mi++) {
      const desk = layout.desks[mi];
      const seat = layout.seats[mi];
      if (!desk || !seat) continue;
      if (desk.y < totalHeight && desk.x < totalWidth) tiles[desk.y][desk.x] = TileType.DESK;
      if (seat.y < totalHeight && seat.x < totalWidth) tiles[seat.y][seat.x] = TileType.CHAIR;

      const memberName = t.members[mi];
      // Key: "botName" for lead, "botName/subAgentName" for sub-agents
      const key = mi === 0 ? memberName : `${t.bot.name}/${memberName}`;
      agentPositions.set(key, { seat, desk });
      agentNames.push(key);
    }

    rooms.push({ ...room, agents: agentNames });
  }

  // Draw corridors (fill VOID rows between room rows)
  for (let y = 0; y < totalHeight; y++) {
    // Check if this row is entirely VOID across the width — it's a corridor row
    let isCorridorRow = true;
    for (let x = 0; x < totalWidth; x++) {
      if (tiles[y][x] !== TileType.VOID) { isCorridorRow = false; break; }
    }
    if (isCorridorRow) {
      // Check if adjacent to a room (wall or door above or below)
      let nearRoom = false;
      for (let x = 0; x < totalWidth; x++) {
        if (y > 0 && (tiles[y - 1][x] === TileType.WALL || tiles[y - 1][x] === TileType.DOOR)) nearRoom = true;
        if (y < totalHeight - 1 && (tiles[y + 1][x] === TileType.WALL || tiles[y + 1][x] === TileType.DOOR)) nearRoom = true;
      }
      if (nearRoom) {
        for (let x = 0; x < totalWidth; x++) {
          if (tiles[y][x] === TileType.VOID) tiles[y][x] = TileType.CARPET;
        }
      }
    }
  }

  // Fill remaining VOID gaps between rooms in the same row with carpet
  for (let y = 0; y < totalHeight; y++) {
    let hasFloor = false;
    for (let x = 0; x < totalWidth; x++) {
      if (tiles[y][x] === TileType.FLOOR || tiles[y][x] === TileType.CARPET) hasFloor = true;
    }
    if (!hasFloor) continue;
    // Fill VOID gaps in rows that have floor tiles
    let first = -1;
    let last = -1;
    for (let x = 0; x < totalWidth; x++) {
      if (tiles[y][x] !== TileType.VOID) {
        if (first < 0) first = x;
        last = x;
      }
    }
    // Don't fill — the walls themselves form the boundary
  }

  // Add a main corridor at the bottom spanning full width
  const mainCorridorY = totalHeight - corridorH - 1;
  for (let cy = mainCorridorY; cy < mainCorridorY + corridorH && cy < totalHeight; cy++) {
    for (let cx = 0; cx < totalWidth; cx++) {
      if (tiles[cy][cx] === TileType.VOID) tiles[cy][cx] = TileType.CARPET;
    }
  }

  // Connect rooms to corridors: ensure carpet path from each door downward
  for (const layout of finalRooms) {
    if (!layout) continue;
    const doorX = layout.room.x + Math.floor(layout.width / 2);
    const doorY = layout.room.y + layout.height - 1;
    for (let y = doorY + 1; y < totalHeight; y++) {
      if (tiles[y][doorX] === TileType.VOID) tiles[y][doorX] = TileType.CARPET;
      if (tiles[y][doorX] === TileType.CARPET) break; // reached corridor
      if (tiles[y][doorX] === TileType.WALL) break;
    }
  }

  // Plants at corridor corners
  const plantCandidates = [
    { x: 0, y: mainCorridorY },
    { x: totalWidth - 1, y: mainCorridorY },
  ];
  for (const p of plantCandidates) {
    if (p.y >= 0 && p.y < totalHeight && p.x >= 0 && p.x < totalWidth) {
      if (tiles[p.y][p.x] === TileType.CARPET || tiles[p.y][p.x] === TileType.VOID) {
        tiles[p.y][p.x] = TileType.PLANT;
      }
    }
  }

  // Player spawns at bottom center corridor
  const playerSpawn: Position = {
    x: Math.floor(totalWidth / 2),
    y: Math.min(mainCorridorY + 1, totalHeight - 2),
  };
  if (playerSpawn.y >= 0 && playerSpawn.y < totalHeight && playerSpawn.x >= 0 && playerSpawn.x < totalWidth) {
    tiles[playerSpawn.y][playerSpawn.x] = TileType.CARPET;
  }

  return { tileMap: { width: totalWidth, height: totalHeight, tiles }, rooms, agentPositions, playerSpawn };
}
