import { describe, expect, it } from 'vitest';
import { GRENADE_RADIUS, TILE } from './config';
import { GrenadeState, bodyContact, firstTouchTick, fuseTicks, simulateGrenade, stepGrenade, ticksToFuseMs } from './grenade';
import { RIG7, T_EMPTY, T_SOLID, parseMap, tileAt } from './map';

const R = GRENADE_RADIUS;
const fresh = (): GrenadeState => ({ x: 0, y: 0, vx: 0, vy: 0 });

function insideSolid(map = RIG7, g: GrenadeState) {
  for (const [ox, oy] of [[-R, -R], [R - 0.01, -R], [-R, R - 0.01], [R - 0.01, R - 0.01]]) {
    if (tileAt(map, Math.floor((g.x + ox) / TILE), Math.floor((g.y + oy) / TILE)) === T_SOLID) return true;
  }
  return false;
}

const BOX = parseMap(['##########', '#........#', '#........#', '#........#', '##########'], 10);

describe('simulateGrenade', () => {
  it('is deterministic for identical inputs', () => {
    const a = simulateGrenade(RIG7, 300, 400, 820, -300, 300, fresh());
    const b = simulateGrenade(RIG7, 300, 400, 820, -300, 300, fresh());
    expect(a).toEqual(b);
  });

  it('bounces off the floor', () => {
    const g: GrenadeState = { x: 5 * TILE, y: 2 * TILE, vx: 0, vy: 600 };
    let bounced = false;
    for (let i = 0; i < 120; i++) {
      stepGrenade(BOX, g);
      if (g.vy < 0) bounced = true;
    }
    expect(bounced).toBe(true);
    expect(g.y + R).toBeLessThanOrEqual(4 * TILE + 1e-6);
  });

  it('bounces off walls', () => {
    const g: GrenadeState = { x: 5 * TILE, y: 2 * TILE, vx: 900, vy: 0 };
    let reversed = false;
    for (let i = 0; i < 120; i++) {
      stepGrenade(BOX, g);
      if (g.vx < 0) reversed = true;
    }
    expect(reversed).toBe(true);
  });

  it('zero-g grenades float: no fall, drift to a stop where thrown', () => {
    const g: GrenadeState = { x: 20 * TILE, y: 12 * TILE, vx: 300, vy: 0 };
    const y0 = g.y;
    for (let i = 0; i < 300; i++) stepGrenade(RIG7, g, true);
    expect(Math.abs(g.y - y0)).toBeLessThan(1);
    expect(g.x).toBeGreaterThan(20 * TILE + 200);
    expect(Math.abs(g.vx)).toBeLessThan(30);
    expect(simulateGrenade(RIG7, 640, 384, 500, -200, 300, fresh(), true)).toEqual(simulateGrenade(RIG7, 640, 384, 500, -200, 300, fresh(), true));
  });

  it('never ends inside a solid tile from many throws', () => {
    for (const s of RIG7.spawns) {
      for (let a = 0; a < 16; a++) {
        const ang = (a / 16) * Math.PI * 2;
        const x = (s.tx + 0.5) * TILE;
        const y = (s.ty + 1) * TILE - 24;
        const g = fresh();
        g.x = x; g.y = y; g.vx = Math.cos(ang) * 820; g.vy = Math.sin(ang) * 820;
        for (const zeroG of [false, true]) {
          const h = { ...g };
          for (let i = 0; i < 300; i++) {
            stepGrenade(RIG7, h, zeroG);
            expect(insideSolid(RIG7, h)).toBe(false);
          }
        }
      }
    }
  });
});

describe('impact grenades', () => {
  const free = (x: number, y: number) => {
    // Open air in the middle of the map, far from every tile.
    expect(tileAt(RIG7, Math.floor(x / TILE), Math.floor(y / TILE))).toBe(T_EMPTY);
    return { x, y };
  };

  it('touches the floor at the tick the flight says it does', () => {
    const start = free(30 * TILE, 33 * TILE);
    const tick = firstTouchTick(RIG7, start.x, start.y, 0, 400, 400);
    expect(tick).toBeLessThan(120);
    const end = simulateGrenade(RIG7, start.x, start.y, 0, 400, tick, { x: 0, y: 0, vx: 0, vy: 0 });
    expect(end.y + GRENADE_RADIUS).toBeCloseTo(36 * TILE, 3);
  });

  it('touches walls and one-way platforms too', () => {
    expect(firstTouchTick(RIG7, 3 * TILE, 33 * TILE, -900, 0, 400)).toBeLessThan(30);
    expect(firstTouchTick(RIG7, 45 * TILE, 28 * TILE, 0, 300, 400)).toBeLessThan(120);
  });

  it('keeps flying on its fuse with nothing to touch', () => {
    expect(firstTouchTick(RIG7, 48 * TILE, 12 * TILE, 40, -40, 20, true)).toBe(20);
  });

  it('stores a fuse that converts back to the exact tick', () => {
    for (let t = 1; t < 240; t++) expect(fuseTicks(ticksToFuseMs(t))).toBe(t);
  });

  const f = { x0: 30 * TILE, y0: 20 * TILE, vx0: 600, vy0: 0, zeroG: true };

  it('finds a body in its path, on the timeline of that body', () => {
    // After 200 ms the grenade is about 110 px along. A body waiting there is hit around then.
    const body = { x: f.x0 + 110, y: f.y0 + 24 };
    expect(bodyContact(RIG7, f, 400, body, body, 150, 260)).not.toBeNull();
  });

  it('misses a body the grenade reaches at another time', () => {
    const body = { x: f.x0 + 400, y: f.y0 + 24 };
    expect(bodyContact(RIG7, f, 400, body, body, 0, 100)).toBeNull();
  });

  it('misses a body high above the flight path', () => {
    const body = { x: f.x0 + 110, y: f.y0 - 120 };
    expect(bodyContact(RIG7, f, 400, body, body, 150, 260)).toBeNull();
  });

  it('cannot hit anything after it has burst', () => {
    const body = { x: f.x0 + 110, y: f.y0 + 24 };
    expect(bodyContact(RIG7, f, 10, body, body, 150, 260)).toBeNull();
  });
});
