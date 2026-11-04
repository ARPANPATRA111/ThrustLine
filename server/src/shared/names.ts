// Callsigns for players who haven't picked a name, and for name clashes in a room.
export const CALLSIGN_ADJ = ['Neon', 'Turbo', 'Rogue', 'Acid', 'Iron', 'Swift', 'Nova', 'Ghost', 'Rapid', 'Solar', 'Storm', 'Laser', 'Volt', 'Cosmo', 'Hyper', 'Frost', 'Crimson', 'Shadow', 'Blitz', 'Echo'];
export const CALLSIGN_NOUN = ['Falcon', 'Rigger', 'Viper', 'Comet', 'Raven', 'Jet', 'Wolf', 'Spark', 'Hawk', 'Bolt', 'Lynx', 'Orbit', 'Fox', 'Pilot', 'Blaze', 'Drift', 'Cobra', 'Titan', 'Kite', 'Rook'];

/** A callsign like "Neon Falcon" (at most 16 characters). `random` returns [0, 1). */
export function randomCallsign(random: () => number): string {
  const a = CALLSIGN_ADJ[Math.floor(random() * CALLSIGN_ADJ.length)];
  const n = CALLSIGN_NOUN[Math.floor(random() * CALLSIGN_NOUN.length)];
  return `${a} ${n}`.slice(0, 16);
}

// Control characters, zero-width characters and bidi overrides are invisible in the lobby, which
// lets two players look like they have the same name. Listed as code points so the source stays
// readable (and so the check does not depend on a regex engine's Unicode tables).
function isInvisible(cp: number): boolean {
  return (
    cp <= 0x1f ||
    (cp >= 0x7f && cp <= 0x9f) ||
    cp === 0x061c ||
    cp === 0x180e ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x206f) ||
    cp === 0xfeff
  );
}

/**
 * Server-side callsign cleaning: drops invisible characters, collapses whitespace and limits
 * the name to `maxLen` characters (counted as code points, so emoji are never split).
 * Display code still escapes names; this is the input-side half of the same defence.
 */
export function sanitizeName(raw: string, maxLen: number): string {
  // A modified client can send a huge string; only the first few hundred code units matter.
  const visible = Array.from(raw.length > 512 ? raw.slice(0, 512) : raw).filter((ch) => !isInvisible(ch.codePointAt(0)!));
  const clean = visible.join('').replace(/\s+/g, ' ').trim();
  return Array.from(clean).slice(0, maxLen).join('').trim();
}
