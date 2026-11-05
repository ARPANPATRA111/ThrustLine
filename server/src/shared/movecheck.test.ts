// The movement budget must never reject honest physics, and must catch what the old flat speed
// limit let through. Honest play is fuzzed through the real simulation with sampling jitter.
import { describe, expect, it } from 'vitest';
import { GRENADE_KNOCKBACK, KNIFE_LUNGE, RUN_SPEED, TILE } from './config';
import { RIG7, spawnWorldPos } from './map';
import { type MoveInput, applyImpulse, makeBody, stepPlayer } from './physics';
import { addBoost, freshMoveCredit, isPathClear, spendMove, validateMove } from './validate';

const SIM_DT = 1 / 60;
const SYNC_STEPS = 3; // 20 Hz

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

/** Play `seconds` of random input through the shared physics; returns rejected syncs. */
function honestRun(seed: number, seconds: number, runMul = 1): number {
  const rand = rng(seed);
  const spawn = spawnWorldPos(RIG7.spawns[seed % RIG7.spawns.length]);
  const b = makeBody(spawn.x, spawn.y);
  const input: MoveInput = { moveX: 0, thrust: false, thrustAmount: 1, down: false };
  const credit = freshMoveCredit();
  let last = { x: b.x, y: b.y };
  let pendingBoost = 0;
  let rejected = 0;
  const steps = Math.floor(seconds / SIM_DT);
  for (let i = 0; i < steps; i++) {
    if (i % 24 === 0) {
      input.moveX = [-1, 0, 1, 1, -1][Math.floor(rand() * 5)];
      input.thrust = rand() < 0.55;
      input.thrustAmount = 0.4 + rand() * 0.6;
      input.down = rand() < 0.1;
    }
    if (rand() < 0.012) { // shotgun recoil
      const a = rand() * Math.PI * 2;
      applyImpulse(b, Math.cos(a) * 540, Math.sin(a) * 540);
      pendingBoost += 540;
    }
    if (rand() < 0.01) { // knife lunge
      const a = rand() * Math.PI * 2;
      applyImpulse(b, Math.cos(a) * KNIFE_LUNGE, Math.sin(a) * KNIFE_LUNGE * 0.5);
      pendingBoost += KNIFE_LUNGE;
    }
    if (rand() < 0.004) { // blast
      const a = rand() * Math.PI * 2;
      applyImpulse(b, Math.cos(a) * GRENADE_KNOCKBACK, Math.sin(a) * GRENADE_KNOCKBACK - GRENADE_KNOCKBACK * 0.25);
      pendingBoost += GRENADE_KNOCKBACK * 1.25;
    }
    stepPlayer(RIG7, b, input, SIM_DT, { runSpeedMul: runMul, fuelRefillMul: 1, infiniteFuel: true });
    if (i % SYNC_STEPS === SYNC_STEPS - 1) {
      // Timestamps wobble: the measured gap is not exactly 50 ms even though the steps are.
      const dt = SYNC_STEPS * SIM_DT + (rand() - 0.5) * 0.02;
      addBoost(credit, pendingBoost);
      pendingBoost = 0;
      const to = { x: b.x, y: b.y };
      if (!validateMove(RIG7, last, to, dt) || !spendMove(credit, to.x - last.x, to.y - last.y, dt, runMul)) rejected++;
      last = to;
    }
  }
  return rejected;
}

describe('movement budget', () => {
  it('never rejects honest physics, including recoil, lunges and blasts', () => {
    for (let seed = 1; seed <= 40; seed++) expect(honestRun(seed, 30), `seed ${seed}`).toBe(0);
  });

  it('accounts for the faster Blades run speed', () => {
    for (let seed = 1; seed <= 10; seed++) expect(honestRun(seed, 20, 1.15), `seed ${seed}`).toBe(0);
  });

  it('catches a sustained speed hack the flat limit allowed', () => {
    const credit = freshMoveCredit();
    const px = 700 * 0.05; // 700 px/s: far under the old 1400 px/s limit, 2.7× run speed
    let caught = false;
    for (let i = 0; i < 20 && !caught; i++) caught = !spendMove(credit, px, 0, 0.05, 1);
    expect(caught, 'caught within one second').toBe(true);
  });

  it('holds a cheater to legal speed however long they keep trying', () => {
    const credit = freshMoveCredit();
    let moved = 0;
    for (let i = 0; i < 200; i++) if (spendMove(credit, 30, 0, 0.05, 1)) moved += 30;
    expect(moved / 10).toBeLessThan(RUN_SPEED * 1.25); // 10 s at 600 px/s attempted
  });

  it('stops vertical fly hacks too', () => {
    const credit = freshMoveCredit();
    let caught = false;
    for (let i = 0; i < 20 && !caught; i++) caught = !spendMove(credit, 0, -60, 0.05, 1); // 1200 px/s up
    expect(caught).toBe(true);
  });

  it('allows blast speed only after a real impulse, and the allowance fades', () => {
    const pushed = freshMoveCredit();
    addBoost(pushed, GRENADE_KNOCKBACK);
    for (let i = 0; i < 8; i++) expect(spendMove(pushed, 40, 0, 0.05, 1), `step ${i}`).toBe(true);
    const later = { ...pushed };
    for (let i = 0; i < 80; i++) spendMove(later, 0, 0, 0.05, 1);
    expect(later.boost).toBe(0);
  });

  it('recovers immediately after a rejected step', () => {
    const credit = freshMoveCredit();
    expect(spendMove(credit, 500, 0, 0.05, 1)).toBe(false);
    expect(spendMove(credit, 10, 0, 0.05, 1)).toBe(true);
  });
});

describe('wall sweep', () => {
  it('rejects a step through a one-tile floor', () => {
    // The floor at row 28 spans columns 1-12; start above it, end below it.
    const x = 6 * TILE + TILE / 2;
    const above = { x, y: 28 * TILE };
    const below = { x, y: 29 * TILE + 48 };
    expect(isPathClear(RIG7, above, below)).toBe(false);
    expect(validateMove(RIG7, above, below, 0.05)).toBe(false);
  });

  it('rejects a step through a wall even when the distance is legal', () => {
    const left = { x: 19 * TILE + 8, y: 36 * TILE };
    const right = { x: 22 * TILE + 24, y: 36 * TILE };
    expect(isPathClear(RIG7, left, right)).toBe(false);
  });

  it('accepts cutting past a corner in open air', () => {
    // Up and over the low wall at columns 20-21 (rows 33-35): the straight line is clipped,
    // but one of the two L-shaped routes is open.
    const a = { x: 19 * TILE, y: 33 * TILE - 2 };
    const b = { x: 20 * TILE + 8, y: 33 * TILE - 30 };
    expect(isPathClear(RIG7, a, b)).toBe(true);
  });
});
