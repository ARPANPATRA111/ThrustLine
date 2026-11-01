import { describe, expect, it } from 'vitest';
import { GRENADE_RADIUS, TILE } from './config';
import { GrenadeState, simulateGrenade, stepGrenade } from './grenade';
import { RIG7, T_SOLID, parseMap, tileAt } from './map';

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

  it('never ends inside a solid tile from many throws', () => {
    for (const s of RIG7.spawns) {
      for (let a = 0; a < 16; a++) {
        const ang = (a / 16) * Math.PI * 2;
        const x = (s.tx + 0.5) * TILE;
        const y = (s.ty + 1) * TILE - 24;
        const g = fresh();
        g.x = x; g.y = y; g.vx = Math.cos(ang) * 820; g.vy = Math.sin(ang) * 820;
        for (let i = 0; i < 300; i++) {
          stepGrenade(RIG7, g);
          expect(insideSolid(RIG7, g)).toBe(false);
        }
      }
    }
  });
});
