// Deterministic grenade flight. Server and client run this exact code on the same stored
// start values (x0, y0, vx0, vy0 as f32), so the grenade explodes exactly where it was drawn.
// Determinism rules: fixed 120 Hz steps, only + - * / and comparisons (no trig, no randomness).
import {
  GRAVITY,
  GRENADE_FRICTION,
  GRENADE_RADIUS,
  GRENADE_RESTITUTION,
  GRENADE_TICK_HZ,
  MAX_FALL,
  TILE,
} from './config';
import { type GameMap, T_ONEWAY, T_SOLID, tileAt } from './map';

export interface GrenadeState {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

const DT = 1 / GRENADE_TICK_HZ;
const R = GRENADE_RADIUS;
/** Below this bounce speed the grenade stops bouncing and rests. */
const REST_SPEED = 40;
/** Rolling friction per second while resting on a floor. */
const ROLL_DECEL = 500;

function solidAt(map: GameMap, x: number, y: number): boolean {
  return tileAt(map, Math.floor(x / TILE), Math.floor(y / TILE)) === T_SOLID;
}

/** Does the grenade's square (side 2R) centred at (x, y) overlap a solid tile? */
function boxSolid(map: GameMap, x: number, y: number): boolean {
  return (
    solidAt(map, x - R, y - R) ||
    solidAt(map, x + R - 1e-6, y - R) ||
    solidAt(map, x - R, y + R - 1e-6) ||
    solidAt(map, x + R - 1e-6, y + R - 1e-6)
  );
}

/** Does the grenade land on a one-way platform when moving from oldBottom to newBottom? */
function landsOnOneWay(map: GameMap, x: number, oldBottom: number, newBottom: number): number {
  const ty = Math.floor((newBottom - 1e-6) / TILE);
  const top = ty * TILE;
  if (oldBottom > top + 1e-6 || newBottom <= top) return -1;
  const a = tileAt(map, Math.floor((x - R) / TILE), ty);
  const b = tileAt(map, Math.floor((x + R - 1e-6) / TILE), ty);
  return a === T_ONEWAY || b === T_ONEWAY ? top : -1;
}

/** Advance one fixed 120 Hz step. Mutates `g`. */
export function stepGrenade(map: GameMap, g: GrenadeState): void {
  g.vy += GRAVITY * DT;
  if (g.vy > MAX_FALL) g.vy = MAX_FALL;

  // X axis: move, and on hitting a wall reflect with restitution.
  const nx = g.x + g.vx * DT;
  if (boxSolid(map, nx, g.y)) {
    g.vx = -g.vx * GRENADE_RESTITUTION;
    g.vy = g.vy * GRENADE_FRICTION;
  } else {
    g.x = nx;
  }

  // Y axis: move; floors and ceilings reflect. Floors also apply friction to vx.
  const ny = g.y + g.vy * DT;
  let floorTop = -1;
  if (g.vy > 0) floorTop = landsOnOneWay(map, g.x, g.y + R, ny + R);
  if (boxSolid(map, g.x, ny) || floorTop >= 0) {
    if (g.vy > 0) {
      // Snap onto the surface so the grenade never rests inside a tile.
      if (floorTop >= 0) {
        g.y = floorTop - R;
      } else {
        g.y = Math.floor((ny + R) / TILE) * TILE - R;
        if (boxSolid(map, g.x, g.y)) g.y = ny - g.vy * DT; // fallback: stay where we were
      }
      g.vx = g.vx * GRENADE_FRICTION;
      g.vy = g.vy > REST_SPEED ? -g.vy * GRENADE_RESTITUTION : 0;
      if (g.vy === 0) {
        // Resting: roll to a stop.
        if (g.vx > 0) g.vx = Math.max(0, g.vx - ROLL_DECEL * DT);
        else g.vx = Math.min(0, g.vx + ROLL_DECEL * DT);
      }
    } else {
      g.vy = -g.vy * GRENADE_RESTITUTION;
    }
  } else {
    g.y = ny;
  }
}

/**
 * Simulate from the stored start state for `ticks` fixed steps and write the result into `out`.
 * The server uses ticks = fuse * 120 Hz; the client uses ticks elapsed since the throw.
 */
export function simulateGrenade(
  map: GameMap,
  x0: number,
  y0: number,
  vx0: number,
  vy0: number,
  ticks: number,
  out: GrenadeState,
): GrenadeState {
  out.x = x0;
  out.y = y0;
  out.vx = vx0;
  out.vy = vy0;
  for (let i = 0; i < ticks; i++) stepGrenade(map, out);
  return out;
}

/** Number of fixed ticks for a fuse in milliseconds. */
export function fuseTicks(fuseMs: number): number {
  return Math.round((fuseMs * GRENADE_TICK_HZ) / 1000);
}

/**
 * Pre-compute the whole flight as [x0,y0,x1,y1,...] so the client can draw each frame with a
 * lookup instead of re-simulating (no per-frame work or allocation).
 */
export function grenadePath(map: GameMap, x0: number, y0: number, vx0: number, vy0: number, ticks: number): Float32Array {
  const path = new Float32Array((ticks + 1) * 2);
  const g: GrenadeState = { x: x0, y: y0, vx: vx0, vy: vy0 };
  path[0] = g.x;
  path[1] = g.y;
  for (let i = 1; i <= ticks; i++) {
    stepGrenade(map, g);
    path[i * 2] = g.x;
    path[i * 2 + 1] = g.y;
  }
  return path;
}
