// Smart spawn selection: never next to where you died, and far from living enemies.
import { SPAWN_MIN_DIST_FROM_DEATH, SPAWN_RANDOM_TOP_N, SPOT_MIN_GAP_TILES, SPOT_MIN_PLAYER_PX } from './config';
import { type TilePos, spawnWorldPos } from './map';

export interface Point {
  x: number;
  y: number;
}

/**
 * Pick a spawn point index.
 * 1. Drop spawns within 200 px of the death position (if any) or below `maxFeetY`.
 * 2. Rank the rest by distance to the nearest living enemy, farthest first.
 * 3. Pick randomly among the top 3 using the supplied random function (ctx.random on the server).
 */
export function pickSpawn(spawns: readonly TilePos[], death: Point | null, enemies: readonly Point[], random: () => number, maxFeetY = Infinity): number {
  const candidates: { idx: number; score: number }[] = [];
  spawns.forEach((s, idx) => {
    const p = spawnWorldPos(s);
    if (p.y > maxFeetY) return; // under the rising acid
    if (death && Math.hypot(p.x - death.x, p.y - death.y) < SPAWN_MIN_DIST_FROM_DEATH) return;
    let nearest = Infinity;
    for (const e of enemies) nearest = Math.min(nearest, Math.hypot(p.x - e.x, p.y - e.y));
    candidates.push({ idx, score: nearest });
  });
  if (candidates.length === 0) return Math.floor(random() * spawns.length) % spawns.length;
  candidates.sort((a, b) => b.score - a.score);
  const top = Math.min(SPAWN_RANDOM_TOP_N, candidates.length);
  return candidates[Math.floor(random() * top) % top].idx;
}

/** Shuffle spawn indices (Fisher-Yates) so a round start puts everyone on distinct points. */
export function shuffledSpawnOrder(count: number, random: () => number): number[] {
  const order = Array.from({ length: count }, (_, i) => i);
  for (let i = count - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const t = order[i];
    order[i] = order[j];
    order[j] = t;
  }
  return order;
}

/**
 * A random spot for a pickup: spread out from the other pickups, away from living players and
 * above `maxFeetY`. With nothing that clear, any spot above the acid will do.
 */
export function pickSpot(spots: readonly TilePos[], taken: readonly TilePos[], players: readonly Point[], random: () => number, maxFeetY = Infinity): TilePos {
  const safe = spots.filter((s) => spawnWorldPos(s).y <= maxFeetY);
  const open = safe.filter((s) => {
    const p = spawnWorldPos(s);
    return taken.every((t) => Math.hypot(t.tx - s.tx, t.ty - s.ty) >= SPOT_MIN_GAP_TILES)
      && players.every((q) => Math.hypot(q.x - p.x, q.y - p.y) >= SPOT_MIN_PLAYER_PX);
  });
  const pool = open.length > 0 ? open : safe.length > 0 ? safe : spots;
  return pool[Math.floor(random() * pool.length) % pool.length];
}
