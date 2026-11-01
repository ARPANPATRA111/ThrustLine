// Callsigns for players who haven't picked a name, and for name clashes in a room.
export const CALLSIGN_ADJ = ['Neon', 'Turbo', 'Rogue', 'Acid', 'Iron', 'Swift', 'Nova', 'Ghost', 'Rapid', 'Solar', 'Storm', 'Laser', 'Volt', 'Cosmo', 'Hyper', 'Frost', 'Crimson', 'Shadow', 'Blitz', 'Echo'];
export const CALLSIGN_NOUN = ['Falcon', 'Rigger', 'Viper', 'Comet', 'Raven', 'Jet', 'Wolf', 'Spark', 'Hawk', 'Bolt', 'Lynx', 'Orbit', 'Fox', 'Pilot', 'Blaze', 'Drift', 'Cobra', 'Titan', 'Kite', 'Rook'];

/** A callsign like "Neon Falcon" (at most 16 characters). `random` returns [0, 1). */
export function randomCallsign(random: () => number): string {
  const a = CALLSIGN_ADJ[Math.floor(random() * CALLSIGN_ADJ.length)];
  const n = CALLSIGN_NOUN[Math.floor(random() * CALLSIGN_NOUN.length)];
  return `${a} ${n}`.slice(0, 16);
}
