import { describe, expect, it } from 'vitest';
import { EMOTES, STICKER_LEVELS, XP_ROUND_BASE, XP_ROUND_CAP, XP_WIN, levelOf, roundXp, seasonName, seasonOf, xpForLevel } from './config';

describe('levels', () => {
  it('starts at level 1 and gets harder', () => {
    expect(levelOf(0)).toBe(1);
    expect(levelOf(99)).toBe(1);
    expect(levelOf(100)).toBe(2);
    expect(levelOf(399)).toBe(2);
    expect(levelOf(400)).toBe(3);
  });

  it('agrees with xpForLevel at every boundary', () => {
    for (let level = 1; level < 30; level++) {
      expect(levelOf(xpForLevel(level))).toBe(level);
      if (level > 1) expect(levelOf(xpForLevel(level) - 1)).toBe(level - 1);
    }
  });
});

describe('round XP', () => {
  it('pays for playing, for kills and for winning', () => {
    expect(roundXp(0, false)).toBe(XP_ROUND_BASE);
    expect(roundXp(3, false)).toBeGreaterThan(roundXp(0, false));
    expect(roundXp(0, true) - roundXp(0, false)).toBe(XP_WIN);
  });

  it('is capped, whatever the kill count', () => {
    expect(roundXp(10_000, true)).toBe(XP_ROUND_CAP);
  });
});

describe('stickers', () => {
  it('has an unlock level for every sticker and four free ones', () => {
    expect(STICKER_LEVELS.length).toBe(EMOTES.length);
    expect(STICKER_LEVELS.filter((l) => l === 1).length).toBeGreaterThanOrEqual(4);
  });
});

describe('seasons', () => {
  it('changes at the UTC month boundary, not in between', () => {
    const lastOfNov = Date.UTC(2026, 10, 30, 23, 59, 59);
    const firstOfDec = Date.UTC(2026, 11, 1, 0, 0, 0);
    expect(seasonOf(firstOfDec)).toBe(seasonOf(lastOfNov) + 1);
    expect(seasonOf(Date.UTC(2026, 10, 1))).toBe(seasonOf(lastOfNov));
  });

  it('keeps counting up across a new year', () => {
    expect(seasonOf(Date.UTC(2027, 0, 1))).toBe(seasonOf(Date.UTC(2026, 11, 31)) + 1);
  });

  it('has a readable name', () => {
    expect(seasonName(seasonOf(Date.UTC(2026, 10, 5)))).toBe('Nov 2026');
    expect(seasonName(seasonOf(Date.UTC(2027, 0, 5)))).toBe('Jan 2027');
  });
});
