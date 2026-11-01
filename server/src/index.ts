// THRUSTLINE SpacetimeDB module: the referee.
// Clients simulate and own their own movement; this module validates every update and owns
// everything that decides the match (HP, deaths, kills, score, ammo, pickups, grenades,
// spawns and the clock). There is no continuous tick: timed things are one-shot schedules,
// and everything else happens inside the 20 Hz `sync` reducer.
import { schema, table, t, SenderError, type Infer, type InferSchema, type ReducerCtx } from 'spacetimedb/server';
import { ScheduleAt, type Identity } from 'spacetimedb';
import * as C from './shared/config';
import { MAP_H, MAP_W, PICKUP_AMMO, PICKUP_GRENADE, PICKUP_HEALTH, RIG7, T_ACID, T_SOLID, boxTouchesTile, spawnWorldPos } from './shared/map';
import { WEAPONS, W_FRAG, W_KNIFE, W_PISTOL, PRIMARIES, allowedWeapons, damageAtDistance, defaultWeapon, grenadeDamage, isGun, isPrimary } from './shared/weapons';
import { fuseTicks, simulateGrenade } from './shared/grenade';
import { pickSpawn, shuffledSpawnOrder, type Point } from './shared/spawn';
import { lineOfSight } from './shared/raycast';
import { fireRateOk, hitClaimDistance, isValidPosition, meleeHits, shotOriginOk, validateMove } from './shared/validate';

// ============================================================================
// Tables
// ============================================================================

const ROOM_LOBBY = 0;
const ROOM_PLAYING = 1;
const ROOM_ENDED = 2;

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
    startedAtMicros: t.i64(),
    endsAtMicros: t.i64(),
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
  { roomId: t.u64(), killer: t.identity(), victim: t.identity(), cause: t.u8(), bounty: t.bool() },
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

const spacetimedb = schema({
  room,
  player,
  pstate,
  pmeta,
  pickup,
  grenade,
  respawnJob,
  roundEndJob,
  detonateJob,
  pickupJob,
  shotEv,
  hitEv,
  killEv,
  meleeEv,
  boomEv,
  pickupEv,
  pongEv,
});
export default spacetimedb;

type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;
type RoomRow = Infer<typeof room.rowType>;
type PlayerRow = Infer<typeof player.rowType>;

// ============================================================================
// Small helpers
// ============================================================================

const SEC = 1_000_000n; // microseconds per second
const secToMicros = (s: number) => BigInt(Math.round(s * 1e6));
const nowMicros = (ctx: Ctx) => ctx.timestamp.microsSinceUnixEpoch;
const atMicros = (micros: bigint) => ScheduleAt.time(micros);

/** Trim to 16 chars and remove control characters. */
function cleanName(raw: string): string {
  const name = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, C.NAME_MAX).trim();
  return name.length > 0 ? name : 'Rigger';
}

function frenzyMul(r: RoomRow, now: bigint): number {
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
    hp: C.MAX_HP,
    lifeId: p.lifeId + 1,
    weapon: defaultWeapon(r.mode, p.primary),
    mag: primaryMag(p.primary),
    reserve: primaryReserve(p.primary),
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
    ctx.db.pstate.identity.update({ ...ps, x: pos.x, y: pos.y, vx: 0, vy: 0, flags: C.FLAG_GROUNDED, weapon: updated.weapon, serverMicros: now });
  }
  const meta = ctx.db.pmeta.identity.find(p.identity);
  if (meta) {
    ctx.db.pmeta.identity.update({ ...meta, prevX: pos.x, prevY: pos.y, prevMicros: now, lastSyncMicros: now, lastHazardMicros: now, hasDeath: false });
  }
  return updated;
}

/** Choose a spawn with the smart-spawn rules (section 4) and spawn the player there. */
function respawnPlayer(ctx: Ctx, r: RoomRow, p: PlayerRow): void {
  const meta = ctx.db.pmeta.identity.find(p.identity);
  const death = meta && meta.hasDeath ? { x: meta.deathX, y: meta.deathY } : null;
  const enemies: Point[] = [];
  for (const other of roomPlayers(ctx, r.id)) {
    if (other.alive && !other.identity.isEqual(p.identity)) {
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
}

/**
 * applyDamage: subtract HP from `victim` (a mutable copy the caller writes back), emit hit_ev,
 * and on death handle everything about the victim's side of the kill. Kill credit for the
 * attacker is applied by the caller via creditKill(), because the caller may hold the
 * attacker's row as an unsaved local copy.
 */
function applyDamage(ctx: Ctx, victim: PlayerRow, amount: number, attacker: Identity, cause: number): KillResult {
  const result: KillResult = { killed: false, bounty: false };
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
  result.bounty = victim.streak >= C.BOUNTY_STREAK && !selfInflicted;
  victim.alive = false;
  victim.deaths += 1;
  victim.streak = 0;
  victim.reloadUntilMicros = 0n;
  if (selfInflicted) victim.score += C.SCORE_SELF_DEATH;
  victim.respawnAtMicros = scheduleRespawn(ctx, victim, C.RESPAWN_SEC);
  const meta = ctx.db.pmeta.identity.find(victim.identity);
  if (meta && pos) ctx.db.pmeta.identity.update({ ...meta, hasDeath: true, deathX: pos.x, deathY: pos.y });
  ctx.db.killEv.insert({ roomId: victim.roomId, killer: attacker, victim: victim.identity, cause, bounty: result.bounty });
  return result;
}

/** Give the attacker credit for a kill of another player. */
function creditKill(p: PlayerRow, bounty: boolean): void {
  p.kills += 1;
  p.score += C.SCORE_KILL + (bounty ? C.SCORE_BOUNTY_BONUS : 0);
  p.streak += 1;
}

/** Damage another player identified by row; writes the victim; returns whether they died. */
function damageOther(ctx: Ctx, target: PlayerRow, amount: number, attacker: Identity, cause: number): KillResult {
  const victim = { ...target };
  const res = applyDamage(ctx, victim, amount, attacker, cause);
  ctx.db.player.identity.update(victim);
  return res;
}

function isProtected(p: PlayerRow, now: bigint): boolean {
  return p.spawnProtectUntilMicros > now;
}

// ============================================================================
// Room membership
// ============================================================================

function lowestFreeColor(ctx: Ctx, roomId: bigint): number {
  const used = new Set(roomPlayers(ctx, roomId).map((p) => p.colorIdx));
  for (let i = 0; i < C.MAX_PLAYERS; i++) if (!used.has(i)) return i;
  return 0;
}

function addPlayerToRoom(ctx: Ctx, r: RoomRow, name: string, isBot: boolean): void {
  const now = nowMicros(ctx);
  const start = spawnWorldPos(RIG7.spawns[0]);
  const primary = PRIMARIES[0];
  ctx.db.player.insert({
    identity: ctx.sender,
    roomId: r.id,
    name: cleanName(name),
    colorIdx: lowestFreeColor(ctx, r.id),
    isBot,
    joinedAt: ctx.timestamp,
    alive: false,
    hp: C.MAX_HP,
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
  });
  ctx.db.pstate.insert({ identity: ctx.sender, roomId: r.id, x: start.x, y: start.y, vx: 0, vy: 0, aim: 0, flags: 0, weapon: 0, seq: 0, serverMicros: now });
  ctx.db.pmeta.insert({
    identity: ctx.sender,
    connId: ctx.connectionId ?? undefined,
    lastSyncMicros: 0n,
    lastHazardMicros: now,
    prevX: start.x,
    prevY: start.y,
    prevMicros: now,
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
  if (rest.length === 0) {
    deleteRoom(ctx, r.id);
  } else if (r.hostIdentity.isEqual(identity)) {
    // Hand host to the earliest-joined remaining human (bots only if no humans remain).
    rest.sort((a, b) => Number(a.isBot) - Number(b.isBot) || (a.joinedAt.microsSinceUnixEpoch < b.joinedAt.microsSinceUnixEpoch ? -1 : 1));
    ctx.db.room.id.update({ ...r, hostIdentity: rest[0].identity });
  }
}

function clearRoomJobs(ctx: Ctx, roomId: bigint, includePickups: boolean): void {
  for (const j of [...ctx.db.respawnJob.roomId.filter(roomId)]) ctx.db.respawnJob.scheduledId.delete(j.scheduledId);
  for (const j of [...ctx.db.detonateJob.roomId.filter(roomId)]) ctx.db.detonateJob.scheduledId.delete(j.scheduledId);
  for (const g of [...ctx.db.grenade.roomId.filter(roomId)]) ctx.db.grenade.id.delete(g.id);
  if (includePickups) {
    for (const j of [...ctx.db.pickupJob.roomId.filter(roomId)]) ctx.db.pickupJob.scheduledId.delete(j.scheduledId);
    for (const j of [...ctx.db.roundEndJob.roomId.filter(roomId)]) ctx.db.roundEndJob.scheduledId.delete(j.scheduledId);
  }
}

function deleteRoom(ctx: Ctx, roomId: bigint): void {
  clearRoomJobs(ctx, roomId, true);
  for (const pk of [...ctx.db.pickup.roomId.filter(roomId)]) ctx.db.pickup.id.delete(pk.id);
  ctx.db.room.id.delete(roomId);
}

function requireMember(ctx: Ctx): { p: PlayerRow; r: RoomRow } {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) throw new SenderError('You are not in a room');
  const r = ctx.db.room.id.find(p.roomId);
  if (!r) throw new SenderError('Room not found');
  return { p, r };
}

function validRoundSec(sec: number, dev: boolean): boolean {
  return C.ROUND_LENGTHS_SEC.includes(sec) || (dev && sec === C.DEV_ROUND_SEC);
}

// ============================================================================
// Lobby reducers
// ============================================================================

export const createRoom = spacetimedb.reducer(
  { name: t.string(), mode: t.u8(), roundSec: t.u32(), dev: t.bool() },
  (ctx, { name, mode, roundSec, dev }) => {
    if (mode > C.MODE_BOOM) throw new SenderError('Unknown mode');
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
      startedAtMicros: 0n,
      endsAtMicros: 0n,
      roundNo: 0,
      createdAt: ctx.timestamp,
    });
    // Seed pickups from the map markers.
    for (const m of RIG7.pickups) {
      ctx.db.pickup.insert({ id: 0n, roomId: r.id, kind: m.kind, tx: m.tx, ty: m.ty, availableAtMicros: 0n });
    }
    addPlayerToRoom(ctx, r, name, false);
    console.info(`room ${code} created by ${cleanName(name)}`);
  },
);

export const joinRoom = spacetimedb.reducer(
  { code: t.string(), name: t.string(), bot: t.bool() },
  (ctx, { code, name, bot }) => {
    const r = ctx.db.room.code.find(code.trim().toUpperCase());
    if (!r) throw new SenderError('Room not found');
    const existing = ctx.db.player.identity.find(ctx.sender);
    if (existing && existing.roomId === r.id) {
      // Rejoining the same room (page reload / reconnect): keep stats, adopt the new connection.
      ctx.db.player.identity.update({ ...existing, name: cleanName(name) });
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

export const updateRoomSettings = spacetimedb.reducer(
  { mode: t.u8(), roundSec: t.u32() },
  (ctx, { mode, roundSec }) => {
    const { r } = requireMember(ctx);
    if (!r.hostIdentity.isEqual(ctx.sender)) throw new SenderError('Only the host can change settings');
    if (r.state === ROOM_PLAYING) throw new SenderError('Round in progress');
    if (mode > C.MODE_BOOM) throw new SenderError('Unknown mode');
    if (!validRoundSec(roundSec, r.dev)) throw new SenderError('Invalid round length');
    ctx.db.room.id.update({ ...r, mode, roundSec });
  },
);

export const startRound = spacetimedb.reducer((ctx) => {
  const { r } = requireMember(ctx);
  if (!r.hostIdentity.isEqual(ctx.sender)) throw new SenderError('Only the host can start');
  if (r.state === ROOM_PLAYING) throw new SenderError('Round already running');
  const now = nowMicros(ctx);

  clearRoomJobs(ctx, r.id, true);
  for (const pk of [...ctx.db.pickup.roomId.filter(r.id)]) ctx.db.pickup.id.update({ ...pk, availableAtMicros: 0n });

  const started: RoomRow = {
    ...r,
    state: ROOM_PLAYING,
    startedAtMicros: now,
    endsAtMicros: now + BigInt(r.roundSec) * SEC,
    roundNo: r.roundNo + 1,
  };
  ctx.db.room.id.update(started);

  // Reset stats and spawn everyone at distinct points.
  const order = shuffledSpawnOrder(RIG7.spawns.length, () => ctx.random());
  roomPlayers(ctx, r.id).forEach((p, i) => {
    const reset: PlayerRow = { ...p, kills: 0, deaths: 0, score: 0, streak: 0 };
    spawnAt(ctx, started, reset, order[i % order.length]);
  });
  ctx.db.roundEndJob.insert({ scheduledId: 0n, scheduledAt: atMicros(started.endsAtMicros), roomId: r.id, roundNo: started.roundNo });
});

export const choosePrimary = spacetimedb.reducer({ weapon: t.u8() }, (ctx, { weapon }) => {
  const { p } = requireMember(ctx);
  if (!isPrimary(weapon)) throw new SenderError('Not a primary weapon');
  ctx.db.player.identity.update({ ...p, primary: weapon });
});

export const ping = spacetimedb.reducer({ clientMs: t.f64() }, (ctx, { clientMs }) => {
  ctx.db.pongEv.insert({ to: ctx.sender, clientMs, serverMicros: nowMicros(ctx) });
});

/** Test-only: move yourself. Only dev rooms (created with ?dev=1) accept it. */
export const devTeleport = spacetimedb.reducer({ x: t.f32(), y: t.f32() }, (ctx, { x, y }) => {
  const { p, r } = requireMember(ctx);
  if (!r.dev) throw new SenderError('Teleport is only allowed in dev rooms');
  if (!p.alive) throw new SenderError('Dead players cannot teleport');
  if (!isValidPosition(RIG7, x, y)) throw new SenderError('Invalid position');
  const now = nowMicros(ctx);
  const ps = ctx.db.pstate.identity.find(ctx.sender);
  if (ps) ctx.db.pstate.identity.update({ ...ps, x, y, vx: 0, vy: 0, serverMicros: now });
  const meta = ctx.db.pmeta.identity.find(ctx.sender);
  if (meta) ctx.db.pmeta.identity.update({ ...meta, prevX: x, prevY: y, prevMicros: now });
  // A correction makes the owning client snap its local simulation to (cx, cy).
  ctx.db.player.identity.update({ ...p, correction: p.correction + 1, cx: x, cy: y });
});

// ============================================================================
// sync: the 20 Hz movement-and-actions call
// ============================================================================

/** One claimed target per shot; `angle` is the (average) direction of the rays that hit it. */
const HitClaim = t.object('HitClaim', { target: t.identity(), pellets: t.u8(), angle: t.f32() });
const ShotIn = t.object('ShotIn', {
  weapon: t.u8(),
  ox: t.f32(),
  oy: t.f32(),
  angle: t.f32(),
  /** Tracer end points [x1, y1, x2, y2, ...] for other clients' visuals. */
  ends: t.array(t.f32()),
  hits: t.array(HitClaim),
});

const MAX_SHOTS_PER_SYNC = 4;
const MAX_TRACER_FLOATS = 14;
/** Fire-rate "burst allowance": a token bucket that forgives shots bundled into one sync. */
const FIRE_BURST_MICROS = 200_000n;

export const sync = spacetimedb.reducer(
  {
    seq: t.u32(),
    life: t.u32(),
    corr: t.u32(),
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
    const meta = { ...meta0, lastFire: [...meta0.lastFire] };
    const fmul = frenzyMul(r, now);

    // ---- 2. Movement check ----
    // Rate limit: a sync under 25 ms after the previous one skips the movement write (actions
    // still run, so bunched packets never lose shots). `corr` must match the server's
    // correction counter: until the client has snapped back, its positions are stale.
    let pos = { x: ps.x, y: ps.y };
    const gap = now - meta.lastSyncMicros;
    if (gap >= BigInt(C.SYNC_MIN_GAP_MS * 1000) && a.corr === p.correction) {
      meta.lastSyncMicros = now;
      const dt = Math.min(Number(now - ps.serverMicros) / 1e6, C.SYNC_MAX_DT_SEC);
      if (validateMove(RIG7, pos, { x: a.x, y: a.y }, dt)) {
        meta.prevX = ps.x;
        meta.prevY = ps.y;
        meta.prevMicros = ps.serverMicros;
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
    if (boxTouchesTile(RIG7, pos.x - C.PLAYER_W / 2, pos.y - C.PLAYER_H, pos.x + C.PLAYER_W / 2, pos.y, T_ACID)) {
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
      if (a.reload) startReload(p, now);
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

/** In dev rooms, log why an action was rejected (useful in tests and when debugging live). */
function rejected(r: RoomRow, what: string): void {
  if (r.dev) console.info(`[${r.code}] rejected ${what}`);
}

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
  const left = pos.x - C.PLAYER_W / 2;
  const right = pos.x + C.PLAYER_W / 2;
  const top = pos.y - C.PLAYER_H;
  for (const pk of ctx.db.pickup.roomId.filter(r.id)) {
    if (pk.availableAtMicros !== 0n) continue;
    if (r.mode !== C.MODE_ARMS && pk.kind !== PICKUP_HEALTH) continue; // Blades/Boom: health only
    const px = pk.tx * C.TILE;
    const py = pk.ty * C.TILE;
    if (right <= px || left >= px + C.PICKUP_SIZE || pos.y <= py || top >= py + C.PICKUP_SIZE) continue;

    // Only consume a pickup that actually helps.
    if (pk.kind === PICKUP_HEALTH) {
      if (p.hp >= C.MAX_HP) continue;
      p.hp = Math.min(C.MAX_HP, p.hp + C.HEALTH_PACK_HP);
    } else if (pk.kind === PICKUP_AMMO) {
      const full = primaryReserve(p.primary);
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

type MetaRow = Infer<typeof pmeta.rowType>;
type ShotRow = Infer<typeof ShotIn>;

/** Validate one shot (section 6, "favour the shooter within tolerances") and apply its hits. */
function handleShot(ctx: Ctx, r: RoomRow, p: PlayerRow, meta: MetaRow, pos: { x: number; y: number }, shot: ShotRow, now: bigint, fmul: number): void {
  const wid = shot.weapon;
  if (!isGun(wid) || wid !== p.weapon || !allowedWeapons(r.mode, p.primary).includes(wid)) return rejected(r, 'shot: weapon not equipped');
  if (p.reloadUntilMicros > 0n) return rejected(r, 'shot: reloading');
  const w = WEAPONS[wid];
  if (!fireRateOk(meta.lastFire[wid], now, w.rate)) return rejected(r, 'shot: too fast');
  const magLeft = wid === W_PISTOL ? p.pistolMag : p.mag;
  if (magLeft <= 0) return rejected(r, 'shot: empty');
  // The shot may have been fired before this sync's movement (e.g. shotgun recoil moved the
  // shooter since), so the origin may be near the current OR the previous accepted position.
  if (!shotOriginOk(pos, shot.ox, shot.oy) && !shotOriginOk({ x: meta.prevX, y: meta.prevY }, shot.ox, shot.oy)) return rejected(r, `shot: origin (${shot.ox.toFixed(0)},${shot.oy.toFixed(0)}) far from (${pos.x.toFixed(0)},${pos.y.toFixed(0)})`);

  // Accepted: spend ammo and advance the fire-rate token bucket.
  if (wid === W_PISTOL) p.pistolMag -= 1;
  else p.mag -= 1;
  const minGap = secToMicros(C.FIRE_RATE_TOLERANCE / w.rate);
  const floor = now - FIRE_BURST_MICROS;
  const advanced = meta.lastFire[wid] + minGap;
  meta.lastFire[wid] = advanced > floor ? advanced : floor;
  p.spawnProtectUntilMicros = 0n; // firing ends spawn protection

  const seen = new Set<string>();
  for (const claim of shot.hits) {
    const key = claim.target.toHexString();
    if (seen.has(key)) continue;
    seen.add(key);
    if (claim.target.isEqual(p.identity)) continue;
    const target = ctx.db.player.identity.find(claim.target);
    if (!target || target.roomId !== r.id || !target.alive || isProtected(target, now)) continue;
    const tps = ctx.db.pstate.identity.find(target.identity);
    const tmeta = ctx.db.pmeta.identity.find(target.identity);
    if (!tps) continue;
    // The target's current or previous accepted position may match (latency tolerance).
    let d = hitClaimDistance(RIG7, w, shot.ox, shot.oy, claim.angle, { x: tps.x, y: tps.y });
    if (d < 0 && tmeta) d = hitClaimDistance(RIG7, w, shot.ox, shot.oy, claim.angle, { x: tmeta.prevX, y: tmeta.prevY });
    if (d < 0) { rejected(r, 'hit claim: out of range, behind a wall or off the ray'); continue; }
    const pellets = Math.max(1, Math.min(claim.pellets, w.pellets));
    const dmg = pellets * damageAtDistance(w, d) * fmul;
    const res = damageOther(ctx, target, dmg, p.identity, wid);
    if (res.killed) creditKill(p, res.bounty);
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
    if (target.identity.isEqual(p.identity) || !target.alive || isProtected(target, now)) continue;
    const tps = ctx.db.pstate.identity.find(target.identity);
    const tmeta = ctx.db.pmeta.identity.find(target.identity);
    if (!tps) continue;
    const targetPositions = [{ x: tps.x, y: tps.y }];
    if (tmeta) targetPositions.push({ x: tmeta.prevX, y: tmeta.prevY });
    const hit = attackerPositions.some((ap) => targetPositions.some((tp) => meleeHits(RIG7, ap, angle, tp)));
    if (!hit) continue;
    const res = damageOther(ctx, target, knife.damage * fmul, p.identity, W_KNIFE);
    if (res.killed) creditKill(p, res.bounty);
  }
}

type PStateRow = Infer<typeof pstate.rowType>;

function handleThrow(ctx: Ctx, r: RoomRow, p: PlayerRow, meta: MetaRow, pos: { x: number; y: number }, ps: PStateRow, angle: number, now: bigint): void {
  if (r.mode === C.MODE_BLADES) return;
  if (r.mode === C.MODE_ARMS) {
    if (p.grenades <= 0 || !fireRateOk(meta.lastThrowMicros, now, 1 / C.GRENADE_COOLDOWN_ARMS)) return;
  } else {
    if (!fireRateOk(meta.lastThrowMicros, now, 1 / C.GRENADE_COOLDOWN_BOOM)) return;
    const live = [...ctx.db.grenade.owner.filter(p.identity)].length;
    if (live >= C.GRENADE_BOOM_MAX_LIVE) return;
  }
  meta.lastThrowMicros = now;
  if (r.mode === C.MODE_ARMS) p.grenades -= 1;
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
  const g = ctx.db.grenade.insert({ id: 0n, roomId: r.id, owner: p.identity, x0, y0, vx0, vy0, thrownMicros: now, fuseMs: C.GRENADE_FUSE_MS });
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
  ctx.db.room.id.update({ ...r, state: ROOM_ENDED });
  clearRoomJobs(ctx, r.id, false);
  // Stats stay for the leaderboard; mark everyone dead so nobody keeps playing.
  for (const p of roomPlayers(ctx, r.id)) {
    ctx.db.player.identity.update({ ...p, alive: false, respawnAtMicros: 0n, reloadUntilMicros: 0n });
  }
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
  const end = simulateGrenade(RIG7, g.x0, g.y0, g.vx0, g.vy0, fuseTicks(g.fuseMs), { x: 0, y: 0, vx: 0, vy: 0 });
  const bx = Math.min(Math.max(end.x, 0), MAP_W);
  const by = Math.min(Math.max(end.y, 0), MAP_H);
  ctx.db.boomEv.insert({ roomId: r.id, owner: g.owner, x: bx, y: by });

  const fmul = frenzyMul(r, now);
  for (const target of roomPlayers(ctx, r.id)) {
    if (!target.alive || isProtected(target, now)) continue;
    const c = centreOf(ctx, target.identity);
    if (!c) continue;
    const d = Math.hypot(c.x - bx, c.y - by);
    if (d >= C.GRENADE_BLAST_RADIUS || !lineOfSight(RIG7, bx, by, c.x, c.y)) continue;
    const own = target.identity.isEqual(g.owner);
    const dmg = grenadeDamage(C.GRENADE_MAX_DAMAGE, C.GRENADE_BLAST_RADIUS, d) * fmul * (own ? C.GRENADE_SELF_DAMAGE_MUL : 1);
    const res = damageOther(ctx, target, dmg, g.owner, W_FRAG);
    if (res.killed && !own) {
      const killer = ctx.db.player.identity.find(g.owner);
      if (killer) {
        const k = { ...killer };
        creditKill(k, res.bounty);
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
