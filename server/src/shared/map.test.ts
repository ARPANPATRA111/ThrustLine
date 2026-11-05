import { describe, expect, it } from 'vitest';
import { MAP_COLS, MAP_ROWS, RIG7, RIG7_ROWS, T_EMPTY, T_ONEWAY, T_SOLID, parseMap, tileAt } from './map';

const count = (ch: string) => RIG7_ROWS.join('').split(ch).length - 1;

describe('RIG-7 map', () => {
  it('has 40 rows of 96 columns', () => {
    expect(RIG7_ROWS.length).toBe(MAP_ROWS);
    for (const row of RIG7_ROWS) expect(row.length).toBe(MAP_COLS);
  });

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

  it('only uses supported characters', () => {
    for (const row of RIG7_ROWS) expect(row).toMatch(/^[#=~.SHAGPD]+$/);
  });

  it('is mirror-symmetric', () => {
    for (const row of RIG7_ROWS) expect(row).toBe([...row].reverse().join(''));
  });

  it('puts every marker directly above a solid or one-way tile', () => {
    for (const m of [...RIG7.spawns, ...RIG7.pickups, ...RIG7.drops]) {
      const below = tileAt(RIG7, m.tx, m.ty + 1);
      expect([T_SOLID, T_ONEWAY]).toContain(below);
    }
  });

  it('gives every spawn two empty tiles of headroom', () => {
    for (const s of RIG7.spawns) {
      expect(tileAt(RIG7, s.tx, s.ty)).toBe(T_EMPTY);
      expect(tileAt(RIG7, s.tx, s.ty - 1)).toBe(T_EMPTY);
    }
  });

  it('treats everything outside the map as solid', () => {
    expect(tileAt(RIG7, -1, 5)).toBe(T_SOLID);
    expect(tileAt(RIG7, 5, 400)).toBe(T_SOLID);
  });

  it('rejects rows with the wrong width', () => {
    expect(() => parseMap(['###', '##'], 3)).toThrow();
  });
});
