// Exhaustive sweeps over RIG-7: bullets never pass through solid tiles, and a player standing on
// any surface who hops / flies / lets go never ends up below that surface.
import { describe, expect, it } from 'vitest';
import { TILE } from './config';
import { RIG7, T_EMPTY, T_ONEWAY, T_SOLID, tileAt } from './map';
import { makeBody, stepPlayer, type MoveInput } from './physics';
import { castTiles } from './raycast';

const DT = 1 / 60;

/** Brute force: walk the segment in 0.25 px steps and return the distance of the first solid sample. */
function bruteCast(x0: number, y0: number, dx: number, dy: number, max: number): number {
  for (let t = 0; t <= max; t += 0.25) {
    const x = x0 + dx * t;
    const y = y0 + dy * t;
    if (tileAt(RIG7, Math.floor(x / TILE), Math.floor(y / TILE)) === T_SOLID) return t;
  }
  return max;
}

describe('bullets vs walls (DDA against brute force)', () => {
  it('never passes through a solid tile', () => {
    let seed = 99;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    let checked = 0;
    for (let i = 0; i < 4000; i++) {
      const x0 = 40 + rnd() * (RIG7.cols * TILE - 80);
      const y0 = 40 + rnd() * (RIG7.rows * TILE - 80);
      if (tileAt(RIG7, Math.floor(x0 / TILE), Math.floor(y0 / TILE)) === T_SOLID) continue;
      const a = rnd() * Math.PI * 2;
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      const dda = castTiles(RIG7, x0, y0, dx, dy, 1200);
      const brute = bruteCast(x0, y0, dx, dy, 1200);
      // DDA must never go past a wall the sampler finds. (DDA may stop *earlier* on a corner
      // graze thinner than the 0.25 px sampling step; that is DDA being exact.)
      expect(dda).toBeLessThanOrEqual(brute + 0.5);
      checked++;
    }
    expect(checked).toBeGreaterThan(2000);
  });
});

describe('standing on surfaces', () => {
  // Every top surface: a solid or one-way tile with two empty tiles above.
  const surfaces: { tx: number; ty: number; code: number }[] = [];
  for (let ty = 2; ty < RIG7.rows; ty++) {
    for (let tx = 1; tx < RIG7.cols - 1; tx++) {
      const code = tileAt(RIG7, tx, ty);
      if ((code === T_SOLID || code === T_ONEWAY) && tileAt(RIG7, tx, ty - 1) === T_EMPTY && tileAt(RIG7, tx, ty - 2) === T_EMPTY) {
        surfaces.push({ tx, ty, code });
      }
    }
  }

  const scripts: { name: string; frames: (i: number) => MoveInput }[] = [
    { name: 'tap hop', frames: (i) => ({ moveX: 0, thrust: i < 2, down: false }) },
    { name: 'hold thrust then release', frames: (i) => ({ moveX: 0, thrust: i < 40, down: false }) },
    { name: 'tap, release, tap again', frames: (i) => ({ moveX: 0, thrust: i < 3 || (i > 20 && i < 24), down: false }) },
    { name: 'long flight', frames: (i) => ({ moveX: 0, thrust: i < 150, down: false }) },
  ];

  it(`never falls through any of the surfaces after jumping`, () => {
    expect(surfaces.length).toBeGreaterThan(100);
    for (const s of surfaces) {
      // Only test spots where the whole 24 px body fits on the surface.
      const x = (s.tx + 0.5) * TILE;
      const left = tileAt(RIG7, s.tx - 1, s.ty) === s.code;
      const right = tileAt(RIG7, s.tx + 1, s.ty) === s.code;
      if (!left && !right) continue;
      for (const sc of scripts) {
        const b = makeBody(x, s.ty * TILE);
        // Settle first.
        for (let i = 0; i < 10; i++) stepPlayer(RIG7, b, { moveX: 0, thrust: false, down: false }, DT);
        expect(b.y, `settle on ${s.tx},${s.ty}`).toBe(s.ty * TILE);
        for (let i = 0; i < 400; i++) stepPlayer(RIG7, b, sc.frames(i), DT);
        // After landing again the feet must be at or above the original surface.
        expect(b.y, `${sc.name} on ${s.code === T_SOLID ? 'solid' : 'one-way'} tile ${s.tx},${s.ty}`).toBeLessThanOrEqual(s.ty * TILE);
      }
    }
  });
});
