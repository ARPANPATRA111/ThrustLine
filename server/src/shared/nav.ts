// Route finding for CPU players. A jetpack can reach any open tile, so a route is a breadth-first
// walk over the tiles a body fits through, kept away from the acid. Each goal gets one distance
// field, shared by every bot heading there, so the cost stays flat however many bots are playing.
import { PLAYER_H, PLAYER_W, TILE } from './config';
import { type GameMap, T_ACID, T_ONEWAY, T_SOLID, tileAt } from './map';

/** Does a body fit with its feet in this tile? It stands two tiles tall. */
function fits(map: GameMap, tx: number, ty: number): boolean {
  if (tx < 0 || ty < 1 || tx >= map.cols || ty >= map.rows) return false;
  const code = tileAt(map, tx, ty);
  return code !== T_SOLID && code !== T_ACID && tileAt(map, tx, ty - 1) !== T_SOLID;
}

const NEIGHBOURS: readonly (readonly [number, number])[] = [[1, 0], [-1, 0], [0, -1], [0, 1]];

/** Tiles from every open tile to the goal; -1 where the goal cannot be reached. */
export function flowField(map: GameMap, goalTx: number, goalTy: number): Int16Array {
  const field = new Int16Array(map.cols * map.rows).fill(-1);
  // A goal inside a wall or the acid (a flag resting on the edge of a pit) starts from just above.
  let sy = goalTy;
  while (sy > 1 && !fits(map, goalTx, sy)) sy--;
  if (!fits(map, goalTx, sy)) return field;
  const queue = new Int32Array(map.cols * map.rows);
  let head = 0;
  let tail = 0;
  queue[tail++] = sy * map.cols + goalTx;
  field[queue[0]] = 0;
  while (head < tail) {
    const at = queue[head++];
    const ty = Math.floor(at / map.cols);
    const tx = at - ty * map.cols;
    for (const [dx, dy] of NEIGHBOURS) {
      const nx = tx + dx;
      const ny = ty + dy;
      if (!fits(map, nx, ny)) continue;
      const i = ny * map.cols + nx;
      if (field[i] !== -1) continue;
      field[i] = field[at] + 1;
      queue[tail++] = i;
    }
  }
  return field;
}

const CACHE_SIZE = 24;
const cache = new Map<GameMap, Map<number, Int16Array>>();

/** Fields are remembered per map and goal, oldest dropped first. */
function fieldFor(map: GameMap, gx: number, gy: number): Int16Array {
  let forMap = cache.get(map);
  if (!forMap) cache.set(map, (forMap = new Map()));
  const key = gy * map.cols + gx;
  let f = forMap.get(key);
  if (!f) {
    f = flowField(map, gx, gy);
    if (forMap.size >= CACHE_SIZE) forMap.delete(forMap.keys().next().value as number);
    forMap.set(key, f);
  }
  return f;
}

export interface Steer {
  /** -1, 0 or 1. */
  moveX: number;
  /** The route climbs: fire the jetpack. */
  up: boolean;
  /** The route drops: hold down to fall through a platform. */
  down: boolean;
  /** The route runs level through open air: hold height. */
  hover: boolean;
}

/** How far ahead along the route to look, so a turn starts before the corner. */
const LOOKAHEAD = 3;
/** Floor this close below a level route means walking, not hovering. */
const HOVER_DROP_TILES = 3;

/** Which way to go from a body at (x, feetY) to reach (gx, gy). */
export function steer(map: GameMap, x: number, feetY: number, gx: number, gy: number): Steer {
  const tx = Math.floor(x / TILE);
  const ty = Math.floor((feetY - 1) / TILE);
  const field = fieldFor(map, Math.floor(gx / TILE), Math.floor((gy - 1) / TILE));
  let cx = tx;
  let cy = ty;
  for (let step = 0; step < LOOKAHEAD; step++) {
    const here = field[cy * map.cols + cx];
    let best = here === -1 ? 32767 : here;
    let bx = cx;
    let by = cy;
    for (const [dx, dy] of NEIGHBOURS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= map.cols || ny >= map.rows) continue;
      const d = field[ny * map.cols + nx];
      if (d !== -1 && d < best) {
        best = d;
        bx = nx;
        by = ny;
      }
    }
    if (bx === cx && by === cy) break;
    cx = bx;
    cy = by;
  }
  // Nothing routed (already there, or walled in): head straight for it.
  if (cx === tx && cy === ty) {
    return { moveX: Math.abs(gx - x) > 20 ? Math.sign(gx - x) : 0, up: gy < feetY - 40, down: gy > feetY + 60, hover: false };
  }
  // Aim for the middle of the tile ahead. A body overhanging a ledge or a hatch would otherwise sit
  // on its edge for ever, with the route pointing straight down past it.
  const middle = (cx + 0.5) * TILE;
  const moveX = Math.abs(middle - x) > 3 ? Math.sign(middle - x) : 0;
  const lift = cy - ty;
  const step: Steer = { moveX, up: lift < 0, down: lift > 0, hover: lift === 0 && !floorClose(map, cx, cy) };
  // A body can span three tiles in the air, so a level route can still catch the head or the feet.
  if (moveX !== 0) {
    const ahead = Math.floor((x + moveX * (PLAYER_W / 2 + 3)) / TILE);
    if (tileAt(map, ahead, Math.floor((feetY - PLAYER_H) / TILE)) === T_SOLID) {
      step.up = false;
      step.hover = false;
    } else if (tileAt(map, ahead, Math.floor((feetY - 1) / TILE)) === T_SOLID) {
      step.up = true;
    }
  }
  return step;
}

/** Is there something to walk on just below this tile? If so a bot walks instead of hovering. */
function floorClose(map: GameMap, tx: number, ty: number): boolean {
  for (let i = 1; i <= HOVER_DROP_TILES; i++) {
    const code = tileAt(map, tx, ty + i);
    if (code === T_SOLID || code === T_ONEWAY) return true;
  }
  return false;
}
