import { describe, expect, it } from 'vitest';
import { FUEL_MAX, JET_HOVER, TILE } from './config';
import { MAP_H, MAP_W, RIG7, parseMap } from './map';
import { MoveInput, makeBody, stepPlayer } from './physics';
import { isValidPosition } from './validate';

const DT = 1 / 60;
const idle: MoveInput = { moveX: 0, thrust: false, down: false };

function run(map = RIG7, body = makeBody(0, 0), input: MoveInput = idle, steps = 60) {
  for (let i = 0; i < steps; i++) stepPlayer(map, body, input, DT);
  return body;
}

// A tiny test map: floor at row 6, one-way platform at row 3, wall on the right.
const TEST = parseMap(
  [
    '##########',
    '#........#',
    '#........#',
    '#..====..#',
    '#.......##',
    '#.......##',
    '##########',
  ],
  10,
);

describe('stepPlayer', () => {
  it('falls and lands on the floor', () => {
    const b = run(TEST, makeBody(2 * TILE, 2 * TILE), idle, 120);
    expect(b.grounded).toBe(true);
    expect(b.y).toBe(6 * TILE);
    expect(b.vy).toBe(0);
  });

  it('is stopped by walls', () => {
    const b = makeBody(6 * TILE, 6 * TILE);
    run(TEST, b, { moveX: 1, thrust: false, down: false }, 120);
    // Wall tiles start at column 8 on rows 4-5.
    expect(b.x + 12).toBeLessThanOrEqual(8 * TILE);
    expect(b.x + 12).toBeCloseTo(8 * TILE, 5);
  });

  it('passes up through a one-way platform and lands on it', () => {
    const b = makeBody(4 * TILE, 6 * TILE);
    b.grounded = true;
    // Fly up past the platform at row 3 (top = 96).
    for (let i = 0; i < 40 && b.y > 3 * TILE - 2; i++) stepPlayer(TEST, b, { moveX: 0, thrust: true, down: false }, DT);
    expect(b.y).toBeLessThan(3 * TILE);
    run(TEST, b, idle, 120);
    expect(b.grounded).toBe(true);
    expect(b.y).toBe(3 * TILE);
  });

  it('drops through a one-way platform when holding down', () => {
    const b = makeBody(4 * TILE, 3 * TILE);
    run(TEST, b, idle, 5);
    expect(b.y).toBe(3 * TILE);
    run(TEST, b, { moveX: 0, thrust: false, down: true }, 60);
    expect(b.y).toBe(6 * TILE);
  });

  it('drains fuel while flying and refills on the ground', () => {
    const b = run(RIG7, makeBody(48 * TILE, 30 * TILE), idle, 60);
    expect(b.grounded).toBe(true);
    run(RIG7, b, { moveX: 0, thrust: true, down: false }, 60);
    expect(b.fuel).toBeLessThan(FUEL_MAX - 30);
    run(RIG7, b, idle, 300);
    expect(b.fuel).toBe(FUEL_MAX);
  });

  it('hovers with ~60 % analog thrust, even while flying sideways', () => {
    const b = makeBody(20 * TILE, 12 * TILE); // open air in RIG-7
    b.vy = 0;
    const hover: MoveInput = { moveX: 0, thrust: true, thrustAmount: JET_HOVER, down: false };
    run(RIG7, b, hover, 30); // settle
    const y0 = b.y;
    run(RIG7, b, { ...hover, moveX: 1 }, 60); // one second drifting right
    expect(Math.abs(b.y - y0)).toBeLessThan(6);
    expect(b.vx).toBeGreaterThan(200);
    // Less power sinks slowly, full power climbs.
    const sink = b.y;
    run(RIG7, b, { ...hover, thrustAmount: 0.45 }, 30);
    expect(b.y).toBeGreaterThan(sink + 5);
    expect(b.vy).toBeLessThan(400);
    const climb = b.y;
    run(RIG7, b, { ...hover, thrustAmount: 1 }, 30);
    expect(b.y).toBeLessThan(climb - 60);
  });

  it('never leaves the map or enters a solid in a 10 s random-input run', () => {
    // Deterministic pseudo-random sequence (LCG) so the test is repeatable.
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (const spawn of RIG7.spawns) {
      const b = makeBody((spawn.tx + 0.5) * TILE, (spawn.ty + 1) * TILE);
      const input: MoveInput = { moveX: 0, thrust: false, down: false };
      for (let i = 0; i < 600; i++) {
        if (i % 15 === 0) {
          input.moveX = rnd() < 0.33 ? -1 : rnd() < 0.5 ? 1 : 0;
          input.thrust = rnd() < 0.4;
          input.down = rnd() < 0.1;
          if (rnd() < 0.05) { b.vx += (rnd() - 0.5) * 2000; b.vy -= rnd() * 800; }
        }
        stepPlayer(RIG7, b, input, DT);
        expect(b.x).toBeGreaterThanOrEqual(12);
        expect(b.x).toBeLessThanOrEqual(MAP_W - 12);
        expect(b.y).toBeLessThanOrEqual(MAP_H);
        expect(isValidPosition(RIG7, b.x, b.y)).toBe(true);
      }
    }
  });
});
