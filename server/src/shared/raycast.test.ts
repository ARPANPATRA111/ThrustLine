import { describe, expect, it } from 'vitest';
import { TILE } from './config';
import { parseMap } from './map';
import { castTiles, lineOfSight, rayVsBox } from './raycast';

const M = parseMap(
  [
    '##########',
    '#........#',
    '#...#....#',
    '#...=....#',
    '##########',
  ],
  10,
);

describe('castTiles (DDA)', () => {
  it('stops at the first solid tile', () => {
    // From (1.5, 2.5) tiles going right, the pillar at column 4 starts at x = 128.
    const d = castTiles(M, 1.5 * TILE, 2.5 * TILE, 1, 0, 1000);
    expect(d).toBeCloseTo(4 * TILE - 1.5 * TILE, 5);
  });

  it('passes through one-way platforms', () => {
    const d = castTiles(M, 1.5 * TILE, 3.5 * TILE, 1, 0, 1000);
    expect(d).toBeCloseTo(9 * TILE - 1.5 * TILE, 5);
  });

  it('returns maxDist when nothing is hit', () => {
    expect(castTiles(M, 1.5 * TILE, 1.5 * TILE, 1, 0, 50)).toBe(50);
  });

  it('works diagonally', () => {
    const s = Math.SQRT1_2;
    const d = castTiles(M, 1.5 * TILE, 1.5 * TILE, s, s, 1000);
    // Hits the floor row 4 (y = 128) after travelling 2.5 tiles down: distance = 2.5*32*sqrt2.
    expect(d).toBeCloseTo(2.5 * TILE * Math.SQRT2, 3);
  });

  it('lineOfSight is blocked by the pillar', () => {
    expect(lineOfSight(M, 1.5 * TILE, 2.5 * TILE, 7.5 * TILE, 2.5 * TILE)).toBe(false);
    expect(lineOfSight(M, 1.5 * TILE, 1.5 * TILE, 7.5 * TILE, 1.5 * TILE)).toBe(true);
  });
});

describe('rayVsBox (slab test)', () => {
  it('hits a box in front of the ray', () => {
    expect(rayVsBox(0, 0, 1, 0, 10, -5, 20, 5, 100)).toBeCloseTo(10);
  });
  it('misses a box beside the ray', () => {
    expect(rayVsBox(0, 0, 1, 0, 10, 6, 20, 16, 100)).toBe(-1);
  });
  it('misses a box behind the ray', () => {
    expect(rayVsBox(0, 0, 1, 0, -20, -5, -10, 5, 100)).toBe(-1);
  });
  it('misses a box beyond max distance', () => {
    expect(rayVsBox(0, 0, 1, 0, 200, -5, 220, 5, 100)).toBe(-1);
  });
  it('hits diagonally', () => {
    const s = Math.SQRT1_2;
    expect(rayVsBox(0, 0, s, s, 10, 10, 20, 20, 100)).toBeCloseTo(10 * Math.SQRT2);
  });
});
