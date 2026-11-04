import { describe, expect, it } from 'vitest';
import { randomCallsign, sanitizeName } from './names';

describe('sanitizeName', () => {
  it('keeps ordinary callsigns intact', () => {
    expect(sanitizeName('Neon Falcon', 16)).toBe('Neon Falcon');
  });

  it('strips control, zero-width and bidi characters', () => {
    expect(sanitizeName('Ad​min‮', 16)).toBe('Admin');
    expect(sanitizeName('A\u0000B\u001fC', 16)).toBe('ABC');
  });

  it('collapses whitespace and trims', () => {
    expect(sanitizeName('  Space   Rigger  ', 16)).toBe('Space Rigger');
  });

  it('limits by code point, never splitting an emoji', () => {
    expect(sanitizeName('1234567890123456', 16)).toHaveLength(16);
    const emoji = sanitizeName('🚀🚀🚀🚀🚀🚀🚀🚀🚀', 4);
    expect(emoji).toBe('🚀🚀🚀🚀');
    expect(Array.from(emoji)).toHaveLength(4);
  });

  it('can return empty, which the lobby replaces with a random callsign', () => {
    expect(sanitizeName('​  \u0000', 16)).toBe('');
  });
});

describe('randomCallsign', () => {
  it('is a plain two-word callsign within the name limit', () => {
    const name = randomCallsign(() => 0);
    expect(name).toBe('Neon Falcon');
  });
});
