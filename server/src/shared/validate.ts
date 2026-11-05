// Validation helpers used by the server's `sync` reducer (and unit-tested directly).
// Philosophy: each client owns its own movement, the server is the referee. Checks are
// tolerant enough for real latency ("favour the shooter") but stop teleports, wall-hacks,
// rapid fire and out-of-range hits.
import {
  AIR_DRAG,
  EMP_RISE_PX,
  FIRE_RATE_TOLERANCE,
  HOP_SPEED,
  MAX_FALL,
  MAX_IMPULSE_SPEED_UP,
  MAX_IMPULSE_SPEED_X,
  MELEE_SERVER_ARC_DEG,
  MELEE_SERVER_RANGE,
  MOVE_BUDGET_PX,
  MOVE_CHECK_EXTRA_PX,
  MOVE_CHECK_SLACK,
  MOVE_CHECK_SPEED,
  MOVE_SPEED_SLACK,
  PELLET_TOLERANCE,
  PLAYER_H,
  PLAYER_W,
  RUN_SPEED,
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

/**
 * Did the body travel through open space? A straight line between two body centres can clip a
 * corner the physics walked around (it moves X and Y separately), so either L-shaped route also
 * counts. A wall or floor between the two points blocks all three.
 */
export function isPathClear(map: GameMap, from: Pos, to: Pos): boolean {
  const ay = from.y - PLAYER_H / 2;
  const by = to.y - PLAYER_H / 2;
  if (lineOfSight(map, from.x, ay, to.x, by)) return true;
  return (lineOfSight(map, from.x, ay, to.x, ay) && lineOfSight(map, to.x, ay, to.x, by))
    || (lineOfSight(map, from.x, ay, from.x, by) && lineOfSight(map, from.x, by, to.x, by));
}

/** Movement check: inside the map, not through a wall, and not farther than physically possible. */
export function validateMove(map: GameMap, from: Pos, to: Pos, dtSec: number): boolean {
  if (!isValidPosition(map, to.x, to.y)) return false;
  if (Math.hypot(to.x - from.x, to.y - from.y) > maxMoveDistance(dtSec)) return false;
  return isPathClear(map, from, to);
}

/**
 * The server's model of how fast a player can really be moving. `validateMove` alone would let
 * any client move at grenade-blast speed all the time; this holds them to run and jet speed
 * unless something actually pushed them (`boost`, in px/s, decays like air drag).
 */
export interface MoveCredit {
  x: number;
  up: number;
  boost: number;
}

export function freshMoveCredit(): MoveCredit {
  return { x: MOVE_BUDGET_PX, up: MOVE_BUDGET_PX, boost: 0 };
}

/** An impulse (recoil, lunge, blast) lets the player go this much faster, up to the speed caps. */
export function addBoost(c: MoveCredit, impulse: number): void {
  c.boost = Math.min(Math.max(MAX_IMPULSE_SPEED_X, MAX_IMPULSE_SPEED_UP), c.boost + impulse);
}

/**
 * Spend movement credit for a step of (dx, dy) over `dtSec`. Returns false if the step is faster
 * than physics allows; credit is refilled but not spent, so an honest client recovers at once.
 */
export function spendMove(c: MoveCredit, dx: number, dy: number, dtSec: number, runMul: number): boolean {
  const vx = Math.min(RUN_SPEED * runMul + c.boost, MAX_IMPULSE_SPEED_X) * MOVE_SPEED_SLACK;
  const vUp = Math.min(HOP_SPEED + c.boost, MAX_IMPULSE_SPEED_UP) * MOVE_SPEED_SLACK;
  c.x = Math.min(MOVE_BUDGET_PX, c.x + vx * dtSec);
  c.up = Math.min(MOVE_BUDGET_PX, c.up + vUp * dtSec);
  c.boost = Math.max(0, c.boost - AIR_DRAG * dtSec);
  const needX = Math.abs(dx);
  const needUp = Math.max(0, -dy);
  if (needX > c.x || needUp > c.up) return false;
  if (dy > MAX_FALL * MOVE_SPEED_SLACK * dtSec + MOVE_BUDGET_PX) return false;
  c.x -= needX;
  c.up -= needUp;
  return true;
}

/** Fire-rate check: at least 0.85 / rate seconds since the last shot of that weapon. */
export function fireRateOk(lastFireMicros: bigint, nowMicros: bigint, rate: number): boolean {
  if (lastFireMicros === 0n) return true;
  const minGapMicros = BigInt(Math.floor((FIRE_RATE_TOLERANCE / rate) * 1e6));
  return nowMicros - lastFireMicros >= minGapMicros;
}

/**
 * Packet replay check: each sync must carry a strictly newer `seq` than the last accepted one.
 * `last === 0` means the server has not accepted a packet for this life yet (a fresh page or a
 * reconnect), so anything is allowed. The subtraction is signed so it still works when the
 * 32-bit counter wraps after ~6 years of play.
 */
export function isStaleSeq(next: number, last: number): boolean {
  if (last === 0) return false;
  return ((next - last) | 0) <= 0;
}

/** The shot origin must be near the shooter's centre on the server. */
export function shotOriginOk(shooter: Pos, ox: number, oy: number): boolean {
  return Math.hypot(ox - shooter.x, oy - (shooter.y - PLAYER_H / 2)) <= SHOT_ORIGIN_TOLERANCE;
}

const HALF_DIAGONAL = Math.hypot(PLAYER_W, PLAYER_H) / 2;
/** Heights above the feet that count as an exposed body: shins, chest, head. */
const BODY_POINTS = [8, PLAYER_H / 2, PLAYER_H - 8];

/** Can a shot from (ox, oy) reach any part of the body? Someone peeking over a low wall is hittable. */
export function canSeeBody(map: GameMap, ox: number, oy: number, target: Pos): boolean {
  return BODY_POINTS.some((h) => lineOfSight(map, ox, oy, target.x, target.y - h));
}

/**
 * Most pellets of a spread weapon that can land on one body at distance `d`: the share of the
 * cone the body fills, plus a small tolerance. A hit claim cannot report more than this.
 */
export function maxPelletsAt(w: WeaponDef, d: number): number {
  if (w.pellets <= 1) return w.pellets;
  const spread = (Math.max(w.spreadStill, w.spreadMoving) * Math.PI) / 180;
  const share = Math.min(1, Math.atan2(HALF_DIAGONAL, Math.max(1, d)) / Math.max(spread, 1e-3));
  return Math.min(w.pellets, Math.ceil(w.pellets * share) + PELLET_TOLERANCE);
}

/**
 * Check a single hit claim against one candidate position of the target (its current or
 * previous server position). Returns the distance from the shot origin if valid, else -1.
 *   - within weapon range + 64 px
 *   - a clear tile raycast from the origin to some part of the target's body
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
  if (!canSeeBody(map, ox, oy, target)) return -1;
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

/**
 * With the jetpack dead a player can only rise as far as a jump carries them. Returns how much rise
 * is left after moving `dy` (negative is up); standing on something refills it. Below zero means
 * the move took more lift than a jump has, which only a client ignoring the EMP can do.
 */
export function spendRise(left: number, dy: number, standing: boolean): number {
  if (standing) return EMP_RISE_PX;
  return dy < 0 ? left + dy : left;
}
