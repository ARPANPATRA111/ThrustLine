import { describe, expect, it } from 'vitest';
import { SPAWN_MIN_DIST_FROM_DEATH, SPOT_MIN_GAP_TILES, SPOT_MIN_PLAYER_PX, TILE } from './config';
import { RIG7, spawnWorldPos } from './map';
import { pickSpawn, pickSpot, shuffledSpawnOrder } from './spawn';

describe('pickSpawn', () => {
  it('never picks a spawn within 200 px of the death point', () => {
    for (const s of RIG7.spawns) {
      const death = spawnWorldPos(s);
      for (let r = 0; r < 20; r++) {
        const idx = pickSpawn(RIG7.spawns, death, [], () => r / 20);
        const p = spawnWorldPos(RIG7.spawns[idx]);
        expect(Math.hypot(p.x - death.x, p.y - death.y)).toBeGreaterThanOrEqual(SPAWN_MIN_DIST_FROM_DEATH);
      }
    }
  });

  it('prefers spawns far from enemies', () => {
    // One enemy on the far left: the chosen spawn should always be on the right half.
    const enemy = { x: 100, y: 1150 };
    for (let r = 0; r < 20; r++) {
      const idx = pickSpawn(RIG7.spawns, null, [enemy], () => r / 20);
      expect(spawnWorldPos(RIG7.spawns[idx]).x).toBeGreaterThan(1536);
    }
  });

  it('shuffles into distinct indices', () => {
    const order = shuffledSpawnOrder(8, () => 0.42);
    expect(new Set(order).size).toBe(8);
  });
});

describe('pickSpot', () => {
  const spots = RIG7.spots;
  const seq = (seed: number) => () => (seed = (seed * 16807) % 2147483647) / 2147483647;

  it('uses many different spots over a round', () => {
    const r = seq(5);
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const s = pickSpot(spots, [], [], r);
      seen.add(`${s.tx},${s.ty}`);
    }
    expect(seen.size).toBeGreaterThan(50);
  });

  it('keeps away from other pickups and from living players', () => {
    const r = seq(9);
    const taken = [spots[0], spots[Math.floor(spots.length / 2)]];
    const player = { x: 1500, y: 800 };
    for (let i = 0; i < 200; i++) {
      const s = pickSpot(spots, taken, [player], r);
      for (const t of taken) expect(Math.hypot(t.tx - s.tx, t.ty - s.ty)).toBeGreaterThanOrEqual(SPOT_MIN_GAP_TILES);
      expect(Math.hypot((s.tx + 0.5) * TILE - player.x, (s.ty + 1) * TILE - player.y)).toBeGreaterThanOrEqual(SPOT_MIN_PLAYER_PX);
    }
  });

  it('stays above the rising acid', () => {
    const r = seq(3);
    for (let i = 0; i < 200; i++) expect((pickSpot(spots, [], [], r, 20 * TILE).ty + 1) * TILE).toBeLessThanOrEqual(20 * TILE);
  });

  it('still answers when nothing is clear', () => {
    const r = seq(4);
    expect(spots).toContainEqual(pickSpot(spots, spots, [], r));
    expect(spots).toContainEqual(pickSpot(spots, [], [], r, -1));
  });
});
