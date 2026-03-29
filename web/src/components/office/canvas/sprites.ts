/* ============================================================
   Pixel Sprites — Pure Canvas drawing (no image assets)
   ============================================================ */

import { TileType, TILE_SIZE, type AgentStatus, type Direction } from '../types';

// ── Color Palette ──

const COLORS = {
  floorLight: '#3a3d4a',
  floorDark: '#353845',
  wall: '#2a2d3a',
  wallTop: '#4a4d5a',
  desk: '#6b5b45',
  deskTop: '#7d6b52',
  monitor: '#4a90d9',
  monitorScreen: '#1a1a2e',
  carpet: '#2e3448',
  carpetStripe: '#343a50',
  plant: '#3d8b37',
  plantPot: '#8b6b4a',
  door: '#5a4a3a',
  doorKnob: '#d4a843',
  chair: '#4a4a5a',
  grid: 'rgba(255,255,255,0.03)',
};

const AGENT_PALETTE = [
  '#e06060', '#e09040', '#e0d040', '#60c060',
  '#40b0d0', '#6080e0', '#a060d0', '#d060a0',
  '#c08060', '#60b0a0', '#b0b040', '#8080c0',
];

/** Deterministic color from bot name */
export function agentColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  return AGENT_PALETTE[Math.abs(hash) % AGENT_PALETTE.length];
}

// ── Tile Drawing ──

export function drawTile(ctx: CanvasRenderingContext2D, x: number, y: number, type: TileType): void {
  const px = x * TILE_SIZE;
  const py = y * TILE_SIZE;

  switch (type) {
    case TileType.FLOOR:
      ctx.fillStyle = (x + y) % 2 === 0 ? COLORS.floorLight : COLORS.floorDark;
      ctx.fillRect(px, py, TILE_SIZE, TILE_SIZE);
      ctx.strokeStyle = COLORS.grid;
      ctx.strokeRect(px, py, TILE_SIZE, TILE_SIZE);
      break;

    case TileType.WALL:
      ctx.fillStyle = COLORS.wall;
      ctx.fillRect(px, py, TILE_SIZE, TILE_SIZE);
      // Top edge highlight for 3D effect
      ctx.fillStyle = COLORS.wallTop;
      ctx.fillRect(px, py, TILE_SIZE, 4);
      break;

    case TileType.DESK:
      // Floor underneath
      ctx.fillStyle = COLORS.floorLight;
      ctx.fillRect(px, py, TILE_SIZE, TILE_SIZE);
      // Desk body
      ctx.fillStyle = COLORS.desk;
      ctx.fillRect(px + 2, py + 4, TILE_SIZE - 4, TILE_SIZE - 6);
      ctx.fillStyle = COLORS.deskTop;
      ctx.fillRect(px + 2, py + 4, TILE_SIZE - 4, 3);
      // Monitor
      ctx.fillStyle = COLORS.monitorScreen;
      ctx.fillRect(px + 10, py + 8, 12, 10);
      ctx.fillStyle = COLORS.monitor;
      ctx.fillRect(px + 9, py + 7, 14, 1);
      ctx.fillRect(px + 9, py + 18, 14, 1);
      ctx.fillRect(px + 14, py + 19, 4, 3);
      break;

    case TileType.CHAIR:
      // Floor underneath
      ctx.fillStyle = COLORS.floorLight;
      ctx.fillRect(px, py, TILE_SIZE, TILE_SIZE);
      // Chair
      ctx.fillStyle = COLORS.chair;
      ctx.fillRect(px + 8, py + 6, 16, 14);
      ctx.fillStyle = '#5a5a6a';
      ctx.fillRect(px + 10, py + 4, 12, 4); // backrest
      break;

    case TileType.DOOR:
      ctx.fillStyle = COLORS.door;
      ctx.fillRect(px, py, TILE_SIZE, TILE_SIZE);
      ctx.fillStyle = COLORS.doorKnob;
      ctx.beginPath();
      ctx.arc(px + 22, py + TILE_SIZE / 2, 2, 0, Math.PI * 2);
      ctx.fill();
      break;

    case TileType.CARPET:
      ctx.fillStyle = COLORS.carpet;
      ctx.fillRect(px, py, TILE_SIZE, TILE_SIZE);
      // Subtle stripe pattern
      if (y % 2 === 0) {
        ctx.fillStyle = COLORS.carpetStripe;
        ctx.fillRect(px, py + 14, TILE_SIZE, 4);
      }
      break;

    case TileType.PLANT:
      ctx.fillStyle = COLORS.carpet;
      ctx.fillRect(px, py, TILE_SIZE, TILE_SIZE);
      // Pot
      ctx.fillStyle = COLORS.plantPot;
      ctx.fillRect(px + 10, py + 18, 12, 10);
      ctx.fillRect(px + 8, py + 16, 16, 4);
      // Leaves
      ctx.fillStyle = COLORS.plant;
      ctx.beginPath();
      ctx.arc(px + 16, py + 12, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#4da047';
      ctx.beginPath();
      ctx.arc(px + 12, py + 9, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(px + 20, py + 10, 5, 0, Math.PI * 2);
      ctx.fill();
      break;

    case TileType.VOID:
    default:
      // Draw nothing (transparent / background)
      break;
  }
}

// ── Agent Sprite ──

const STATUS_COLORS: Record<AgentStatus, string> = {
  idle: '#4caf50',
  busy: '#ff9800',
  error: '#f44336',
};

export function drawAgent(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
  status: AgentStatus,
  name: string,
  frame: number,
  isSelected: boolean,
): void {
  const px = x * TILE_SIZE;
  const py = y * TILE_SIZE;
  const cx = px + TILE_SIZE / 2;

  // Selection highlight
  if (isSelected) {
    ctx.strokeStyle = '#ffd700';
    ctx.lineWidth = 2;
    ctx.strokeRect(px - 2, py - 18, TILE_SIZE + 4, TILE_SIZE + 22);
    ctx.lineWidth = 1;
  }

  // Body
  ctx.fillStyle = color;
  ctx.fillRect(cx - 6, py + 10, 12, 14);

  // Head
  ctx.fillStyle = '#f5d0a9';
  ctx.beginPath();
  ctx.arc(cx, py + 6, 6, 0, Math.PI * 2);
  ctx.fill();

  // Hair
  ctx.fillStyle = darken(color, 40);
  ctx.beginPath();
  ctx.arc(cx, py + 3, 6, Math.PI, Math.PI * 2);
  ctx.fill();

  // Eyes
  ctx.fillStyle = '#222';
  ctx.fillRect(cx - 3, py + 5, 2, 2);
  ctx.fillRect(cx + 1, py + 5, 2, 2);

  // Feet (walking animation)
  ctx.fillStyle = '#333';
  const footOffset = status === 'busy' ? Math.sin(frame * 0.5) * 2 : 0;
  ctx.fillRect(cx - 5, py + 24 + footOffset, 4, 4);
  ctx.fillRect(cx + 1, py + 24 - footOffset, 4, 4);

  // Status indicator (circle above head)
  const statusColor = STATUS_COLORS[status];
  ctx.fillStyle = statusColor;
  ctx.beginPath();
  ctx.arc(cx, py - 4, 3, 0, Math.PI * 2);
  ctx.fill();
  // Pulse effect for busy
  if (status === 'busy') {
    const pulse = 0.3 + 0.7 * Math.abs(Math.sin(frame * 0.1));
    ctx.globalAlpha = pulse;
    ctx.beginPath();
    ctx.arc(cx, py - 4, 5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // Typing dots for busy agents
  if (status === 'busy') {
    const dotPhase = Math.floor(frame / 8) % 3;
    for (let i = 0; i < 3; i++) {
      ctx.fillStyle = i === dotPhase ? '#fff' : 'rgba(255,255,255,0.3)';
      ctx.beginPath();
      ctx.arc(cx - 6 + i * 6, py - 12, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Name label
  ctx.fillStyle = '#fff';
  ctx.font = '9px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const nameWidth = ctx.measureText(name).width;
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(cx - nameWidth / 2 - 2, py + 30, nameWidth + 4, 11);
  ctx.fillStyle = '#ddd';
  ctx.fillText(name, cx, py + 31);
}

// ── Player Sprite ──

export function drawPlayer(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  direction: Direction,
  frame: number,
  isMoving: boolean,
): void {
  const px = x * TILE_SIZE;
  const py = y * TILE_SIZE;
  const cx = px + TILE_SIZE / 2;

  // Shadow
  ctx.fillStyle = 'rgba(0,0,0,0.2)';
  ctx.beginPath();
  ctx.ellipse(cx, py + 28, 8, 3, 0, 0, Math.PI * 2);
  ctx.fill();

  // Body (green accent)
  ctx.fillStyle = '#4caf50';
  ctx.fillRect(cx - 6, py + 10, 12, 14);

  // Head
  ctx.fillStyle = '#f5d0a9';
  ctx.beginPath();
  ctx.arc(cx, py + 6, 6, 0, Math.PI * 2);
  ctx.fill();

  // Hair
  ctx.fillStyle = '#4a3520';
  ctx.beginPath();
  ctx.arc(cx, py + 3, 6, Math.PI, Math.PI * 2);
  ctx.fill();

  // Eyes (direction-aware)
  ctx.fillStyle = '#222';
  const eyeOffX = direction === 'left' ? -1 : direction === 'right' ? 1 : 0;
  const eyeOffY = direction === 'up' ? -1 : 0;
  ctx.fillRect(cx - 3 + eyeOffX, py + 5 + eyeOffY, 2, 2);
  ctx.fillRect(cx + 1 + eyeOffX, py + 5 + eyeOffY, 2, 2);

  // Feet (animated when moving)
  ctx.fillStyle = '#333';
  const footAnim = isMoving ? Math.sin(frame * 1.5) * 3 : 0;
  ctx.fillRect(cx - 5, py + 24 + footAnim, 4, 4);
  ctx.fillRect(cx + 1, py + 24 - footAnim, 4, 4);

  // "You" label
  ctx.fillStyle = 'rgba(76,175,80,0.7)';
  ctx.font = 'bold 8px monospace';
  ctx.textAlign = 'center';
  const w = ctx.measureText('YOU').width;
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(cx - w / 2 - 2, py - 6, w + 4, 10);
  ctx.fillStyle = '#4caf50';
  ctx.fillText('YOU', cx, py - 5);
}

// ── Room Label ──

export function drawRoomLabel(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  name: string,
): void {
  const px = x * TILE_SIZE;
  const py = y * TILE_SIZE;
  const centerX = px + (width * TILE_SIZE) / 2;

  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.font = 'bold 11px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(name.toUpperCase(), centerX, py + 6);
}

// ── Helpers ──

function darken(hex: string, amount: number): string {
  const num = parseInt(hex.replace('#', ''), 16);
  const r = Math.max(0, (num >> 16) - amount);
  const g = Math.max(0, ((num >> 8) & 0xff) - amount);
  const b = Math.max(0, (num & 0xff) - amount);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}
