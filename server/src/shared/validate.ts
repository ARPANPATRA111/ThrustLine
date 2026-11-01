// Validation helpers used by the server's `sync` reducer (and unit-tested directly).
// Philosophy: each client owns its own movement, the server is the referee. Checks are
// tolerant enough for real latency ("favour the shooter") but stop teleports, wall-hacks,
// rapid fire and out-of-range hits.
import {
  FIRE_RATE_TOLERANCE,
  MELEE_SERVER_ARC_DEG,
  MELEE_SERVER_RANGE,
  MOVE_CHECK_EXTRA_PX,
  MOVE_CHECK_SLACK,
  MOVE_CHECK_SPEED,
  PLAYER_H,
  PLAYER_W,
  SHOT_ORIGIN_TOLERANCE,
  SHOT_RANGE_TOLERANCE,
  SHOT_RAY_TOLERANCE,
  SOLID_OVERLAP_EPS,
} from './config';
import { type GameMap, MAP_H, MAP_W, T_SOLID, boxTouchesTile } from './map';
import { lineOfSight, pointToRayDistance } from './raycast';
import type { WeaponDef } from './weapons';

export interface Pos {
  x: number;
  y: number;
}

/** Is (x, y) a legal place to stand: inside the map and not overlapping a solid tile? */
export function isValidPosition(map: GameMap, x: number, y: number): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const e = SOLID_OVERLAP_EPS;
  const left = x - PLAYER_W / 2;
  const top = y - PLAYER_H;
  if (left < 0 || top < 0 || x + PLAYER_W / 2 > MAP_W || y > MAP_H) return false;
  return !boxTouchesTile(map, left + e, top + e, x + PLAYER_W / 2 - e, y - e, T_SOLID);
}

/** Maximum distance a player may legally move in `dtSec` (with slack for jitter). */
export function maxMoveDistance(dtSec: number): number {
  return MOVE_CHECK_SPEED * dtSec * MOVE_CHECK_SLACK + MOVE_CHECK_EXTRA_PX;
}

/** Movement check: inside the map, not in a wall, and not farther than physically possible. */
export function validateMove(map: GameMap, from: Pos, to: Pos, dtSec: number): boolean {
  if (!isValidPosition(map, to.x, to.y)) return false;
  return Math.hypot(to.x - from.x, to.y - from.y) <= maxMoveDistance(dtSec);
}

/** Fire-rate check: at least 0.85 / rate seconds since the last shot of that weapon. */
export function fireRateOk(lastFireMicros: bigint, nowMicros: bigint, rate: number): boolean {
  if (lastFireMicros === 0n) return true;
  const minGapMicros = BigInt(Math.floor((FIRE_RATE_TOLERANCE / rate) * 1e6));
  return nowMicros - lastFireMicros >= minGapMicros;
}

/** The shot origin must be near the shooter's centre on the server. */
export function shotOriginOk(shooter: Pos, ox: number, oy: number): boolean {
  return Math.hypot(ox - shooter.x, oy - (shooter.y - PLAYER_H / 2)) <= SHOT_ORIGIN_TOLERANCE;
}

const HALF_DIAGONAL = Math.hypot(PLAYER_W, PLAYER_H) / 2;

/**
 * Check a single hit claim against one candidate position of the target (its current or
 * previous server position). Returns the distance from the shot origin if valid, else -1.
 *   - within weapon range + 64 px
 *   - a clear tile raycast from the origin to the target's centre
 *   - the claimed ray passes within half-diagonal + 40 px of the target's centre
 */
export function hitClaimDistance(
  map: GameMap,
  w: WeaponDef,
  ox: number,
  oy: number,
  angle: number,
  target: Pos,
): number {
  const cx = target.x;
  const cy = target.y - PLAYER_H / 2;
  const d = Math.hypot(cx - ox, cy - oy);
  if (d > w.range + SHOT_RANGE_TOLERANCE) return -1;
  if (!lineOfSight(map, ox, oy, cx, cy)) return -1;
  const dist = pointToRayDistance(ox, oy, Math.cos(angle), Math.sin(angle), cx, cy);
  if (dist > HALF_DIAGONAL + SHOT_RAY_TOLERANCE) return -1;
  return d;
}

/** Smallest absolute difference between two angles, in radians. */
export function angleDiff(a: number, b: number): number {
  let d = (a - b) % (Math.PI * 2);
  if (d < -Math.PI) d += Math.PI * 2;
  if (d > Math.PI) d -= Math.PI * 2;
  return Math.abs(d);
}

/**
 * Melee check, done entirely by the server: target centre within 72 px of the attacker's
 * centre, within +-70 degrees of the swing angle, with a clear line between them.
 */
export function meleeHits(map: GameMap, attacker: Pos, angle: number, target: Pos): boolean {
  const ax = attacker.x;
  const ay = attacker.y - PLAYER_H / 2;
  const tx = target.x;
  const ty = target.y - PLAYER_H / 2;
  const d = Math.hypot(tx - ax, ty - ay);
  if (d > MELEE_SERVER_RANGE) return false;
  if (d > 8 && angleDiff(Math.atan2(ty - ay, tx - ax), angle) > (MELEE_SERVER_ARC_DEG * Math.PI) / 180) return false;
  return lineOfSight(map, ax, ay, tx, ty);
}
