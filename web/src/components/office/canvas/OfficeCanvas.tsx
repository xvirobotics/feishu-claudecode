/* ============================================================
   OfficeCanvas — React component wrapping the <canvas> element
   with game loop, click/hover handling, and rendering.
   ============================================================ */

import { useRef, useEffect, useCallback } from 'react';
import type { TileMap, AgentSprite, Room, Position } from '../types';
import { TILE_SIZE } from '../types';
import { createCamera, updateCamera, type Camera } from './camera';
import { renderStaticLayer, renderFrame } from './renderer';
import { createMovementState, setPath, updateMovement, type MovementState } from '../engine/movement';
import { findPath, findNearestWalkable } from '../engine/pathfinding';
import { detectClick, detectHover } from '../engine/interaction';

interface OfficeCanvasProps {
  tileMap: TileMap;
  rooms: Room[];
  agents: Map<string, AgentSprite>;
  playerSpawn: Position;
  selectedAgent: string | null;
  onSelectAgent: (name: string | null) => void;
  onHoverAgent: (name: string | null) => void;
  hoveredAgent: string | null;
}

export function OfficeCanvas({
  tileMap,
  rooms,
  agents,
  playerSpawn,
  selectedAgent,
  onSelectAgent,
  onHoverAgent,
  hoveredAgent,
}: OfficeCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef<Camera>(createCamera());
  const movementRef = useRef<MovementState>(createMovementState(playerSpawn));
  const staticLayerRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef(0);
  const rafRef = useRef(0);
  const lastTimeRef = useRef(0);

  // Rebuild static layer when tileMap changes
  useEffect(() => {
    staticLayerRef.current = renderStaticLayer(tileMap, rooms);
  }, [tileMap, rooms]);

  // Reset player on spawn change
  useEffect(() => {
    const m = movementRef.current;
    m.tileX = playerSpawn.x;
    m.tileY = playerSpawn.y;
    m.visualX = playerSpawn.x;
    m.visualY = playerSpawn.y;
    m.path = [];
    m.isMoving = false;
  }, [playerSpawn]);

  // Canvas resize
  useEffect(() => {
    const resize = () => {
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!canvas || !container) return;
      const rect = container.getBoundingClientRect();
      canvas.width = rect.width;
      canvas.height = rect.height;
    };
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  // Main game loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    lastTimeRef.current = performance.now();

    const loop = (time: number) => {
      const dt = Math.min((time - lastTimeRef.current) / 1000, 0.1); // cap at 100ms
      lastTimeRef.current = time;
      frameRef.current++;

      const camera = cameraRef.current;
      const movement = movementRef.current;

      // Update movement
      updateMovement(movement, dt);

      // Update camera
      updateCamera(
        camera,
        movement.visualX,
        movement.visualY,
        canvas.width,
        canvas.height,
        tileMap.width,
        tileMap.height,
        dt,
      );

      // Render
      if (staticLayerRef.current) {
        renderFrame(
          ctx,
          canvas.width,
          canvas.height,
          camera,
          staticLayerRef.current,
          agents,
          movement.visualX,
          movement.visualY,
          movement.direction,
          movement.frame,
          movement.isMoving,
          selectedAgent,
          hoveredAgent,
          frameRef.current,
        );
      }

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [tileMap, agents, selectedAgent, hoveredAgent]);

  // Click handler
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const camera = cameraRef.current;

      const result = detectClick(sx, sy, camera.x, camera.y, agents);

      if (result.type === 'agent' && result.agentName) {
        onSelectAgent(result.agentName);
        return;
      }

      // Move to clicked tile
      if (result.type === 'floor') {
        const movement = movementRef.current;
        const start = { x: movement.tileX, y: movement.tileY };
        let target = result.tilePos;

        // If not walkable, find nearest walkable
        const nearest = findNearestWalkable(tileMap, target);
        if (!nearest) return;
        target = nearest;

        const path = findPath(tileMap, start, target);
        if (path && path.length > 0) {
          setPath(movement, path);
        }
      }
    },
    [tileMap, agents, onSelectAgent],
  );

  // Touch handler (mobile)
  const handleTouch = useCallback(
    (e: React.TouchEvent<HTMLCanvasElement>) => {
      if (e.touches.length !== 1) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const touch = e.touches[0];
      const sx = touch.clientX - rect.left;
      const sy = touch.clientY - rect.top;
      const camera = cameraRef.current;

      const result = detectClick(sx, sy, camera.x, camera.y, agents);

      if (result.type === 'agent' && result.agentName) {
        onSelectAgent(result.agentName);
        return;
      }

      if (result.type === 'floor') {
        const movement = movementRef.current;
        const start = { x: movement.tileX, y: movement.tileY };
        const nearest = findNearestWalkable(tileMap, result.tilePos);
        if (!nearest) return;
        const path = findPath(tileMap, start, nearest);
        if (path && path.length > 0) {
          setPath(movement, path);
        }
      }
    },
    [tileMap, agents, onSelectAgent],
  );

  // Mouse move for hover detection
  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const camera = cameraRef.current;

      const hovered = detectHover(sx, sy, camera.x, camera.y, agents);
      onHoverAgent(hovered);

      // Change cursor
      canvas.style.cursor = hovered ? 'pointer' : 'crosshair';
    },
    [agents, onHoverAgent],
  );

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', overflow: 'hidden' }}>
      <canvas
        ref={canvasRef}
        onClick={handleClick}
        onTouchStart={handleTouch}
        onMouseMove={handleMouseMove}
        style={{ display: 'block', width: '100%', height: '100%' }}
      />
    </div>
  );
}
