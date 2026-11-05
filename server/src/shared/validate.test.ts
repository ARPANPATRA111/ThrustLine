import { describe, expect, it } from 'vitest';
import { TILE } from './config';
import { RIG7, spawnWorldPos } from './map';
import { canSeeBody, fireRateOk, hitClaimDistance, isStaleSeq, isValidPosition, maxPelletsAt, meleeHits, shotOriginOk, validateMove } from './validate';
import { WEAPONS, W_AR, W_PISTOL, W_SHOTGUN, W_SNIPER } from './weapons';

const floorY = 35 * TILE + TILE; // ground floor top (row 36) for the lower spawns
const at = (tx: number) => ({ x: (tx + 0.5) * TILE, y: floorY });

describe('movement validation', () => {
  it('accepts legitimate movement with latency jitter', () => {
    const a = spawnWorldPos(RIG7.spawns[0]);
    expect(validateMove(RIG7, a, { x: a.x + 15, y: a.y }, 0.05)).toBe(true);
    // Packets bunched together: 50 px of movement arriving only 26 ms later.
    expect(validateMove(RIG7, a, { x: a.x + 50, y: a.y - 10 }, 0.026)).toBe(true);
  });

  it('rejects teleports', () => {
    const a = at(5);
    expect(validateMove(RIG7, a, { x: a.x + 600, y: a.y }, 0.05)).toBe(false);
  });

  it('rejects positions inside solids or outside the map', () => {
    expect(isValidPosition(RIG7, 5, 100)).toBe(false); // inside the left wall
    expect(isValidPosition(RIG7, 10 * TILE, 39 * TILE)).toBe(false); // in the floor
    expect(isValidPosition(RIG7, -50, 100)).toBe(false);
    expect(isValidPosition(RIG7, at(5).x, at(5).y)).toBe(true);
  });
});

describe('shot validation', () => {
  const pistol = WEAPONS[W_PISTOL];
  const sniper = WEAPONS[W_SNIPER];

  it('accepts a clear shot along the ray', () => {
    const shooter = at(5);
    const target = at(15);
    const ox = shooter.x;
    const oy = shooter.y - 24;
    expect(shotOriginOk(shooter, ox, oy)).toBe(true);
    expect(hitClaimDistance(RIG7, pistol, ox, oy, 0, target)).toBeGreaterThan(0);
  });

  it('tolerates a slightly off ray (latency)', () => {
    const shooter = at(5);
    const target = at(15);
    expect(hitClaimDistance(RIG7, pistol, shooter.x, shooter.y - 24, 0.08, target)).toBeGreaterThan(0);
  });

  it('rejects shots through walls', () => {
    // The low wall at columns 20-21 separates these two positions.
    const shooter = at(17);
    const target = at(24);
    expect(hitClaimDistance(RIG7, sniper, shooter.x, shooter.y - 24, 0, target)).toBe(-1);
  });

  it('hits a player peeking over a low wall', () => {
    // Standing on top of the low wall at columns 20-21 only the legs would be hidden from below;
    // a shooter level with the head sees head and chest even though the feet are blocked.
    const target = { x: 20 * TILE + 8, y: 33 * TILE };
    expect(canSeeBody(RIG7, 17 * TILE, target.y - 40, target)).toBe(true);
  });

  it('caps shotgun pellets by how much of the cone a body fills', () => {
    const shotgun = WEAPONS[W_SHOTGUN];
    expect(maxPelletsAt(shotgun, 60)).toBe(shotgun.pellets);
    expect(maxPelletsAt(shotgun, 200)).toBeLessThan(shotgun.pellets);
    expect(maxPelletsAt(shotgun, 460)).toBeLessThanOrEqual(6);
    expect(maxPelletsAt(WEAPONS[W_SNIPER], 2000)).toBe(1);
  });

  it('rejects out-of-range hits', () => {
    const shooter = { x: 25 * TILE, y: 29 * TILE };
    const target = { x: 25 * TILE + 1100, y: 29 * TILE };
    expect(hitClaimDistance(RIG7, pistol, shooter.x, shooter.y - 24, 0, target)).toBe(-1);
  });

  it('rejects a ray pointing away from the target', () => {
    const shooter = at(5);
    const target = at(15);
    expect(hitClaimDistance(RIG7, pistol, shooter.x, shooter.y - 24, Math.PI / 2, target)).toBe(-1);
  });

  it('rejects an origin far from the shooter', () => {
    expect(shotOriginOk(at(5), at(5).x + 200, at(5).y - 24)).toBe(false);
  });

  it('rejects fire faster than the weapon rate', () => {
    const ar = WEAPONS[W_AR]; // 10/s -> min gap 85 ms
    expect(fireRateOk(1_000_000n, 1_050_000n, ar.rate)).toBe(false);
    expect(fireRateOk(1_000_000n, 1_090_000n, ar.rate)).toBe(true);
    expect(fireRateOk(0n, 5n, ar.rate)).toBe(true);
  });
});

describe('packet sequencing', () => {
  it('accepts only newer sync packets', () => {
    expect(isStaleSeq(1, 0)).toBe(false); // first packet of a life
    expect(isStaleSeq(8, 7)).toBe(false);
    expect(isStaleSeq(7, 7)).toBe(true); // replayed
    expect(isStaleSeq(6, 7)).toBe(true); // arrived late
  });

  it('keeps working when the 32-bit counter wraps', () => {
    expect(isStaleSeq(0, 0xffffffff)).toBe(false); // wrapped around to zero
    expect(isStaleSeq(1, 0)).toBe(false); // zero is also the "no packet yet" sentinel
  });
});

describe('melee validation', () => {
  it('hits a close target in front and misses behind', () => {
    const a = at(5);
    const t = { x: a.x + 40, y: a.y };
    expect(meleeHits(RIG7, a, 0, t)).toBe(true);
    expect(meleeHits(RIG7, a, Math.PI, t)).toBe(false);
    expect(meleeHits(RIG7, a, 0, { x: a.x + 120, y: a.y })).toBe(false);
  });
});
