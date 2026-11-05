import { describe, expect, it } from 'vitest';
import { CRYO, CRYO_ROWS, type GameMap, HELIOS, HELIOS_ROWS, KILN, KILN_ROWS, MAPS, MAP_COLS, MAP_NAMES, MAP_ROWS, RIG7, RIG7_ROWS, SKYREACH, SKYREACH_ROWS, T_ACID, T_EMPTY, T_ONEWAY, T_SOLID, parseMap, restingY, spawnWorldPos, tileAt } from './map';
import { FLAG_TOUCH_UP, FLAG_TOUCH_X, JET_HOVER, MAX_PLAYERS, SUDDEN_DEATH_TO_Y, TILE } from './config';
import { flowField, steer } from './nav';
import { makeBody, stepPlayer } from './physics';
import { isValidPosition } from './validate';

const count = (ch: string) => RIG7_ROWS.join('').split(ch).length - 1;

const ALL: [string, GameMap, readonly string[]][] = [['RIG-7', RIG7, RIG7_ROWS], ['HELIOS-9', HELIOS, HELIOS_ROWS], ['KILN-3', KILN, KILN_ROWS], ['SKYREACH', SKYREACH, SKYREACH_ROWS], ['CRYO-12', CRYO, CRYO_ROWS]];

describe.each(ALL)('%s layout', (_name, map, rows) => {
  it('has 40 rows of 96 columns', () => {
    expect(rows.length).toBe(MAP_ROWS);
    for (const row of rows) expect(row.length).toBe(MAP_COLS);
  });

  it('only uses supported characters and is mirror-symmetric', () => {
    for (const row of rows) {
      expect(row).toMatch(/^[#=~.SHAGPrb12]+$/);
      const flip: Record<string, string> = { r: 'b', b: 'r', 1: '2', 2: '1' };
      expect(row).toBe([...row].reverse().map((c) => flip[c] ?? c).join(''));
    }
  });

  it('has room for a full match and places to fight over', () => {
    expect(map.spawns.length).toBeGreaterThanOrEqual(MAX_PLAYERS);
    expect(map.drops.length).toBeGreaterThanOrEqual(4);
    expect(map.hills.length).toBeGreaterThanOrEqual(4);
    expect(map.pickups.some((p) => p.kind === 3), 'has a shield').toBe(true);
  });

  it('puts every marker directly above a solid or one-way tile', () => {
    for (const m of [...map.spawns, ...map.pickups, ...map.spots]) {
      expect([T_SOLID, T_ONEWAY]).toContain(tileAt(map, m.tx, m.ty + 1));
    }
  });

  it('gives every spawn two empty tiles of headroom and a legal position', () => {
    for (const s of map.spawns) {
      expect(tileAt(map, s.tx, s.ty)).toBe(T_EMPTY);
      expect(tileAt(map, s.tx, s.ty - 1)).toBe(T_EMPTY);
      const p = spawnWorldPos(s);
      expect(isValidPosition(map, p.x, p.y), `spawn ${s.tx},${s.ty}`).toBe(true);
    }
  });

  it('rests every hill zone on a platform or the floor, with room to stand', () => {
    for (const z of map.hills) {
      let footing = 0;
      for (let tx = z.tx; tx < z.tx + z.tw; tx++) {
        if ([T_SOLID, T_ONEWAY].includes(tileAt(map, tx, z.ty + z.th))) footing++;
        for (let ty = z.ty; ty < z.ty + z.th; ty++) expect(tileAt(map, tx, ty), `tile ${tx},${ty}`).not.toBe(T_SOLID);
      }
      expect(footing, `zone at ${z.tx},${z.ty}`).toBeGreaterThanOrEqual(6);
    }
  });

  it('gives each team a safe home with a flag stand and spawns', () => {
    expect(map.bases.length).toBe(2);
    for (const b of map.bases) {
      expect(b.spawns.length).toBeGreaterThanOrEqual(3);
      for (const m of [b.flag, ...b.spawns]) {
        expect([T_SOLID, T_ONEWAY], `${m.tx},${m.ty}`).toContain(tileAt(map, m.tx, m.ty + 1));
        expect(isValidPosition(map, ...(Object.values(spawnWorldPos(m)) as [number, number])), `${m.tx},${m.ty}`).toBe(true);
      }
      for (const sp of b.spawns) expect(Math.abs(sp.tx - b.flag.tx), 'spawns sit by their flag').toBeLessThan(16);
    }
    expect(map.bases[0].flag.tx).toBeLessThan(MAP_COLS / 2);
    expect(map.bases[1].flag.tx).toBeGreaterThan(MAP_COLS / 2);
  });

  it('can be crossed: every spawn, flag and hill connects', () => {
    const red = map.bases[0].flag;
    const field = flowField(map, red.tx, red.ty);
    const blue = map.bases[1].flag;
    expect(field[blue.ty * map.cols + blue.tx], 'flag to flag').toBeGreaterThan(0);
    for (const m of [...map.spawns, ...map.bases.flatMap((b) => b.spawns), ...map.spots]) {
      expect(field[m.ty * map.cols + m.tx], `${m.tx},${m.ty}`).toBeGreaterThanOrEqual(0);
    }
  });

  it('offers pickup spots across the whole map', () => {
    expect(map.spots.length).toBeGreaterThan(60);
    expect(map.drops.length, 'room for airdrops').toBeGreaterThanOrEqual(6);
    const left = map.spots.filter((s) => s.tx < MAP_COLS / 2).length;
    expect(left / map.spots.length).toBeGreaterThan(0.3);
    expect(left / map.spots.length).toBeLessThan(0.7);
  });

  it('never puts a spot on the acid, in a wall or by a spawn', () => {
    for (const s of map.spots) {
      expect(tileAt(map, s.tx, s.ty)).toBe(T_EMPTY);
      expect(tileAt(map, s.tx, s.ty - 1)).toBe(T_EMPTY);
      expect(tileAt(map, s.tx, s.ty + 1)).not.toBe(T_ACID);
      expect(isValidPosition(map, (s.tx + 0.5) * TILE, (s.ty + 1) * TILE), `spot ${s.tx},${s.ty}`).toBe(true);
      for (const sp of map.spawns) expect(Math.abs(sp.tx - s.tx) >= 4 || Math.abs(sp.ty - s.ty) >= 4, `spot ${s.tx},${s.ty}`).toBe(true);
    }
  });

  it('keeps some ground, hill zones and spawns above the sudden-death acid', () => {
    expect(map.spawns.some((s) => spawnWorldPos(s).y <= SUDDEN_DEATH_TO_Y), 'spawn').toBe(true);
    expect(map.hills.some((z) => (z.ty + z.th) * TILE <= SUDDEN_DEATH_TO_Y), 'hill').toBe(true);
  });

  it('has an acid pit', () => {
    let acid = 0;
    for (let i = 0; i < map.tiles.length; i++) if (map.tiles[i] === T_ACID) acid++;
    expect(acid).toBeGreaterThan(0);
  });
});

describe('steer', () => {
  it('walks along the floor, climbs to a platform and drops back down', () => {
    expect(steer(RIG7, 25 * TILE, 36 * TILE, 29 * TILE, 36 * TILE).moveX).toBe(1);
    expect(steer(RIG7, 45 * TILE, 36 * TILE, 45 * TILE, 31 * TILE).up).toBe(true);
    expect(steer(RIG7, 45 * TILE, 31 * TILE, 45 * TILE, 36 * TILE).down).toBe(true);
  });

  it('never routes through the acid', () => {
    const field = flowField(RIG7, 30, 35);
    expect(field[36 * RIG7.cols + 48]).toBe(-1);
  });

  // The real physics, driven the way a CPU player drives it. A grid route alone is not proof: a body
  // can span three tiles in the air, and that is what catches heads on tunnel roofs and ledges.
  const travel = (map: GameMap, from: { tx: number; ty: number }, to: { tx: number; ty: number }): number => {
    const start = spawnWorldPos(from);
    const goal = spawnWorldPos(to);
    const b = makeBody(start.x, start.y);
    let held = false;
    for (let step = 0; step < 40 * 60; step++) {
      const r = steer(map, b.x, b.y, goal.x, goal.y);
      let thrust = r.up || r.hover;
      if (thrust && b.grounded && held) thrust = false; // a hop needs a fresh press
      held = thrust;
      stepPlayer(map, b, { moveX: r.moveX, thrust, thrustAmount: r.hover && !b.grounded ? JET_HOVER + 0.08 : 1, down: r.down && b.grounded }, 1 / 60, { runSpeedMul: 1, fuelRefillMul: 1, infiniteFuel: true });
      if (Math.abs(b.x - goal.x) <= FLAG_TOUCH_X && b.y >= goal.y - FLAG_TOUCH_UP && b.y <= goal.y + TILE) return step / 60;
    }
    return Infinity;
  };

  it.each(ALL)('flies a body flag to flag and back on %s', (_name, map) => {
    const [red, blue] = map.bases;
    expect(travel(map, red.flag, blue.flag)).toBeLessThan(25);
    expect(travel(map, blue.flag, red.flag)).toBeLessThan(25);
  });

  it.each(ALL)('flies a body from every spawn to the enemy flag on %s', (_name, map) => {
    for (const s of [...map.spawns, ...map.bases[0].spawns]) expect(travel(map, s, map.bases[1].flag), `from ${s.tx},${s.ty}`).toBeLessThan(30);
  });
});

describe('map list', () => {
  it('names every map', () => {
    expect(MAP_NAMES.length).toBe(MAPS.length);
  });

  it('keeps the maps really different from each other', () => {
    const solidShare = (m: GameMap) => m.tiles.reduce((n, t) => n + (t === T_SOLID ? 1 : 0), 0) / m.tiles.length;
    expect(solidShare(KILN), 'the bunker is far more enclosed than the rig').toBeGreaterThan(solidShare(RIG7) * 2);
    for (let tx = 1; tx < MAP_COLS - 1; tx++) expect(tileAt(SKYREACH, tx, 36), 'the sky map has no ground, only acid').toBe(T_ACID);
  });
});

describe('RIG-7 map', () => {
  it('has the expected marker counts', () => {
    expect(count('S')).toBe(8);
    expect(count('H')).toBe(2);
    expect(count('A')).toBe(4);
    expect(count('G')).toBe(2);
    expect(count('P')).toBe(2);
    expect(count('~')).toBe(32);
    expect(RIG7.spawns.length).toBe(8);
    expect(RIG7.pickups.length).toBe(10);
  });

  it('treats everything outside the map as solid', () => {
    expect(tileAt(RIG7, -1, 5)).toBe(T_SOLID);
    expect(tileAt(RIG7, 5, 400)).toBe(T_SOLID);
  });

  it('rejects rows with the wrong width', () => {
    expect(() => parseMap(['###', '##'], 3)).toThrow();
  });
});

describe('restingY', () => {
  it('finds the floor or platform below', () => {
    expect(restingY(RIG7, 24 * TILE, 30 * TILE)).toBe(36 * TILE);
    expect(restingY(RIG7, 45 * TILE, 28 * TILE)).toBe(31 * TILE);
  });

  it('stays put on the floor it is already standing on', () => {
    expect(restingY(RIG7, 24 * TILE, 36 * TILE)).toBe(36 * TILE);
  });

  it('gives up over the acid', () => {
    expect(restingY(RIG7, 48 * TILE, 33 * TILE)).toBeNull();
    expect(restingY(RIG7, 48 * TILE, 38 * TILE), 'or in it, with solid ground below').toBeNull();
  });
});
