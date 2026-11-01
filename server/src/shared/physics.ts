// Small custom platformer physics, identical on client and in tests.
// Position convention: (x, y) is the centre-bottom of the hitbox (the feet).
// The hitbox spans x-12..x+12 horizontally and y-48..y vertically.
import {
  AIR_ACCEL,
  AIR_DRAG,
  FUEL_DRAIN,
  FUEL_MAX,
  FUEL_REFILL,
  FUEL_REFILL_DELAY,
  GRAVITY,
  GROUND_ACCEL,
  GROUND_FRICTION,
  HOP_FUEL,
  HOP_SPEED,
  JET_ACCEL,
  JET_DAMPING,
  JET_MAX_UP,
  MAX_FALL,
  MAX_IMPULSE_SPEED_UP,
  MAX_IMPULSE_SPEED_X,
  PLAYER_H,
  PLAYER_W,
  RUN_SPEED,
  TILE,
} from './config';
import { type GameMap, T_ONEWAY, T_SOLID, tileAt } from './map';

export interface PlayerBody {
  x: number;
  y: number;
  vx: number;
  vy: number;
  fuel: number;
  grounded: boolean;
  /** Seconds spent continuously on the ground (drives the fuel refill delay). */
  groundTime: number;
  jetting: boolean;
  /** Thrust state from the previous step, used to detect a fresh tap (hop). */
  thrustHeld: boolean;
}

export interface MoveInput {
  /** -1 left, 0 none, +1 right (touch sticks may pass fractions). */
  moveX: number;
  thrust: boolean;
  /**
   * Analog jetpack power 0..1 (touch stick: how far up you push). Omitted = full power.
   * About 0.6 hovers (JET_HOVER); less sinks slowly, more climbs.
   */
  thrustAmount?: number;
  down: boolean;
}

export interface StepOptions {
  runSpeedMul: number;
  fuelRefillMul: number;
  /** House rule: the jetpack never runs dry. */
  infiniteFuel?: boolean;
}

export const DEFAULT_STEP: StepOptions = { runSpeedMul: 1, fuelRefillMul: 1 };

export function makeBody(x: number, y: number): PlayerBody {
  return { x, y, vx: 0, vy: 0, fuel: FUEL_MAX, grounded: false, groundTime: 0, jetting: false, thrustHeld: false };
}

/** Move `v` toward `target` by at most `maxDelta`. */
function approach(v: number, target: number, maxDelta: number): number {
  if (v < target) return Math.min(v + maxDelta, target);
  if (v > target) return Math.max(v - maxDelta, target);
  return v;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

const HALF_W = PLAYER_W / 2;

/**
 * Advance one player by `dt` seconds. Mutates `b` in place (no allocations).
 * Order: horizontal control -> jetpack/gravity -> move X and collide -> move Y and collide.
 */
export function stepPlayer(map: GameMap, b: PlayerBody, input: MoveInput, dt: number, opt: StepOptions = DEFAULT_STEP): void {
  // --- Horizontal control ---
  const run = RUN_SPEED * opt.runSpeedMul;
  const dir = input.moveX > 0.2 ? 1 : input.moveX < -0.2 ? -1 : 0;
  if (dir !== 0) {
    const target = dir * run * Math.min(1, Math.abs(input.moveX) * 1.25);
    const sameDirFast = Math.sign(b.vx) === dir && Math.abs(b.vx) > Math.abs(target);
    if (!b.grounded && sameDirFast) {
      // Keep blast-jump momentum in the air: only gentle drag.
      b.vx = approach(b.vx, target, AIR_DRAG * dt);
    } else {
      b.vx = approach(b.vx, target, (b.grounded ? GROUND_ACCEL : AIR_ACCEL) * dt);
    }
  } else {
    b.vx = approach(b.vx, 0, (b.grounded ? GROUND_FRICTION : AIR_DRAG) * dt);
  }

  // --- Jetpack and gravity ---
  const tapped = input.thrust && !b.thrustHeld;
  b.thrustHeld = input.thrust;
  b.jetting = false;
  if (tapped && b.grounded && b.fuel >= HOP_FUEL) {
    // A tap on the ground is an instant hop.
    b.vy = -HOP_SPEED;
    if (!opt.infiniteFuel) b.fuel -= HOP_FUEL;
    b.grounded = false;
  } else if (input.thrust && !b.grounded && b.fuel > 0) {
    // Holding thrust in the air is flight. Power is analog (Mini Militia style): full power climbs
    // (net 1200 px/s² up), about 60 % hovers, less sinks gently. Vertical damping while the jets
    // fire settles the speed, so hovering and drifting sideways at one height are easy to hold.
    const power = Math.max(0, Math.min(1, input.thrustAmount ?? 1));
    b.jetting = true;
    b.vy -= JET_ACCEL * power * dt;
    if (b.vy < -JET_MAX_UP) b.vy = Math.min(-JET_MAX_UP, b.vy + JET_ACCEL * power * dt); // never speeds past the cap
    if (!opt.infiniteFuel) b.fuel = Math.max(0, b.fuel - FUEL_DRAIN * (0.4 + 0.6 * power) * dt);
  }
  b.vy += GRAVITY * dt;
  // Damping goes after gravity so that at hover power the net change is exactly zero.
  if (b.jetting) b.vy -= b.vy * JET_DAMPING * dt;
  if (b.vy > MAX_FALL) b.vy = MAX_FALL;
  b.vx = clamp(b.vx, -MAX_IMPULSE_SPEED_X, MAX_IMPULSE_SPEED_X);
  if (b.vy < -MAX_IMPULSE_SPEED_UP) b.vy = -MAX_IMPULSE_SPEED_UP;

  // --- Fuel refill after resting on the ground ---
  if (b.grounded) {
    b.groundTime += dt;
    if (b.groundTime >= FUEL_REFILL_DELAY) b.fuel = Math.min(FUEL_MAX, b.fuel + FUEL_REFILL * opt.fuelRefillMul * dt);
  } else {
    b.groundTime = 0;
  }

  moveX(map, b, b.vx * dt);
  moveY(map, b, b.vy * dt, input.down);
}

/**
 * Horizontal sweep against solid tiles. Speeds are capped so one step never moves more than
 * half a tile, so checking the tiles at the destination edge is enough (no tunnelling).
 */
function moveX(map: GameMap, b: PlayerBody, dx: number): void {
  if (dx === 0) return;
  const newX = b.x + dx;
  const top = b.y - PLAYER_H;
  const ty0 = Math.floor(top / TILE);
  const ty1 = Math.floor((b.y - 1e-6) / TILE);
  if (dx > 0) {
    const edge = newX + HALF_W;
    const tx = Math.floor((edge - 1e-6) / TILE);
    for (let ty = ty0; ty <= ty1; ty++) {
      if (tileAt(map, tx, ty) === T_SOLID) {
        b.x = tx * TILE - HALF_W; // flush against the wall's left face
        b.vx = 0;
        return;
      }
    }
  } else {
    const edge = newX - HALF_W;
    const tx = Math.floor(edge / TILE);
    for (let ty = ty0; ty <= ty1; ty++) {
      if (tileAt(map, tx, ty) === T_SOLID) {
        b.x = (tx + 1) * TILE + HALF_W; // flush against the wall's right face
        b.vx = 0;
        return;
      }
    }
  }
  b.x = newX;
}

/**
 * Vertical sweep. Moving up only solids block (one-way platforms are passable from below).
 * Moving down, solids always block; one-way platforms block only if the feet were at or
 * above the platform top before this step and the player is not holding "down".
 */
function moveY(map: GameMap, b: PlayerBody, dy: number, dropThrough: boolean): void {
  const tx0 = Math.floor((b.x - HALF_W) / TILE);
  const tx1 = Math.floor((b.x + HALF_W - 1e-6) / TILE);
  if (dy > 0) {
    const oldBottom = b.y;
    const newBottom = b.y + dy;
    const ty = Math.floor((newBottom - 1e-6) / TILE);
    const tileTop = ty * TILE;
    for (let tx = tx0; tx <= tx1; tx++) {
      const code = tileAt(map, tx, ty);
      const blocks =
        code === T_SOLID || (code === T_ONEWAY && !dropThrough && oldBottom <= tileTop + 1e-6);
      if (blocks && newBottom > tileTop) {
        b.y = tileTop;
        b.vy = 0;
        b.grounded = true;
        return;
      }
    }
    b.y = newBottom;
    b.grounded = false;
  } else if (dy < 0) {
    const newTop = b.y + dy - PLAYER_H;
    const ty = Math.floor(newTop / TILE);
    for (let tx = tx0; tx <= tx1; tx++) {
      if (tileAt(map, tx, ty) === T_SOLID) {
        b.y = (ty + 1) * TILE + PLAYER_H; // head against the ceiling
        b.vy = 0;
        b.grounded = false;
        return;
      }
    }
    b.y += dy;
    b.grounded = false;
  } else {
    // dy == 0 only when standing still exactly; gravity always adds some dy, so this is rare.
    b.grounded = isStandingOn(map, b.x, b.y, dropThrough);
  }
}

/** True if the feet at (x, y) rest on a solid tile or (unless dropping) a one-way platform. */
export function isStandingOn(map: GameMap, x: number, y: number, dropThrough = false): boolean {
  if (Math.abs(y / TILE - Math.round(y / TILE)) > 1e-4) return false;
  const ty = Math.round(y / TILE);
  const tx0 = Math.floor((x - HALF_W) / TILE);
  const tx1 = Math.floor((x + HALF_W - 1e-6) / TILE);
  for (let tx = tx0; tx <= tx1; tx++) {
    const code = tileAt(map, tx, ty);
    if (code === T_SOLID || (code === T_ONEWAY && !dropThrough)) return true;
  }
  return false;
}

/** Add an external impulse (recoil, knockback, lunge), respecting the speed caps. */
export function applyImpulse(b: PlayerBody, ix: number, iy: number): void {
  b.vx = clamp(b.vx + ix, -MAX_IMPULSE_SPEED_X, MAX_IMPULSE_SPEED_X);
  b.vy = clamp(b.vy + iy, -MAX_IMPULSE_SPEED_UP, MAX_FALL);
  if (iy < 0) b.grounded = false;
}

