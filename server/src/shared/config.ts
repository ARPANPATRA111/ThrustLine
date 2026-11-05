// Every tunable number in THRUSTLINE lives here.
// Units: world pixels (1 tile = 32 px) and seconds unless a name says otherwise.
// This file is imported by BOTH the SpacetimeDB module and the browser client,
// so it must stay pure TypeScript (no DOM, no Node APIs, no randomness).

export const TILE = 32;

// ---------- Player body & movement ----------
export const PLAYER_W = 24;
export const PLAYER_H = 48;
export const RUN_SPEED = 260;
export const GROUND_ACCEL = 2400;
/** Air steering: high enough that jets stay agile without feeling floaty. */
export const AIR_ACCEL = 1500;
export const GROUND_FRICTION = 2600;
/** Gentle slow-down in the air when no direction is held (keeps blast-jumps flowing). */
export const AIR_DRAG = 300;
export const GRAVITY = 1800;
export const MAX_FALL = 900;
/** Max horizontal speed reachable through external impulses (recoil, blasts, lunges). */
export const MAX_IMPULSE_SPEED_X = 1000;
/** Max upward speed reachable through impulses (grenade blast). */
export const MAX_IMPULSE_SPEED_UP = 900;

// ---------- Jetpack ----------
export const JET_ACCEL = 3000; // net 1200 upward once gravity is subtracted
export const JET_MAX_UP = 460;
export const FUEL_MAX = 100;
export const FUEL_DRAIN = 34; // per second while thrusting (just under 3 s of flight)
export const FUEL_REFILL = 70; // per second (full tank in ~1.4 s, so the action keeps moving)
export const FUEL_REFILL_DELAY = 0.12; // seconds on the ground before refilling starts
export const HOP_SPEED = 560;
export const HOP_FUEL = 6;

// ---------- Health, spawns, respawn ----------
export const MAX_HP = 100;
export const SPAWN_PROTECT_SEC = 1.5;
/** Fixed respawn delay: the host no longer configures it. */
export const RESPAWN_SEC = 5;
export const JOIN_SPAWN_SEC = 1;
export const SPAWN_MIN_DIST_FROM_DEATH = 200;
export const SPAWN_RANDOM_TOP_N = 3;

// ---------- Hazard ----------
export const ACID_DPS = 30;

// ---------- Pickups ----------
export const PICKUP_RESPAWN_SEC = 20;
export const HEALTH_PACK_HP = 50;
export const GRENADE_CRATE_MAX = 3;
/** Pickup hit box is one tile centred on its marker tile. */
export const PICKUP_SIZE = 32;
/** Health and shields move each time they come back: this far from each other... */
export const SPOT_MIN_GAP_TILES = 12;
/** ...and this far from any living player, so nobody just waits for one to appear underfoot. */
export const SPOT_MIN_PLAYER_PX = 320;
/** A spot this close to a spawn point is never used. */
export const SPOT_SPAWN_GAP_TILES = 4;
/** Tiles of open air an airdrop crate needs above its landing spot. */
export const DROP_CLEAR_TILES = 8;

// ---------- Power-ups ----------
export const SHIELD_MAX = 50;
export const SHIELD_RESPAWN_SEC = 30;
/** Railgun shots in an airdrop crate. */
export const RAIL_SHOTS = 3;
export const AIRDROP_FIRST_SEC = 30;
export const AIRDROP_FIRST_DEV_SEC = 3;
export const AIRDROP_EVERY_SEC = 60;
/** How long a crate parachutes down after it is announced, and how fast it falls. */
export const AIRDROP_FALL_SEC = 4;
export const AIRDROP_FALL_PX_PER_SEC = 240;

// ---------- King of the Hill ----------
export const HILL_POINTS_PER_SEC = 10;
export const HILL_MOVE_SEC = 40;
export const HILL_MOVE_DEV_SEC = 10;
export const HILL_EMPTY = 0;
export const HILL_CONTESTED = 1;
export const HILL_HELD = 2;

// ---------- Sudden death ----------
export const SUDDEN_DEATH_SEC = 30;
export const SUDDEN_DEATH_DEV_SEC = 12;
/** The acid surface climbs from the floor to here (world y, px). */
export const SUDDEN_DEATH_FROM_Y = 36 * TILE;
export const SUDDEN_DEATH_TO_Y = 17 * TILE;

// ---------- Progression ----------
export const XP_ROUND_BASE = 25;
export const XP_PER_KILL = 10;
export const XP_WIN = 50;
/** Most XP a round can pay, which limits what farming a friend can earn. */
export const XP_ROUND_CAP = 300;
export const SEASON_BOARD_SIZE = 20;
/** Level needed for each sticker; the index matches EMOTES. */
export const STICKER_LEVELS = [1, 1, 1, 1, 2, 3, 4, 5];
/** How many stickers have a number key. */
export const QUICK_STICKERS = 4;

// ---------- Scoring ----------
export const SCORE_KILL = 100;
export const SCORE_BOUNTY_BONUS = 50;
export const SCORE_SELF_DEATH = -50;
/** Killing a teammate (friendly fire on): no kill credit, and this penalty. */
export const SCORE_TEAMKILL = -50;
export const BOUNTY_STREAK = 3;

// ---------- Round & rooms ----------
export const MAX_PLAYERS = 8;
/** After a round ends, everyone returns to the lobby automatically after this many seconds. */
export const LOBBY_RETURN_SEC = 12;
/** A dropped player keeps their slot and stats this long, so a phone can come back. */
export const RECONNECT_GRACE_SEC = 30;
export const RECONNECT_GRACE_DEV_SEC = 15;

// ---------- Quick Play (public rooms that run on a loop, no lobby) ----------
export const QUICK_ROUND_SEC = 180;
export const QUICK_MAX_HUMANS = 6;
/** The host's client tops the room up with CPU players to this many. */
export const QUICK_MIN_PLAYERS = 4;

// ---------- Teams ----------
export const TEAM_NONE = 0;
export const TEAM_RED = 1;
export const TEAM_BLUE = 2;
export const ROUND_LENGTHS_SEC = [120, 180, 300, 480, 600];
export const DEV_ROUND_SEC = 30;
export const DEFAULT_ROUND_SEC = 300;
export const FRENZY_SEC = 60;
export const FRENZY_DAMAGE_MUL = 1.5;
export const FRENZY_FUEL_MUL = 2;
export const NAME_MAX = 16;
/** Room codes skip O, I and L so they can't be confused with 0 and 1. */
export const ROOM_CODE_LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ';
export const ROOM_CODE_LEN = 4;

// ---------- Modes ----------
export const MODE_ARMS = 0;
export const MODE_BLADES = 1;
export const MODE_BOOM = 2;
export const MODE_SNIPERS = 3;
export const MODE_NAMES = ['Arms', 'Blades', 'Boom', 'Snipers'];
export const BLADES_RUN_MUL = 1.15;

// ---------- House rules (host-editable) ----------
export const HP_OPTIONS = [50, 100, 150, 200];
export const BOT_EASY = 0;
export const BOT_NORMAL = 1;
export const BOT_HARD = 2;
export const DEFAULT_RULES = {
  infiniteFuel: true,
  infiniteAmmo: true,
  pickups: true,
  acid: true,
  frenzy: true,
  maxHp: 100,
  respawnSec: RESPAWN_SEC,
  botSkill: BOT_NORMAL,
  /** Teams only: teammates can hurt each other. */
  friendlyFire: true,
  /** Grenades ignore gravity and drift where they are thrown (zero-g). */
  floatingGrenades: true,
};
/** What a round is played for. */
export const OBJECTIVE_KILLS = 0;
export const OBJECTIVE_HILL = 1;
/** Arena options, stored in `room.match` next to the original house rules. */
/** `match.map` value meaning "a different map every round". */
export const MAP_ROTATE = 255;
export const DEFAULT_MATCH = {
  /** Crates with a power weapon parachute in during the round. */
  airdrops: true,
  /** The acid rises in the final seconds, so a round cannot end in hiding. */
  suddenDeath: true,
  objective: OBJECTIVE_KILLS,
  /** An index into MAPS, or MAP_ROTATE. */
  map: 0,
};

// ---------- Grenades ----------
/** Short enough that a thrown frag is a live threat, not a warning. */
export const GRENADE_FUSE_MS = 1500;
export const GRENADE_THROW_SPEED = 900;
/** Fraction of the thrower's own velocity added to the throw. */
export const GRENADE_INHERIT = 0.35;
export const GRENADE_RESTITUTION = 0.45;
export const GRENADE_FRICTION = 0.7;
export const GRENADE_RADIUS = 5;
export const GRENADE_BLAST_RADIUS = 170;
/** No grenade one-shots a full-health pilot, Frenzy included. */
export const GRENADE_MAX_DAMAGE = 80;
export const GRENADE_KNOCKBACK = 700;
export const GRENADE_ARMS_PER_LIFE = 2;
export const GRENADE_COOLDOWN_ARMS = 0.7;
export const GRENADE_COOLDOWN_BOOM = 0.85;
export const GRENADE_BOOM_MAX_LIVE = 3;
/** Impact grenades: airborne with nothing to hit, they burst on this fuse. */
export const IMPACT_FUSE_MS = 1800;
export const IMPACT_BLAST_RADIUS = 130;
export const IMPACT_COOLDOWN = 1.4;
/** A thrower cannot set off their own impact grenade while it is leaving their hand. */
export const IMPACT_ARM_MS = 220;
/** Extra reach around a body when testing an impact grenade against it. */
export const IMPACT_HIT_PAD = 6;
/** EMP grenades: no damage, but the jetpack dies. */
export const EMP_FUSE_MS = 1200;
export const EMP_BLAST_RADIUS = 210;
export const EMP_COOLDOWN = 6;
export const EMP_SEC = 3;
/** The hit player only hears about the EMP a round trip later, so enforcement starts this late. */
export const EMP_GRACE_SEC = 0.4;
/** How far a jump can lift you with the jetpack dead: a full hop, with slack for a coasting climb. */
export const EMP_RISE_PX = (HOP_SPEED * HOP_SPEED) / (2 * GRAVITY) + 40;
/** The grenade simulation runs at a fixed 120 Hz so server and client agree exactly. */
export const GRENADE_TICK_HZ = 120;
/** Zero-g grenades: velocity multiplier per 120 Hz tick (slow drift to a stop, ~680 px travel). */
export const GRENADE_ZEROG_DRAG = 0.99;
/** Distance from the player's centre to the hand where a grenade spawns. */
export const HAND_OFFSET = 18;

// ---------- Melee ----------
export const KNIFE_LUNGE = 220;

// ---------- Netcode ----------
export const SYNC_INTERVAL_MS = 50;
export const SYNC_IDLE_INTERVAL_MS = 200;
export const SYNC_MIN_GAP_MS = 25;
export const SYNC_MAX_DT_SEC = 0.25;
/** Fastest legal speed used by the movement check. sqrt(1000^2 + 900^2) ~ 1345 (blast + max fall). */
export const MOVE_CHECK_SPEED = 1400;
export const MOVE_CHECK_SLACK = 1.3;
export const MOVE_CHECK_EXTRA_PX = 24;
/**
 * Per-axis travel credit (px) a client may bank for jitter and bunched packets. Credit refills at
 * the speed physics allows right now, so this bounds a burst but never raises the sustained speed.
 */
export const MOVE_BUDGET_PX = 96;
/** Head-room over the physically possible speed, for rounding and clock drift. */
export const MOVE_SPEED_SLACK = 1.1;
/** Extra reach around a blast when granting knockback speed: the client may see it elsewhere. */
export const BLAST_BOOST_MARGIN_PX = 120;
/** A blast also lifts: Actor.knockback adds a quarter of its strength upward. */
export const BLAST_BOOST = GRENADE_KNOCKBACK * 1.25;
/** The server shrinks the hitbox by this much when testing for solid overlap (f32 rounding). */
export const SOLID_OVERLAP_EPS = 0.5;
export const SHOT_ORIGIN_TOLERANCE = 48;
export const SHOT_RANGE_TOLERANCE = 64;
export const SHOT_RAY_TOLERANCE = 40;
/** Extra pellets a claim may report over what the target's size allows at that distance. */
export const PELLET_TOLERANCE = 2;
/** Fraction of the weapon's fire interval that the server insists on between shots. */
export const FIRE_RATE_TOLERANCE = 0.85;
export const MELEE_SERVER_RANGE = 72;
export const MELEE_SERVER_ARC_DEG = 70;
export const INTERP_DELAY_MS = 100;
export const EXTRAPOLATE_MAX_MS = 100;
export const SNAPSHOT_BUFFER = 20;
export const PING_COUNT_INITIAL = 5;
export const PING_INITIAL_GAP_MS = 200;
export const PING_INTERVAL_MS = 2000;
export const PING_MEDIAN_OF = 5;
/** Server-side anti-spam limits (per identity). */
export const ROOM_CREATE_COOLDOWN_SEC = 5;
export const ROOM_JOIN_COOLDOWN_SEC = 1;
export const PING_MIN_GAP_MS = 150;

// ---------- Client sim & camera ----------
export const SIM_HZ = 60;
export const VIEW_HEIGHT = 680;
/** Minimum view height (most zoomed in), used on short phone screens. */
export const VIEW_HEIGHT_MIN = 420;
export const VIEW_MAX_WIDTH = 1500;
export const CAMERA_LERP = 0.12;
export const CAMERA_LEAD = 90;
export const CAMERA_LEAD_SNIPER = 320;

// ---------- Rendering / perf ----------
export const PARTICLE_CAP_HIGH = 400;
export const PARTICLE_CAP_LOW = 150;
export const TRACER_FADE_MS = 80;
export const MAP_CHUNK = 1024;

// ---------- pstate.flags bits ----------
export const FLAG_FACING_RIGHT = 1;
export const FLAG_GROUNDED = 2;
export const FLAG_JETTING = 4;
export const FLAG_RELOADING = 8;

// ---------- Analog jetpack (Mini Militia style) ----------
/** Thrust fraction that exactly cancels gravity (1800 / 3000): hover. */
export const JET_HOVER = GRAVITY / JET_ACCEL;
/** Vertical damping while the jets fire, so hovering and gentle climbs are easy to hold. */
export const JET_DAMPING = 2.5;

// ---------- Latency handling ----------
/** Server-side position history per player used for lag compensation. */
export const HISTORY_LEN = 16;
/** Hits are judged against where the target was up to this long ago (shooter's view). */
export const LAGCOMP_MAX_MS = 700;
/** How far a client's clock may run ahead of the server's in total (anti speed-hack budget). */
export const TIME_DEBT_MAX_MS = 350;
/** Longest movement interval the server accepts in one sync. */
export const MOVE_MAX_DT_SEC = 0.5;

// ---------- Emotes ----------
/**
 * Emotes a player can send during a match; the array index is what the server broadcasts.
 * The client draws the matching Hinglish sticker for each index (client/src/render/stickers.ts).
 */
export const EMOTES = ['BHAI', 'OYE', 'JHAKAAS', 'BINDAAS', 'CHUP', 'DHAMAKA', 'KYA RE', 'TATA'];
/** Short server-side cooldown so a held key cannot flood the room. */
export const EMOTE_COOLDOWN_SEC = 0.6;
/** How long an emote stays above the sender's head, in seconds. */
export const EMOTE_SHOW_SEC = 2.6;

// ---------- kill causes (weapon ids 0..6 are reused as causes) ----------
export const CAUSE_ACID = 10;
export const CAUSE_IMPACT = 11;

// ---------- Room-wide announcements (notice_ev.kind) ----------
export const NOTICE_AIRDROP = 0;
export const NOTICE_HILL_MOVED = 1;

/** Level 1 needs 0 XP, level 2 needs 100, level 3 needs 400, level 4 needs 900... */
export function levelOf(xp: number): number {
  return Math.floor(Math.sqrt(xp / 100)) + 1;
}
export function xpForLevel(level: number): number {
  return (level - 1) * (level - 1) * 100;
}

/** XP for one finished round. */
export function roundXp(kills: number, won: boolean): number {
  return Math.min(XP_ROUND_CAP, XP_ROUND_BASE + kills * XP_PER_KILL + (won ? XP_WIN : 0));
}

/** Seasons are calendar months (UTC), numbered so that later seasons are larger. */
export function seasonOf(ms: number): number {
  const d = new Date(ms);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function seasonName(season: number): string {
  return `${MONTHS[season % 12]} ${Math.floor(season / 12)}`;
}

/**
 * World y of the rising acid during sudden death, or Infinity before it starts. Like Frenzy this
 * comes from the round clock on both sides, so nothing is stored or sent.
 */
export function acidSurface(nowMs: number, endsAtMs: number, roundSec: number): number {
  const span = (roundSec < 120 ? SUDDEN_DEATH_DEV_SEC : SUDDEN_DEATH_SEC) * 1000;
  const left = endsAtMs - nowMs;
  if (left > span) return Infinity;
  const t = Math.min(1, Math.max(0, 1 - left / span));
  return SUDDEN_DEATH_FROM_Y + (SUDDEN_DEATH_TO_Y - SUDDEN_DEATH_FROM_Y) * t;
}

/** Frenzy is computed from the round end time on both sides; nothing is stored. */
export function isFrenzy(nowMs: number, endsAtMs: number): boolean {
  const left = endsAtMs - nowMs;
  return left > 0 && left <= FRENZY_SEC * 1000;
}
