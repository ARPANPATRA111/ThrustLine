import { describe, expect, it } from 'vitest';
import { type GameMap, HELIOS, HELIOS_ROWS, MAPS, MAP_COLS, MAP_NAMES, MAP_ROWS, RIG7, RIG7_ROWS, T_ACID, T_EMPTY, T_ONEWAY, T_SOLID, parseMap, spawnWorldPos, tileAt } from './map';
import { MAX_PLAYERS, SUDDEN_DEATH_TO_Y, TILE } from './config';
import { isValidPosition } from './validate';

const count = (ch: string) => RIG7_ROWS.join('').split(ch).length - 1;

const ALL: [string, GameMap, readonly string[]][] = [['RIG-7', RIG7, RIG7_ROWS], ['HELIOS-9', HELIOS, HELIOS_ROWS]];

describe.each(ALL)('%s layout', (_name, map, rows) => {
  it('has 40 rows of 96 columns', () => {
    expect(rows.length).toBe(MAP_ROWS);
    for (const row of rows) expect(row.length).toBe(MAP_COLS);
  });

  it('only uses supported characters and is mirror-symmetric', () => {
    for (const row of rows) {
      expect(row).toMatch(/^[#=~.SHAGPD]+$/);
      expect(row).toBe([...row].reverse().join(''));
    }
  });

  it('has room for a full match and places to fight over', () => {
    expect(map.spawns.length).toBeGreaterThanOrEqual(MAX_PLAYERS);
    expect(map.drops.length).toBeGreaterThanOrEqual(4);
    expect(map.hills.length).toBeGreaterThanOrEqual(4);
    expect(map.pickups.some((p) => p.kind === 3), 'has a shield').toBe(true);
  });

  it('puts every marker directly above a solid or one-way tile', () => {
    for (const m of [...map.spawns, ...map.pickups, ...map.drops]) {
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

describe('map list', () => {
  it('names every map', () => {
    expect(MAP_NAMES.length).toBe(MAPS.length);
  });
});

describe('RIG-7 map', () => {
  it('has the expected marker counts', () => {
    expect(count('S')).toBe(8);
    expect(count('H')).toBe(2);
    expect(count('A')).toBe(4);
    expect(count('G')).toBe(2);
    expect(count('P')).toBe(2);
    expect(count('D')).toBe(8);
    expect(count('~')).toBe(32);
    expect(RIG7.spawns.length).toBe(8);
    expect(RIG7.pickups.length).toBe(10);
    expect(RIG7.drops.length).toBe(8);
  });

  it('treats everything outside the map as solid', () => {
    expect(tileAt(RIG7, -1, 5)).toBe(T_SOLID);
    expect(tileAt(RIG7, 5, 400)).toBe(T_SOLID);
  });

  it('rejects rows with the wrong width', () => {
    expect(() => parseMap(['###', '##'], 3)).toThrow();
  });
});
