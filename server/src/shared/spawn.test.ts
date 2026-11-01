import { describe, expect, it } from 'vitest';
import { SPAWN_MIN_DIST_FROM_DEATH } from './config';
import { RIG7, spawnWorldPos } from './map';
import { pickSpawn, shuffledSpawnOrder } from './spawn';

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
