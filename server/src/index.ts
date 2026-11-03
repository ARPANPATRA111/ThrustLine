// THRUSTLINE SpacetimeDB module: the referee.
// Clients simulate and own their own movement; this module validates every update and owns
// everything that decides the match (HP, deaths, kills, score, ammo, pickups, grenades,
// spawns, teams and the clock). There is no continuous tick: timed things are one-shot
// schedules, and everything else happens inside the 20 Hz `sync` reducer.
import { schema, table, t, SenderError, type Infer, type InferSchema, type ReducerCtx } from 'spacetimedb/server';
import { ScheduleAt, type Identity } from 'spacetimedb';
import * as C from './shared/config';
import { MAP_H, MAP_W, PICKUP_AMMO, PICKUP_GRENADE, PICKUP_HEALTH, RIG7, T_ACID, T_SOLID, boxTouchesTile, spawnWorldPos } from './shared/map';
import { WEAPONS, W_FRAG, W_KNIFE, W_PISTOL, PRIMARIES, allowedWeapons, canThrow, damageAtDistance, defaultWeapon, effectivePrimary, grenadeDamage, isGun, isPrimary, pickupActive } from './shared/weapons';
import { fuseTicks, simulateGrenade } from './shared/grenade';
import { pickSpawn, shuffledSpawnOrder, type Point } from './shared/spawn';
import { lineOfSight } from './shared/raycast';
import { randomCallsign } from './shared/names';
import { fireRateOk, hitClaimDistance, isValidPosition, meleeHits, shotOriginOk, validateMove } from './shared/validate';

// ============================================================================
// Tables
// ============================================================================

const ROOM_LOBBY = 0;
const ROOM_PLAYING = 1;
const ROOM_ENDED = 2;

/** House rules the host can change in the lobby. */
const Rules = t.object('Rules', {
  /** Jetpack never runs out of fuel. */
  infiniteFuel: t.bool(),
  /** Guns never run dry and never need reloading. */
  infiniteAmmo: t.bool(),
  /** Health / ammo / grenade crates on the map. */
  pickups: t.bool(),
  /** The acid pit burns. */
  acid: t.bool(),
  /** Last-minute Frenzy (damage x1.5, fuel x2). */
  frenzy: t.bool(),
  maxHp: t.u16(),
  respawnSec: t.u8(),
  /** CPU difficulty: 0 easy, 1 normal, 2 hard. */
  botSkill: t.u8(),
  /** Teams only: teammates can hurt each other. */
  friendlyFire: t.bool(),
  /** Grenades ignore gravity and drift where they are thrown. */
  floatingGrenades: t.bool(),
});
type RulesRow = Infer<typeof Rules>;

const room = table(
  { name: 'room', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    code: t.string().unique(),
    hostIdentity: t.identity(),
    state: t.u8(),
    mode: t.u8(),
    roundSec: t.u32(),
    dev: t.bool(),
    /** Team match (red vs blue) instead of free-for-all. */
    teams: t.bool(),
    rules: Rules,
    startedAtMicros: t.i64(),
    endsAtMicros: t.i64(),
    /** When an ended round automatically returns everyone to the lobby (0 = not ended). */
    lobbyAtMicros: t.i64(),
    roundNo: t.u32(),
    createdAt: t.timestamp(),
  },
);

// Cold player data: stats, health and ammo. Changes a few times per second at most.
const player = table(
  { name: 'player', public: true },
  {
    identity: t.identity().primaryKey(),
    roomId: t.u64().index('btree'),
    name: t.string(),
    colorIdx: t.u8(),
    /** 0 = no team (free-for-all), 1 = red, 2 = blue. */
    team: t.u8(),
    isBot: t.bool(),
    joinedAt: t.timestamp(),
    alive: t.bool(),
    hp: t.f32(),
    lifeId: t.u32(),
    kills: t.u32(),
    deaths: t.u32(),
    score: t.i32(),
    streak: t.u32(),
    primary: t.u8(),
    weapon: t.u8(),
    mag: t.u16(),
    pistolMag: t.u16(),
    reserve: t.u16(),
    grenades: t.u8(),
    reloadUntilMicros: t.i64(),
    spawnProtectUntilMicros: t.i64(),
    respawnAtMicros: t.i64(),
    correction: t.u32(),
    cx: t.f32(),
    cy: t.f32(),
    /** Round-trip time reported by the player's client, shown to everyone. */
    pingMs: t.u16(),
  },
);

// Hot movement data, rewritten ~20 times per second per player.
const pstate = table(
  { name: 'pstate', public: true },
  {
    identity: t.identity().primaryKey(),
    roomId: t.u64().index('btree'),
    x: t.f32(),
    y: t.f32(),
    vx: t.f32(),
    vy: t.f32(),
    aim: t.f32(),
    flags: t.u8(),
    weapon: t.u8(),
    seq: t.u32(),
    serverMicros: t.i64(),
    /**
     * When this state was simulated, on the sender's clock (its estimate of server time, ms).
     * Other clients interpolate on this timeline, so network jitter between the sender and the
     * server doesn't make the movement stutter.
     */
    sentMs: t.f64(),
  },
);

// Private bookkeeping the clients never see.
const pmeta = table(
  { name: 'pmeta' },
  {
    identity: t.identity().primaryKey(),
    connId: t.option(t.connectionId()),
    lastSyncMicros: t.i64(),
    lastHazardMicros: t.i64(),
    prevX: t.f32(),
    prevY: t.f32(),
    prevMicros: t.i64(),
    /** Client clock (ms) of the last accepted movement; 0 = none yet. */
    lastClientMs: t.f64(),
    /** How much more time (ms) the client has claimed than the server observed, capped. */
    timeDebtMs: t.f64(),
    /** Recent accepted positions on the client timeline, for lag-compensated hit checks. */
    histT: t.array(t.f64()),
    histX: t.array(t.f32()),
    histY: t.array(t.f32()),
    /** Last fire time per gun, indexed by weapon id 0..3. */
    lastFire: t.array(t.i64()),
    lastMeleeMicros: t.i64(),
    lastThrowMicros: t.i64(),
    hasDeath: t.bool(),
    deathX: t.f32(),
    deathY: t.f32(),
  },
);

const pickup = table(
  { name: 'pickup', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    roomId: t.u64().index('btree'),
    kind: t.u8(),
    tx: t.u16(),
    ty: t.u16(),
    availableAtMicros: t.i64(),
  },
);

const grenade = table(
  { name: 'grenade', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    roomId: t.u64().index('btree'),
    owner: t.identity().index('btree'),
    x0: t.f32(),
    y0: t.f32(),
    vx0: t.f32(),
    vy0: t.f32(),
    thrownMicros: t.i64(),
    fuseMs: t.u32(),
    /** Floating (zero-g) grenade: no gravity, drifts to a stop. */
    zeroG: t.bool(),
  },
);

/** Players the host removed from a room; they cannot rejoin it. */
const kicked = table(
  { name: 'kicked' },
  {
    id: t.u64().primaryKey().autoInc(),
    roomId: t.u64().index('btree'),
    identity: t.identity(),
  },
);

// ---------- Scheduled (one-shot) job tables, all private ----------
const respawnJob = table(
  { name: 'respawn_job' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    identity: t.identity().index('btree'),
    roomId: t.u64().index('btree'),
    lifeId: t.u32(),
  },
);
const roundEndJob = table(
  { name: 'round_end_job' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    roomId: t.u64().index('btree'),
    roundNo: t.u32(),
  },
);
const lobbyJob = table(
  { name: 'lobby_job' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    roomId: t.u64().index('btree'),
    roundNo: t.u32(),
  },
);
const detonateJob = table(
  { name: 'detonate_job' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    grenadeId: t.u64().index('btree'),
    roomId: t.u64().index('btree'),
  },
);
const pickupJob = table(
  { name: 'pickup_job' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    pickupId: t.u64(),
    roomId: t.u64().index('btree'),
  },
);

// ---------- Event tables: broadcast on commit, never stored ----------
const shotEv = table(
  { name: 'shot_ev', public: true, event: true },
  { roomId: t.u64(), shooter: t.identity(), weapon: t.u8(), x0: t.f32(), y0: t.f32(), ends: t.array(t.f32()) },
);
const hitEv = table(
  { name: 'hit_ev', public: true, event: true },
  { roomId: t.u64(), attacker: t.identity(), target: t.identity(), dmg: t.f32(), x: t.f32(), y: t.f32(), killed: t.bool() },
);
const killEv = table(
  { name: 'kill_ev', public: true, event: true },
  { roomId: t.u64(), killer: t.identity(), victim: t.identity(), cause: t.u8(), bounty: t.bool(), teamkill: t.bool() },
);
const meleeEv = table(
  { name: 'melee_ev', public: true, event: true },
  { roomId: t.u64(), attacker: t.identity(), x: t.f32(), y: t.f32(), dir: t.f32() },
);
const boomEv = table(
  { name: 'boom_ev', public: true, event: true },
  { roomId: t.u64(), owner: t.identity(), x: t.f32(), y: t.f32() },
);
const pickupEv = table(
  { name: 'pickup_ev', public: true, event: true },
  { roomId: t.u64(), identity: t.identity(), kind: t.u8(), pickupId: t.u64() },
);
const pongEv = table(
  { name: 'pong_ev', public: true, event: true },
  { to: t.identity(), clientMs: t.f64(), serverMicros: t.i64() },
);
/** Tells a player they were removed by the host. */
const kickEv = table(
  { name: 'kick_ev', public: true, event: true },
  { to: t.identity(), roomCode: t.string() },
);

const spacetimedb = schema({
  room,
  player,
  pstate,
  pmeta,
  pickup,
  grenade,
  kicked,
  respawnJob,
  roundEndJob,
  lobbyJob,
  detonateJob,
  pickupJob,
  shotEv,
  hitEv,
  killEv,
  meleeEv,
  boomEv,
  pickupEv,
  pongEv,
  kickEv,
});
export default spacetimedb;

type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;
type RoomRow = Infer<typeof room.rowType>;
type PlayerRow = Infer<typeof player.rowType>;
type MetaRow = Infer<typeof pmeta.rowType>;
type PStateRow = Infer<typeof pstate.rowType>;

// ============================================================================
// Small helpers
// ============================================================================

const SEC = 1_000_000n; // microseconds per second
const secToMicros = (s: number) => BigInt(Math.round(s * 1e6));
const nowMicros = (ctx: Ctx) => ctx.timestamp.microsSinceUnixEpoch;
const nowMs = (ctx: Ctx) => Number(ctx.timestamp.microsSinceUnixEpoch) / 1000;
const atMicros = (micros: bigint) => ScheduleAt.time(micros);

/** Trim to 16 chars and remove control characters. */
function cleanName(raw: string): string {
  return raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, C.NAME_MAX).trim();
}

/**
 * A name nobody else in the room is using. If the requested name is empty or taken, the player
 * gets a completely different random callsign (e.g. "Volt Hawk"), so no two players look alike.
 */
function uniqueName(ctx: Ctx, roomId: bigint, raw: string, self: Identity): string {
  const taken = new Set(roomPlayers(ctx, roomId).filter((p) => !p.identity.isEqual(self)).map((p) => p.name.toLowerCase()));
  const wanted = cleanName(raw);
  if (wanted.length > 0 && !taken.has(wanted.toLowerCase())) return wanted;
  for (let i = 0; i < 60; i++) {
    const candidate = randomCallsign(() => ctx.random());
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${wanted || 'Rigger'} ${ctx.random.integerInRange(10, 99)}`.slice(0, C.NAME_MAX);
}

function frenzyMul(r: RoomRow, now: bigint): number {
  if (!r.rules.frenzy) return 1;
  return C.isFrenzy(Number(now) / 1000, Number(r.endsAtMicros) / 1000) ? C.FRENZY_DAMAGE_MUL : 1;
}

function roomPlayers(ctx: Ctx, roomId: bigint): PlayerRow[] {
  return [...ctx.db.player.roomId.filter(roomId)];
}

/** A player's centre point (pstate stores the feet). */
function centreOf(ctx: Ctx, identity: Identity): Point | null {
  const ps = ctx.db.pstate.identity.find(identity);
  return ps ? { x: ps.x, y: ps.y - C.PLAYER_H / 2 } : null;
}

function primaryMag(primary: number): number {
  return WEAPONS[primary].mag;
}
function primaryReserve(primary: number): number {
  return WEAPONS[primary].reserve;
}

/** Same team in a team match (never true in free-for-all). */
function sameTeam(r: RoomRow, a: PlayerRow, b: PlayerRow): boolean {
  return r.teams && a.team !== C.TEAM_NONE && a.team === b.team;
}

/** May `attacker` damage `target`? Teammates only with friendly fire on; yourself always. */
function canHurt(r: RoomRow, attacker: PlayerRow, target: PlayerRow): boolean {
  if (attacker.identity.isEqual(target.identity)) return true;
  return !sameTeam(r, attacker, target) || r.rules.friendlyFire;
}

/** In dev rooms, log why an action was rejected (move rejections are logged everywhere). */
function rejected(r: RoomRow, what: string): void {
  if (r.dev || what.startsWith('move')) console.info(`[${r.code}] rejected ${what}`);
}

/** Forget a player's movement timeline (spawn, teleport): the next sync starts fresh. */
function resetMotion(meta: MetaRow, x: number, y: number, now: bigint): MetaRow {
  return { ...meta, prevX: x, prevY: y, prevMicros: now, lastSyncMicros: now, lastClientMs: 0, timeDebtMs: 0, histT: [], histX: [], histY: [] };
}

// ============================================================================
// Spawning
// ============================================================================

/** Put a player into the world at a spawn point with a fresh life and loadout. */
function spawnAt(ctx: Ctx, r: RoomRow, p: PlayerRow, spawnIdx: number): PlayerRow {
  const now = nowMicros(ctx);
  const pos = spawnWorldPos(RIG7.spawns[spawnIdx]);
  const updated: PlayerRow = {
    ...p,
    alive: true,
    hp: r.rules.maxHp,
    lifeId: p.lifeId + 1,
    weapon: defaultWeapon(r.mode, p.primary),
    mag: primaryMag(effectivePrimary(r.mode, p.primary)),
    reserve: primaryReserve(effectivePrimary(r.mode, p.primary)),
    pistolMag: WEAPONS[W_PISTOL].mag,
    grenades: r.mode === C.MODE_ARMS ? C.GRENADE_ARMS_PER_LIFE : 0,
    reloadUntilMicros: 0n,
    spawnProtectUntilMicros: now + secToMicros(C.SPAWN_PROTECT_SEC),
    respawnAtMicros: 0n,
    cx: pos.x,
    cy: pos.y,
  };
  ctx.db.player.identity.update(updated);
  const ps = ctx.db.pstate.identity.find(p.identity);
  if (ps) {
    ctx.db.pstate.identity.update({ ...ps, x: pos.x, y: pos.y, vx: 0, vy: 0, flags: C.FLAG_GROUNDED, weapon: updated.weapon, serverMicros: now, sentMs: nowMs(ctx) });
  }
  const meta = ctx.db.pmeta.identity.find(p.identity);
  if (meta) ctx.db.pmeta.identity.update({ ...resetMotion(meta, pos.x, pos.y, now), lastHazardMicros: now, hasDeath: false });
  return updated;
}

/** Choose a spawn with the smart-spawn rules (section 4) and spawn the player there. */
function respawnPlayer(ctx: Ctx, r: RoomRow, p: PlayerRow): void {
  const meta = ctx.db.pmeta.identity.find(p.identity);
  const death = meta && meta.hasDeath ? { x: meta.deathX, y: meta.deathY } : null;
  const enemies: Point[] = [];
  for (const other of roomPlayers(ctx, r.id)) {
    // Teammates are not a threat: only enemies push spawns away.
    if (other.alive && !other.identity.isEqual(p.identity) && !sameTeam(r, other, p)) {
      const ps = ctx.db.pstate.identity.find(other.identity);
      if (ps) enemies.push({ x: ps.x, y: ps.y });
    }
  }
  const idx = pickSpawn(RIG7.spawns, death, enemies, () => ctx.random());
  spawnAt(ctx, r, p, idx);
}

function scheduleRespawn(ctx: Ctx, p: PlayerRow, delaySec: number): bigint {
  const at = nowMicros(ctx) + secToMicros(delaySec);
  ctx.db.respawnJob.insert({ scheduledId: 0n, scheduledAt: atMicros(at), identity: p.identity, roomId: p.roomId, lifeId: p.lifeId });
  return at;
}

// ============================================================================
// Damage and scoring
// ============================================================================

interface KillResult {
  killed: boolean;
  bounty: boolean;
  teamkill: boolean;
}

/**
 * applyDamage: subtract HP from `victim` (a mutable copy the caller writes back), emit hit_ev,
 * and on death handle everything about the victim's side of the kill. Kill credit for the
 * attacker is applied by the caller via creditKill(), because the caller may hold the
 * attacker's row as an unsaved local copy.
 */
function applyDamage(ctx: Ctx, victim: PlayerRow, amount: number, attacker: Identity, cause: number, teamkill = false): KillResult {
  const result: KillResult = { killed: false, bounty: false, teamkill };
  if (!victim.alive || amount <= 0) return result;
  const pos = ctx.db.pstate.identity.find(victim.identity);
  const px = pos ? pos.x : 0;
  const py = pos ? pos.y - C.PLAYER_H / 2 : 0;
  victim.hp = Math.max(0, victim.hp - amount);
  const killed = victim.hp <= 0;
  ctx.db.hitEv.insert({ roomId: victim.roomId, attacker, target: victim.identity, dmg: amount, x: px, y: py, killed });
  if (!killed) return result;

  const selfInflicted = attacker.isEqual(victim.identity) || cause === C.CAUSE_ACID;
  result.killed = true;
  result.bounty = victim.streak >= C.BOUNTY_STREAK && !selfInflicted && !teamkill;
  victim.alive = false;
  victim.deaths += 1;
  victim.streak = 0;
  victim.reloadUntilMicros = 0n;
  if (selfInflicted) victim.score += C.SCORE_SELF_DEATH;
  const vr = ctx.db.room.id.find(victim.roomId);
  victim.respawnAtMicros = scheduleRespawn(ctx, victim, vr ? vr.rules.respawnSec : C.RESPAWN_SEC);
  const meta = ctx.db.pmeta.identity.find(victim.identity);
  if (meta && pos) ctx.db.pmeta.identity.update({ ...meta, hasDeath: true, deathX: pos.x, deathY: pos.y });
  ctx.db.killEv.insert({ roomId: victim.roomId, killer: attacker, victim: victim.identity, cause, bounty: result.bounty, teamkill: teamkill && !selfInflicted });
  return result;
}

/** Credit the attacker for a kill: +100 (+50 bounty), or a penalty for killing a teammate. */
function creditKill(p: PlayerRow, res: KillResult): void {
  if (res.teamkill) {
    p.score += C.SCORE_TEAMKILL;
    return;
  }
  p.kills += 1;
  p.score += C.SCORE_KILL + (res.bounty ? C.SCORE_BOUNTY_BONUS : 0);
  p.streak += 1;
}

/** Damage another player identified by row; writes the victim; returns whether they died. */
function damageOther(ctx: Ctx, r: RoomRow, attacker: PlayerRow, target: PlayerRow, amount: number, cause: number): KillResult {
  const victim = { ...target };
  const teamkill = sameTeam(r, attacker, target) && !attacker.identity.isEqual(target.identity);
  const res = applyDamage(ctx, victim, amount, attacker.identity, cause, teamkill);
  ctx.db.player.identity.update(victim);
  return res;
}

function isProtected(p: PlayerRow, now: bigint): boolean {
  return p.spawnProtectUntilMicros > now;
}

// ============================================================================
// Room membership and teams
// ============================================================================

function lowestFreeColor(ctx: Ctx, roomId: bigint): number {
  const used = new Set(roomPlayers(ctx, roomId).map((p) => p.colorIdx));
  for (let i = 0; i < C.MAX_PLAYERS; i++) if (!used.has(i)) return i;
  return 0;
}

/** The team with fewer players (red on a tie). */
function smallerTeam(players: PlayerRow[], except?: Identity): number {
  let red = 0, blue = 0;
  for (const p of players) {
    if (except && p.identity.isEqual(except)) continue;
    if (p.team === C.TEAM_RED) red++;
    else if (p.team === C.TEAM_BLUE) blue++;
  }
  return blue < red ? C.TEAM_BLUE : C.TEAM_RED;
}

/** Split everyone into balanced teams by join order (or clear teams for free-for-all). */
function assignTeams(ctx: Ctx, r: RoomRow, on: boolean): void {
  const players = roomPlayers(ctx, r.id).sort((a, b) => (a.joinedAt.microsSinceUnixEpoch < b.joinedAt.microsSinceUnixEpoch ? -1 : 1));
  players.forEach((p, i) => {
    const team = on ? (i % 2 === 0 ? C.TEAM_RED : C.TEAM_BLUE) : C.TEAM_NONE;
    if (p.team !== team) ctx.db.player.identity.update({ ...p, team });
  });
}

function addPlayerToRoom(ctx: Ctx, r: RoomRow, name: string, isBot: boolean): void {
  const now = nowMicros(ctx);
  const start = spawnWorldPos(RIG7.spawns[0]);
  const primary = PRIMARIES[0];
  ctx.db.player.insert({
    identity: ctx.sender,
    roomId: r.id,
    name: uniqueName(ctx, r.id, name, ctx.sender),
    colorIdx: lowestFreeColor(ctx, r.id),
    team: r.teams ? smallerTeam(roomPlayers(ctx, r.id)) : C.TEAM_NONE,
    isBot,
    joinedAt: ctx.timestamp,
    alive: false,
    hp: r.rules.maxHp,
    lifeId: 0,
    kills: 0,
    deaths: 0,
    score: 0,
    streak: 0,
    primary,
    weapon: defaultWeapon(r.mode, primary),
    mag: primaryMag(primary),
    pistolMag: WEAPONS[W_PISTOL].mag,
    reserve: primaryReserve(primary),
    grenades: 0,
    reloadUntilMicros: 0n,
    spawnProtectUntilMicros: 0n,
    respawnAtMicros: 0n,
    correction: 0,
    cx: start.x,
    cy: start.y,
    pingMs: 0,
  });
  ctx.db.pstate.insert({ identity: ctx.sender, roomId: r.id, x: start.x, y: start.y, vx: 0, vy: 0, aim: 0, flags: 0, weapon: 0, seq: 0, serverMicros: now, sentMs: nowMs(ctx) });
  ctx.db.pmeta.insert({
    identity: ctx.sender,
    connId: ctx.connectionId ?? undefined,
    lastSyncMicros: 0n,
    lastHazardMicros: now,
    prevX: start.x,
    prevY: start.y,
    prevMicros: now,
    lastClientMs: 0,
    timeDebtMs: 0,
    histT: [],
    histX: [],
    histY: [],
    lastFire: [0n, 0n, 0n, 0n],
    lastMeleeMicros: 0n,
    lastThrowMicros: 0n,
    hasDeath: false,
    deathX: 0,
    deathY: 0,
  });
}

/** Remove a player and everything they own; hand over host or close an empty room. */
function removePlayer(ctx: Ctx, identity: Identity): void {
  const p = ctx.db.player.identity.find(identity);
  ctx.db.pstate.identity.delete(identity);
  ctx.db.pmeta.identity.delete(identity);
  for (const g of [...ctx.db.grenade.owner.filter(identity)]) {
    for (const job of [...ctx.db.detonateJob.grenadeId.filter(g.id)]) ctx.db.detonateJob.scheduledId.delete(job.scheduledId);
    ctx.db.grenade.id.delete(g.id);
  }
  for (const job of [...ctx.db.respawnJob.identity.filter(identity)]) ctx.db.respawnJob.scheduledId.delete(job.scheduledId);
  if (!p) return;
  ctx.db.player.identity.delete(identity);

  const r = ctx.db.room.id.find(p.roomId);
  if (!r) return;
  const rest = roomPlayers(ctx, r.id);
  if (rest.length === 0 || rest.every((q) => q.isBot)) {
    // Bots alone can't host: their owner (a human) has left, so close the room.
    for (const b of rest) removePlayer(ctx, b.identity);
    deleteRoom(ctx, r.id);
  } else if (r.hostIdentity.isEqual(identity)) {
    // Hand host to the earliest-joined remaining human.
    const humans = rest.filter((q) => !q.isBot).sort((a, b) => (a.joinedAt.microsSinceUnixEpoch < b.joinedAt.microsSinceUnixEpoch ? -1 : 1));
    ctx.db.room.id.update({ ...r, hostIdentity: humans[0].identity });
  }
}

function clearRoomJobs(ctx: Ctx, roomId: bigint, includePickups: boolean): void {
  for (const j of [...ctx.db.respawnJob.roomId.filter(roomId)]) ctx.db.respawnJob.scheduledId.delete(j.scheduledId);
  for (const j of [...ctx.db.detonateJob.roomId.filter(roomId)]) ctx.db.detonateJob.scheduledId.delete(j.scheduledId);
  for (const g of [...ctx.db.grenade.roomId.filter(roomId)]) ctx.db.grenade.id.delete(g.id);
  if (includePickups) {
    for (const j of [...ctx.db.pickupJob.roomId.filter(roomId)]) ctx.db.pickupJob.scheduledId.delete(j.scheduledId);
    for (const j of [...ctx.db.roundEndJob.roomId.filter(roomId)]) ctx.db.roundEndJob.scheduledId.delete(j.scheduledId);
    for (const j of [...ctx.db.lobbyJob.roomId.filter(roomId)]) ctx.db.lobbyJob.scheduledId.delete(j.scheduledId);
  }
}

function deleteRoom(ctx: Ctx, roomId: bigint): void {
  clearRoomJobs(ctx, roomId, true);
  for (const pk of [...ctx.db.pickup.roomId.filter(roomId)]) ctx.db.pickup.id.delete(pk.id);
  for (const k of [...ctx.db.kicked.roomId.filter(roomId)]) ctx.db.kicked.id.delete(k.id);
  ctx.db.room.id.delete(roomId);
}

function requireMember(ctx: Ctx): { p: PlayerRow; r: RoomRow } {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) throw new SenderError('You are not in a room');
  const r = ctx.db.room.id.find(p.roomId);
  if (!r) throw new SenderError('Room not found');
  return { p, r };
}

function requireHost(ctx: Ctx): { p: PlayerRow; r: RoomRow } {
  const m = requireMember(ctx);
  if (!m.r.hostIdentity.isEqual(ctx.sender)) throw new SenderError('Only the host can do that');
  return m;
}

function validRoundSec(sec: number, dev: boolean): boolean {
  return C.ROUND_LENGTHS_SEC.includes(sec) || (dev && sec === C.DEV_ROUND_SEC);
}

function validRules(rules: RulesRow): boolean {
  return C.HP_OPTIONS.includes(rules.maxHp) && C.RESPAWN_OPTIONS.includes(rules.respawnSec) && rules.botSkill <= C.BOT_HARD;
}

/** Ended round → back to the lobby for everyone (stats stay visible until the next start). */
function toLobby(ctx: Ctx, r: RoomRow): void {
  for (const j of [...ctx.db.lobbyJob.roomId.filter(r.id)]) ctx.db.lobbyJob.scheduledId.delete(j.scheduledId);
  ctx.db.room.id.update({ ...r, state: ROOM_LOBBY, lobbyAtMicros: 0n });
}

// ============================================================================
// Lobby reducers
// ============================================================================

export const createRoom = spacetimedb.reducer(
  { name: t.string(), mode: t.u8(), roundSec: t.u32(), dev: t.bool() },
  (ctx, { name, mode, roundSec, dev }) => {
    if (mode > C.MODE_SNIPERS) throw new SenderError('Unknown mode');
    if (!validRoundSec(roundSec, dev)) throw new SenderError('Invalid round length');
    removePlayer(ctx, ctx.sender); // leave any current room first

    // Unique 4-letter code from letters without O, I or L.
    let code = '';
    for (let attempt = 0; attempt < 100; attempt++) {
      code = '';
      for (let i = 0; i < C.ROOM_CODE_LEN; i++) {
        code += C.ROOM_CODE_LETTERS[ctx.random.integerInRange(0, C.ROOM_CODE_LETTERS.length - 1)];
      }
      if (!ctx.db.room.code.find(code)) break;
    }
    if (ctx.db.room.code.find(code)) throw new SenderError('Could not allocate a room code, try again');

    const r = ctx.db.room.insert({
      id: 0n,
      code,
      hostIdentity: ctx.sender,
      state: ROOM_LOBBY,
      mode,
      roundSec,
      dev,
      teams: false,
      rules: { ...C.DEFAULT_RULES },
      startedAtMicros: 0n,
      endsAtMicros: 0n,
      lobbyAtMicros: 0n,
      roundNo: 0,
      createdAt: ctx.timestamp,
    });
    // Seed pickups from the map markers.
    for (const m of RIG7.pickups) {
      ctx.db.pickup.insert({ id: 0n, roomId: r.id, kind: m.kind, tx: m.tx, ty: m.ty, availableAtMicros: 0n });
    }
    addPlayerToRoom(ctx, r, name, false);
    console.info(`room ${code} created`);
  },
);

export const joinRoom = spacetimedb.reducer(
  { code: t.string(), name: t.string(), bot: t.bool() },
  (ctx, { code, name, bot }) => {
    const r = ctx.db.room.code.find(code.trim().toUpperCase());
    if (!r) throw new SenderError('Room not found');
    if ([...ctx.db.kicked.roomId.filter(r.id)].some((k) => k.identity.isEqual(ctx.sender))) {
      throw new SenderError('The host removed you from this room');
    }
    const existing = ctx.db.player.identity.find(ctx.sender);
    if (existing && existing.roomId === r.id) {
      // Rejoining the same room (page reload / reconnect): keep stats, adopt the new connection.
      const meta = ctx.db.pmeta.identity.find(ctx.sender);
      if (meta) ctx.db.pmeta.identity.update({ ...meta, connId: ctx.connectionId ?? undefined });
      return;
    }
    if (roomPlayers(ctx, r.id).length >= C.MAX_PLAYERS) throw new SenderError('Room is full');
    removePlayer(ctx, ctx.sender);
    addPlayerToRoom(ctx, r, name, bot);
    if (r.state === ROOM_PLAYING) {
      const p = ctx.db.player.identity.find(ctx.sender)!;
      const at = scheduleRespawn(ctx, p, C.JOIN_SPAWN_SEC);
      ctx.db.player.identity.update({ ...p, respawnAtMicros: at });
    }
  },
);

export const leaveRoom = spacetimedb.reducer((ctx) => {
  removePlayer(ctx, ctx.sender);
});

/** Host only: remove a player (or CPU) from the room; they can't rejoin this room. */
export const kickPlayer = spacetimedb.reducer({ target: t.identity() }, (ctx, { target }) => {
  const { r } = requireHost(ctx);
  if (target.isEqual(ctx.sender)) throw new SenderError("You can't kick yourself");
  const victim = ctx.db.player.identity.find(target);
  if (!victim || victim.roomId !== r.id) throw new SenderError('That player is not in your room');
  removePlayer(ctx, target);
  if (!victim.isBot) ctx.db.kicked.insert({ id: 0n, roomId: r.id, identity: target });
  ctx.db.kickEv.insert({ to: target, roomCode: r.code });
});

export const updateRoomSettings = spacetimedb.reducer(
  { mode: t.u8(), roundSec: t.u32(), teams: t.bool(), rules: Rules },
  (ctx, { mode, roundSec, teams, rules }) => {
    const { r } = requireHost(ctx);
    if (r.state === ROOM_PLAYING) throw new SenderError('Round in progress');
    if (mode > C.MODE_SNIPERS) throw new SenderError('Unknown mode');
    if (!validRoundSec(roundSec, r.dev)) throw new SenderError('Invalid round length');
    if (!validRules(rules)) throw new SenderError('Invalid house rules');
    const updated = { ...r, mode, roundSec, teams, rules };
    ctx.db.room.id.update(updated);
    if (teams !== r.teams) assignTeams(ctx, updated, teams);
  },
);

/** Team match: move yourself to the other team (lobby only). */
export const switchTeam = spacetimedb.reducer((ctx) => {
  const { p, r } = requireMember(ctx);
  if (!r.teams) throw new SenderError('This room is free-for-all');
  if (r.state === ROOM_PLAYING) throw new SenderError('Round in progress');
  ctx.db.player.identity.update({ ...p, team: p.team === C.TEAM_RED ? C.TEAM_BLUE : C.TEAM_RED });
});

/** Host only: move any player (or CPU) to the other team (lobby only). */
export const movePlayerTeam = spacetimedb.reducer({ target: t.identity() }, (ctx, { target }) => {
  const { r } = requireHost(ctx);
  if (!r.teams) throw new SenderError('This room is free-for-all');
  if (r.state === ROOM_PLAYING) throw new SenderError('Round in progress');
  const p = ctx.db.player.identity.find(target);
  if (!p || p.roomId !== r.id) throw new SenderError('That player is not in your room');
  ctx.db.player.identity.update({ ...p, team: p.team === C.TEAM_RED ? C.TEAM_BLUE : C.TEAM_RED });
});

/** Host only: return everyone to the lobby right away after a round. */
export const backToLobby = spacetimedb.reducer((ctx) => {
  const { r } = requireHost(ctx);
  if (r.state !== ROOM_ENDED) throw new SenderError('The round is not over');
  toLobby(ctx, r);
});

export const startRound = spacetimedb.reducer((ctx) => {
  const { r } = requireHost(ctx);
  if (r.state === ROOM_PLAYING) throw new SenderError('Round already running');
  const now = nowMicros(ctx);

  clearRoomJobs(ctx, r.id, true);
  for (const pk of [...ctx.db.pickup.roomId.filter(r.id)]) ctx.db.pickup.id.update({ ...pk, availableAtMicros: 0n });

  const started: RoomRow = {
    ...r,
    state: ROOM_PLAYING,
    startedAtMicros: now,
    endsAtMicros: now + BigInt(r.roundSec) * SEC,
    lobbyAtMicros: 0n,
    roundNo: r.roundNo + 1,
  };
  ctx.db.room.id.update(started);

  // Reset stats and spawn everyone at distinct points. Team match: red starts on the left half
  // of the map, blue on the right.
  const order = shuffledSpawnOrder(RIG7.spawns.length, () => ctx.random());
  const left = order.filter((i) => spawnWorldPos(RIG7.spawns[i]).x < MAP_W / 2);
  const right = order.filter((i) => spawnWorldPos(RIG7.spawns[i]).x >= MAP_W / 2);
  let li = 0, ri = 0, ai = 0;
  for (const p of roomPlayers(ctx, r.id)) {
    const reset: PlayerRow = { ...p, kills: 0, deaths: 0, score: 0, streak: 0 };
    let idx: number;
    if (r.teams && p.team === C.TEAM_RED) idx = left[li++ % left.length];
    else if (r.teams && p.team === C.TEAM_BLUE) idx = right[ri++ % right.length];
    else idx = order[ai++ % order.length];
    spawnAt(ctx, started, reset, idx);
  }
  ctx.db.roundEndJob.insert({ scheduledId: 0n, scheduledAt: atMicros(started.endsAtMicros), roomId: r.id, roundNo: started.roundNo });
});

export const choosePrimary = spacetimedb.reducer({ weapon: t.u8() }, (ctx, { weapon }) => {
  const { p } = requireMember(ctx);
  if (!isPrimary(weapon)) throw new SenderError('Not a primary weapon');
  ctx.db.player.identity.update({ ...p, primary: weapon });
});

/** Clock-sync ping. The client also reports its last measured round trip, which everyone can see. */
export const ping = spacetimedb.reducer({ clientMs: t.f64(), rttMs: t.u16() }, (ctx, { clientMs, rttMs }) => {
  if (!Number.isFinite(clientMs)) return;
  ctx.db.pongEv.insert({ to: ctx.sender, clientMs, serverMicros: nowMicros(ctx) });
  const p = ctx.db.player.identity.find(ctx.sender);
  if (p && rttMs > 0 && Math.abs(p.pingMs - rttMs) >= 3) ctx.db.player.identity.update({ ...p, pingMs: Math.min(rttMs, 9999) });
});

/** Test-only: move yourself. Only dev rooms (created with ?dev=1) accept it. */
export const devTeleport = spacetimedb.reducer({ x: t.f32(), y: t.f32() }, (ctx, { x, y }) => {
  const { p, r } = requireMember(ctx);
  if (!r.dev) throw new SenderError('Teleport is only allowed in dev rooms');
  if (!p.alive) throw new SenderError('Dead players cannot teleport');
  if (!isValidPosition(RIG7, x, y)) throw new SenderError('Invalid position');
  const now = nowMicros(ctx);
  const ps = ctx.db.pstate.identity.find(ctx.sender);
  if (ps) ctx.db.pstate.identity.update({ ...ps, x, y, vx: 0, vy: 0, serverMicros: now, sentMs: nowMs(ctx) });
  const meta = ctx.db.pmeta.identity.find(ctx.sender);
  if (meta) ctx.db.pmeta.identity.update(resetMotion(meta, x, y, now));
  // A correction makes the owning client snap its local simulation to (cx, cy).
  ctx.db.player.identity.update({ ...p, correction: p.correction + 1, cx: x, cy: y });
});

// ============================================================================
// sync: the 20 Hz movement-and-actions call
// ============================================================================

/**
 * One claimed target per shot. `angle` is the (average) direction of the rays that hit it;
 * `viewMs` is the time (sender's estimate of server time) of the target position the shooter
 * saw on screen, used for lag compensation.
 */
const HitClaim = t.object('HitClaim', { target: t.identity(), pellets: t.u8(), angle: t.f32(), viewMs: t.f64() });
const ShotIn = t.object('ShotIn', {
  weapon: t.u8(),
  ox: t.f32(),
  oy: t.f32(),
  angle: t.f32(),
  /** Tracer end points [x1, y1, x2, y2, ...] for other clients' visuals. */
  ends: t.array(t.f32()),
  hits: t.array(HitClaim),
});
type ShotRow = Infer<typeof ShotIn>;

/** Reject NaN/Infinity and absurd arrays before any of it reaches physics or a broadcast table. */
function finiteShot(s: ShotRow): boolean {
  if (!Number.isFinite(s.ox) || !Number.isFinite(s.oy) || !Number.isFinite(s.angle)) return false;
  if (s.ends.length > MAX_ENDS_FLOATS || s.ends.length % 2 !== 0) return false;
  if (s.hits.length > MAX_HITS_PER_SHOT) return false;
  for (const n of s.ends) if (!Number.isFinite(n)) return false;
  for (const h of s.hits) if (!Number.isFinite(h.angle) || !Number.isFinite(h.viewMs)) return false;
  return true;
}

const MAX_SHOTS_PER_SYNC = 4;
/** There can be at most MAX_PLAYERS - 1 targets; more claims than that are not honest. */
const MAX_HITS_PER_SHOT = 8;
const MAX_TRACER_FLOATS = 14;
/** Upper bound on the untrusted tracer array before it is parsed/relayed (9 shotgun pellets = 18). */
const MAX_ENDS_FLOATS = 42;
/** Fire-rate "burst allowance": a token bucket that forgives shots bundled into one sync. */
const FIRE_BURST_MICROS = 200_000n;
/** Below this gap a sync is treated as a duplicate burst and its movement is not applied. */
const FLOOD_GAP_MICROS = 8_000n;

export const sync = spacetimedb.reducer(
  {
    seq: t.u32(),
    life: t.u32(),
    corr: t.u32(),
    /** When this state was simulated: the client's estimate of server time (ms). */
    t: t.f64(),
    x: t.f32(),
    y: t.f32(),
    vx: t.f32(),
    vy: t.f32(),
    aim: t.f32(),
    flags: t.u8(),
    weapon: t.u8(),
    shots: t.array(ShotIn),
    melee: t.option(t.f32()),
    throwG: t.option(t.f32()),
    reload: t.bool(),
  },
  (ctx, a) => {
    // ---- 1. Ignore calls from outside a playing room, from the dead, or from an old life ----
    const me = ctx.db.player.identity.find(ctx.sender);
    if (!me || !me.alive || a.life !== me.lifeId) return;
    const r = ctx.db.room.id.find(me.roomId);
    if (!r || r.state !== ROOM_PLAYING) return;
    const ps = ctx.db.pstate.identity.find(ctx.sender);
    const meta0 = ctx.db.pmeta.identity.find(ctx.sender);
    if (!ps || !meta0) return;
    const now = nowMicros(ctx);
    const p: PlayerRow = { ...me };
    const meta: MetaRow = { ...meta0, lastFire: [...meta0.lastFire], histT: [...meta0.histT], histX: [...meta0.histX], histY: [...meta0.histY] };
    const fmul = frenzyMul(r, now);

    // ---- 1b. Untrusted numbers must be finite (NaN would poison pstate, events and grenades) ----
    if (!Number.isFinite(a.x) || !Number.isFinite(a.y) || !Number.isFinite(a.vx) || !Number.isFinite(a.vy) || !Number.isFinite(a.aim)) {
      return rejected(r, 'sync: non-finite movement');
    }
    if (a.melee !== undefined && !Number.isFinite(a.melee)) return rejected(r, 'sync: non-finite melee angle');
    if (a.throwG !== undefined && !Number.isFinite(a.throwG)) return rejected(r, 'sync: non-finite throw angle');
    for (const s of a.shots) if (!finiteShot(s)) return rejected(r, 'sync: malformed shot');

    // ---- 2. Movement check, on the CLIENT's timeline ----
    // Packets bunch up on real networks (two syncs sent 50 ms apart can arrive 5 ms apart), so
    // the time between two positions is measured with the client's own timestamps. To stop a
    // client from claiming extra time (a speed hack), the total extra time it may claim over
    // the server's own clock is capped (time debt, 350 ms).
    // `corr` must match the server's correction counter: until the client has snapped back,
    // its positions are stale.
    let pos = { x: ps.x, y: ps.y };
    const gap = now - meta.lastSyncMicros;
    if (gap >= FLOOD_GAP_MICROS && a.corr === p.correction && Number.isFinite(a.t)) {
      meta.lastSyncMicros = now;
      const serverDt = Math.min(Number(now - ps.serverMicros) / 1e6, C.MOVE_MAX_DT_SEC);
      let clientDt = meta.lastClientMs > 0 ? (a.t - meta.lastClientMs) / 1000 : serverDt;
      clientDt = Math.max(0, Math.min(clientDt, C.MOVE_MAX_DT_SEC));
      let debt = meta.timeDebtMs / 1000 + (clientDt - serverDt);
      const maxDebt = C.TIME_DEBT_MAX_MS / 1000;
      if (debt > maxDebt) {
        clientDt = Math.max(0, clientDt - (debt - maxDebt));
        debt = maxDebt;
      }
      debt = Math.max(-1, debt);
      const dt = Math.max(clientDt, Math.min(serverDt, clientDt + 0.1));
      if (validateMove(RIG7, pos, { x: a.x, y: a.y }, dt)) {
        meta.prevX = ps.x;
        meta.prevY = ps.y;
        meta.prevMicros = ps.serverMicros;
        meta.lastClientMs = a.t;
        meta.timeDebtMs = debt * 1000;
        // The client's timestamp may not be far from the server's clock.
        const sentMs = Math.min(Math.max(a.t, Number(now) / 1000 - 1500), Number(now) / 1000 + 150);
        meta.histT.push(sentMs);
        meta.histX.push(a.x);
        meta.histY.push(a.y);
        if (meta.histT.length > C.HISTORY_LEN) {
          meta.histT.shift();
          meta.histX.shift();
          meta.histY.shift();
        }
        pos = { x: a.x, y: a.y };
        const reloading = p.reloadUntilMicros > 0n ? C.FLAG_RELOADING : 0;
        ctx.db.pstate.identity.update({
          ...ps,
          x: a.x,
          y: a.y,
          vx: a.vx,
          vy: a.vy,
          aim: a.aim,
          flags: (a.flags & ~C.FLAG_RELOADING) | reloading,
          weapon: p.weapon,
          seq: a.seq,
          serverMicros: now,
          sentMs,
        });
      } else {
        // Rejected: tell the client to snap back to the last accepted position.
        rejected(r, `move to (${a.x.toFixed(0)},${a.y.toFixed(0)}) from (${ps.x.toFixed(0)},${ps.y.toFixed(0)}) in ${dt.toFixed(3)} s`);
        p.correction += 1;
        p.cx = ps.x;
        p.cy = ps.y;
      }
    }

    // ---- 3. Finish a pending reload ----
    if (p.reloadUntilMicros > 0n && now >= p.reloadUntilMicros) finishReload(p);

    // ---- 4. Acid hazard ----
    const hazardDt = Math.min(Number(now - meta.lastHazardMicros) / 1e6, C.SYNC_MAX_DT_SEC);
    meta.lastHazardMicros = now;
    if (r.rules.acid && boxTouchesTile(RIG7, pos.x - C.PLAYER_W / 2, pos.y - C.PLAYER_H, pos.x + C.PLAYER_W / 2, pos.y, T_ACID)) {
      applyDamage(ctx, p, C.ACID_DPS * hazardDt, p.identity, C.CAUSE_ACID);
    }

    // ---- 5. Pickups ----
    if (p.alive) collectPickups(ctx, r, p, pos, now);

    // ---- 6. Actions: weapon switch, reload, shots, melee, throw ----
    if (p.alive) {
      const allowed = allowedWeapons(r.mode, p.primary);
      if (a.weapon !== p.weapon && allowed.includes(a.weapon)) {
        p.weapon = a.weapon;
        p.reloadUntilMicros = 0n; // switching cancels a reload
      }
      if (a.reload && !r.rules.infiniteAmmo) startReload(p, now);
      for (const shot of a.shots.slice(0, MAX_SHOTS_PER_SYNC)) {
        if (!p.alive) break;
        handleShot(ctx, r, p, meta, pos, shot, now, fmul);
      }
      if (a.melee !== undefined && p.alive) handleMelee(ctx, r, p, meta, pos, a.melee, now, fmul);
      if (a.throwG !== undefined && p.alive) handleThrow(ctx, r, p, meta, pos, ps, a.throwG, now);
    }

    ctx.db.player.identity.update(p);
    ctx.db.pmeta.identity.update(meta);
  },
);

function finishReload(p: PlayerRow): void {
  p.reloadUntilMicros = 0n;
  if (p.weapon === W_PISTOL) {
    p.pistolMag = WEAPONS[W_PISTOL].mag;
  } else if (isPrimary(p.weapon)) {
    const need = WEAPONS[p.weapon].mag - p.mag;
    const take = Math.min(need, p.reserve);
    p.mag += take;
    p.reserve -= take;
  }
}

function startReload(p: PlayerRow, now: bigint): void {
  if (!isGun(p.weapon) || p.reloadUntilMicros > 0n) return;
  const w = WEAPONS[p.weapon];
  if (p.weapon === W_PISTOL) {
    if (p.pistolMag >= w.mag) return;
  } else if (p.mag >= w.mag || p.reserve <= 0) {
    return;
  }
  p.reloadUntilMicros = now + secToMicros(w.reloadSec);
}

function collectPickups(ctx: Ctx, r: RoomRow, p: PlayerRow, pos: { x: number; y: number }, now: bigint): void {
  if (!r.rules.pickups) return;
  const left = pos.x - C.PLAYER_W / 2;
  const right = pos.x + C.PLAYER_W / 2;
  const top = pos.y - C.PLAYER_H;
  for (const pk of ctx.db.pickup.roomId.filter(r.id)) {
    if (pk.availableAtMicros !== 0n) continue;
    if (!pickupActive(r.mode, pk.kind)) continue;
    const px = pk.tx * C.TILE;
    const py = pk.ty * C.TILE;
    if (right <= px || left >= px + C.PICKUP_SIZE || pos.y <= py || top >= py + C.PICKUP_SIZE) continue;

    // Only consume a pickup that actually helps.
    if (pk.kind === PICKUP_HEALTH) {
      if (p.hp >= r.rules.maxHp) continue;
      p.hp = Math.min(r.rules.maxHp, p.hp + C.HEALTH_PACK_HP);
    } else if (pk.kind === PICKUP_AMMO) {
      const full = primaryReserve(effectivePrimary(r.mode, p.primary));
      if (p.reserve >= full) continue;
      p.reserve = full;
    } else if (pk.kind === PICKUP_GRENADE) {
      if (p.grenades >= C.GRENADE_CRATE_MAX) continue;
      p.grenades += 1;
    }
    const at = now + secToMicros(C.PICKUP_RESPAWN_SEC);
    ctx.db.pickup.id.update({ ...pk, availableAtMicros: at });
    ctx.db.pickupJob.insert({ scheduledId: 0n, scheduledAt: atMicros(at), pickupId: pk.id, roomId: r.id });
    ctx.db.pickupEv.insert({ roomId: r.id, identity: p.identity, kind: pk.kind, pickupId: pk.id });
  }
}

/**
 * Lag compensation: where could the target have been when the shooter saw it?
 * The shooter tells us the time of the target position it saw (viewMs). We look that time up in
 * the target's recent position history (interpolating between samples), and also accept the
 * neighbouring samples and the current/previous positions, all within LAGCOMP_MAX_MS.
 */
function lagCompPositions(meta: MetaRow | null, ps: PStateRow, viewMs: number, nowMs_: number): Point[] {
  const out: Point[] = [{ x: ps.x, y: ps.y }];
  if (!meta) return out;
  out.push({ x: meta.prevX, y: meta.prevY });
  const view = Math.min(Math.max(viewMs, nowMs_ - C.LAGCOMP_MAX_MS), nowMs_ + 50);
  const T = meta.histT;
  for (let i = 0; i < T.length; i++) {
    if (Math.abs(T[i] - view) <= 120) out.push({ x: meta.histX[i], y: meta.histY[i] });
    if (i + 1 < T.length && T[i] <= view && view <= T[i + 1] && T[i + 1] > T[i]) {
      const f = (view - T[i]) / (T[i + 1] - T[i]);
      out.push({ x: meta.histX[i] + (meta.histX[i + 1] - meta.histX[i]) * f, y: meta.histY[i] + (meta.histY[i + 1] - meta.histY[i]) * f });
    }
  }
  return out;
}

/** Validate one shot (section 6, "favour the shooter within tolerances") and apply its hits. */
function handleShot(ctx: Ctx, r: RoomRow, p: PlayerRow, meta: MetaRow, pos: { x: number; y: number }, shot: ShotRow, now: bigint, fmul: number): void {
  const wid = shot.weapon;
  if (!isGun(wid) || wid !== p.weapon || !allowedWeapons(r.mode, p.primary).includes(wid)) return rejected(r, 'shot: weapon not equipped');
  if (p.reloadUntilMicros > 0n) return rejected(r, 'shot: reloading');
  const w = WEAPONS[wid];
  if (!fireRateOk(meta.lastFire[wid], now, w.rate)) return rejected(r, 'shot: too fast');
  const magLeft = wid === W_PISTOL ? p.pistolMag : p.mag;
  if (magLeft <= 0 && !r.rules.infiniteAmmo) return rejected(r, 'shot: empty');
  // The shot may have been fired before this sync's movement (e.g. shotgun recoil moved the
  // shooter since), so the origin may be near the current OR the previous accepted position.
  if (!shotOriginOk(pos, shot.ox, shot.oy) && !shotOriginOk({ x: meta.prevX, y: meta.prevY }, shot.ox, shot.oy)) return rejected(r, `shot: origin (${shot.ox.toFixed(0)},${shot.oy.toFixed(0)}) far from (${pos.x.toFixed(0)},${pos.y.toFixed(0)})`);

  // Accepted: spend ammo and advance the fire-rate token bucket.
  if (!r.rules.infiniteAmmo) {
    if (wid === W_PISTOL) p.pistolMag -= 1;
    else p.mag -= 1;
  }
  const minGap = secToMicros(C.FIRE_RATE_TOLERANCE / w.rate);
  const floor = now - FIRE_BURST_MICROS;
  const advanced = meta.lastFire[wid] + minGap;
  meta.lastFire[wid] = advanced > floor ? advanced : floor;
  p.spawnProtectUntilMicros = 0n; // firing ends spawn protection

  const nowMs_ = Number(now) / 1000;
  const seen = new Set<string>();
  for (const claim of shot.hits.slice(0, MAX_HITS_PER_SHOT)) {
    const key = claim.target.toHexString();
    if (seen.has(key)) continue;
    seen.add(key);
    if (claim.target.isEqual(p.identity)) continue;
    const target = ctx.db.player.identity.find(claim.target);
    if (!target || target.roomId !== r.id || !target.alive || isProtected(target, now)) continue;
    if (!canHurt(r, p, target)) continue; // teammate with friendly fire off
    const tps = ctx.db.pstate.identity.find(target.identity);
    const tmeta = ctx.db.pmeta.identity.find(target.identity) ?? null;
    if (!tps) continue;
    // Cover wins: the target's CURRENT server position must be in line of sight.
    if (!lineOfSight(RIG7, shot.ox, shot.oy, tps.x, tps.y - C.PLAYER_H / 2)) { rejected(r, 'hit claim: target is behind cover now'); continue; }
    // The ray and range are checked against where the shooter saw the target (lag compensation).
    let d = -1;
    for (const at of lagCompPositions(tmeta, tps, claim.viewMs, nowMs_)) {
      d = hitClaimDistance(RIG7, w, shot.ox, shot.oy, claim.angle, at);
      if (d >= 0) break;
    }
    if (d < 0) { rejected(r, 'hit claim: out of range or off the ray'); continue; }
    const pellets = Math.max(1, Math.min(claim.pellets, w.pellets));
    const dmg = pellets * damageAtDistance(w, d) * fmul;
    const res = damageOther(ctx, r, p, target, dmg, wid);
    if (res.killed) creditKill(p, res);
  }
  ctx.db.shotEv.insert({ roomId: r.id, shooter: p.identity, weapon: wid, x0: shot.ox, y0: shot.oy, ends: shot.ends.slice(0, MAX_TRACER_FLOATS) });
}

/** Melee: the server finds targets itself. */
function handleMelee(ctx: Ctx, r: RoomRow, p: PlayerRow, meta: MetaRow, pos: { x: number; y: number }, angle: number, now: bigint, fmul: number): void {
  const knife = WEAPONS[W_KNIFE];
  if (!fireRateOk(meta.lastMeleeMicros, now, knife.rate)) return;
  meta.lastMeleeMicros = now;
  p.spawnProtectUntilMicros = 0n;
  ctx.db.meleeEv.insert({ roomId: r.id, attacker: p.identity, x: pos.x, y: pos.y - C.PLAYER_H / 2, dir: angle });
  const attackerPositions = [pos, { x: meta.prevX, y: meta.prevY }];
  for (const target of roomPlayers(ctx, r.id)) {
    if (target.identity.isEqual(p.identity) || !target.alive || isProtected(target, now) || !canHurt(r, p, target)) continue;
    const tps = ctx.db.pstate.identity.find(target.identity);
    const tmeta = ctx.db.pmeta.identity.find(target.identity);
    if (!tps) continue;
    const targetPositions = [{ x: tps.x, y: tps.y }];
    if (tmeta) targetPositions.push({ x: tmeta.prevX, y: tmeta.prevY });
    const hit = attackerPositions.some((ap) => targetPositions.some((tp) => meleeHits(RIG7, ap, angle, tp)));
    if (!hit) continue;
    const res = damageOther(ctx, r, p, target, knife.damage * fmul, W_KNIFE);
    if (res.killed) creditKill(p, res);
  }
}

function handleThrow(ctx: Ctx, r: RoomRow, p: PlayerRow, meta: MetaRow, pos: { x: number; y: number }, ps: PStateRow, angle: number, now: bigint): void {
  if (!canThrow(r.mode)) return;
  if (r.mode === C.MODE_ARMS) {
    if ((p.grenades <= 0 && !r.rules.infiniteAmmo) || !fireRateOk(meta.lastThrowMicros, now, 1 / C.GRENADE_COOLDOWN_ARMS)) return;
  } else {
    if (!fireRateOk(meta.lastThrowMicros, now, 1 / C.GRENADE_COOLDOWN_BOOM)) return;
    const live = [...ctx.db.grenade.owner.filter(p.identity)].length;
    if (live >= C.GRENADE_BOOM_MAX_LIVE) return;
  }
  meta.lastThrowMicros = now;
  if (r.mode === C.MODE_ARMS && !r.rules.infiniteAmmo) p.grenades -= 1;
  p.spawnProtectUntilMicros = 0n;

  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const cx = pos.x;
  const cy = pos.y - C.PLAYER_H / 2;
  let x0 = cx + dx * C.HAND_OFFSET;
  let y0 = cy + dy * C.HAND_OFFSET;
  // Never start a grenade inside a wall: fall back to the player's centre.
  const R = C.GRENADE_RADIUS;
  if (boxTouchesTile(RIG7, x0 - R, y0 - R, x0 + R, y0 + R, T_SOLID) || !lineOfSight(RIG7, cx, cy, x0, y0)) {
    x0 = cx;
    y0 = cy;
  }
  const vx0 = dx * C.GRENADE_THROW_SPEED + ps.vx * C.GRENADE_INHERIT;
  const vy0 = dy * C.GRENADE_THROW_SPEED + ps.vy * C.GRENADE_INHERIT;
  const g = ctx.db.grenade.insert({ id: 0n, roomId: r.id, owner: p.identity, x0, y0, vx0, vy0, thrownMicros: now, fuseMs: C.GRENADE_FUSE_MS, zeroG: r.rules.floatingGrenades });
  ctx.db.detonateJob.insert({ scheduledId: 0n, scheduledAt: atMicros(now + BigInt(C.GRENADE_FUSE_MS) * 1000n), grenadeId: g.id, roomId: r.id });
}

// ============================================================================
// Scheduled reducers (private: only the scheduler can call them)
// ============================================================================

export const doRespawn = spacetimedb.reducer({ onSchedule: respawnJob }, { job: respawnJob.rowType }, (ctx, { job }) => {
  if (!ctx.senderAuth.isInternal) throw new SenderError('Scheduler only');
  const p = ctx.db.player.identity.find(job.identity);
  if (!p || p.alive || p.lifeId !== job.lifeId || p.roomId !== job.roomId) return;
  const r = ctx.db.room.id.find(p.roomId);
  if (!r || r.state !== ROOM_PLAYING) return;
  respawnPlayer(ctx, r, p);
});

export const endRound = spacetimedb.reducer({ onSchedule: roundEndJob }, { job: roundEndJob.rowType }, (ctx, { job }) => {
  if (!ctx.senderAuth.isInternal) throw new SenderError('Scheduler only');
  const r = ctx.db.room.id.find(job.roomId);
  if (!r || r.roundNo !== job.roundNo || r.state !== ROOM_PLAYING) return;
  // Show the results for a few seconds, then everyone returns to the lobby automatically.
  const lobbyAt = nowMicros(ctx) + secToMicros(C.LOBBY_RETURN_SEC);
  ctx.db.room.id.update({ ...r, state: ROOM_ENDED, lobbyAtMicros: lobbyAt });
  ctx.db.lobbyJob.insert({ scheduledId: 0n, scheduledAt: atMicros(lobbyAt), roomId: r.id, roundNo: r.roundNo });
  clearRoomJobs(ctx, r.id, false);
  // Stats stay for the leaderboard; mark everyone dead so nobody keeps playing.
  for (const p of roomPlayers(ctx, r.id)) {
    ctx.db.player.identity.update({ ...p, alive: false, respawnAtMicros: 0n, reloadUntilMicros: 0n });
  }
});

export const returnToLobby = spacetimedb.reducer({ onSchedule: lobbyJob }, { job: lobbyJob.rowType }, (ctx, { job }) => {
  if (!ctx.senderAuth.isInternal) throw new SenderError('Scheduler only');
  const r = ctx.db.room.id.find(job.roomId);
  if (!r || r.roundNo !== job.roundNo || r.state !== ROOM_ENDED) return;
  toLobby(ctx, r);
});

export const detonate = spacetimedb.reducer({ onSchedule: detonateJob }, { job: detonateJob.rowType }, (ctx, { job }) => {
  if (!ctx.senderAuth.isInternal) throw new SenderError('Scheduler only');
  const g = ctx.db.grenade.id.find(job.grenadeId);
  if (!g) return;
  ctx.db.grenade.id.delete(g.id);
  const r = ctx.db.room.id.find(g.roomId);
  if (!r || r.state !== ROOM_PLAYING) return;
  const now = nowMicros(ctx);

  // Re-run the exact client simulation on the stored f32 start values to find the blast point.
  const end = simulateGrenade(RIG7, g.x0, g.y0, g.vx0, g.vy0, fuseTicks(g.fuseMs), { x: 0, y: 0, vx: 0, vy: 0 }, g.zeroG);
  const bx = Math.min(Math.max(end.x, 0), MAP_W);
  const by = Math.min(Math.max(end.y, 0), MAP_H);
  ctx.db.boomEv.insert({ roomId: r.id, owner: g.owner, x: bx, y: by });

  const owner = ctx.db.player.identity.find(g.owner);
  const fmul = frenzyMul(r, now);
  for (const target of roomPlayers(ctx, r.id)) {
    if (!target.alive || isProtected(target, now)) continue;
    if (owner && !canHurt(r, owner, target)) continue;
    const c = centreOf(ctx, target.identity);
    if (!c) continue;
    const d = Math.hypot(c.x - bx, c.y - by);
    if (d >= C.GRENADE_BLAST_RADIUS || !lineOfSight(RIG7, bx, by, c.x, c.y)) continue;
    const own = target.identity.isEqual(g.owner);
    const dmg = grenadeDamage(C.GRENADE_MAX_DAMAGE, C.GRENADE_BLAST_RADIUS, d) * fmul * (own ? C.GRENADE_SELF_DAMAGE_MUL : 1);
    if (!owner) {
      // The thrower left the room: the blast still hurts, but nobody gets credit.
      const victim = { ...target };
      applyDamage(ctx, victim, dmg, g.owner, W_FRAG);
      ctx.db.player.identity.update(victim);
      continue;
    }
    const res = damageOther(ctx, r, owner, target, dmg, W_FRAG);
    if (res.killed && !own) {
      const killer = ctx.db.player.identity.find(g.owner);
      if (killer) {
        const k = { ...killer };
        creditKill(k, res);
        ctx.db.player.identity.update(k);
      }
    }
  }
});

export const restorePickup = spacetimedb.reducer({ onSchedule: pickupJob }, { job: pickupJob.rowType }, (ctx, { job }) => {
  if (!ctx.senderAuth.isInternal) throw new SenderError('Scheduler only');
  const pk = ctx.db.pickup.id.find(job.pickupId);
  if (pk) ctx.db.pickup.id.update({ ...pk, availableAtMicros: 0n });
});

// ============================================================================
// Lifecycle
// ============================================================================

export const onConnect = spacetimedb.clientConnected((ctx) => {
  console.info(`client connected ${ctx.sender.toHexString().slice(0, 8)}`);
});

export const onDisconnect = spacetimedb.clientDisconnected((ctx) => {
  const meta = ctx.db.pmeta.identity.find(ctx.sender);
  // Only clean up if this connection is the one that owns the player row. A page reload may
  // already have rejoined on a new connection before the old one's disconnect arrives.
  if (meta && meta.connId && ctx.connectionId && !meta.connId.isEqual(ctx.connectionId)) return;
  removePlayer(ctx, ctx.sender);
});
