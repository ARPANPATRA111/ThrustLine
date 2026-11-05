// CPU players. Each bot is a real SpacetimeDB client with its own identity, opened from the
// host's browser tab: it joins the room by code and plays through the same `sync` reducer as a
// human, so the server validates bots exactly like people. The "brain" turns what the bot can
// see into the same ActorInput a keyboard would produce, with human-like limits:
//   - it only notices enemies within its sight range and in line of sight,
//   - it perceives positions with a delay (it aims where you WERE a moment ago),
//   - it waits a reaction time before shooting, aims with a wandering error,
//   - it fires in bursts and pauses, and it turns its aim at a limited speed,
//   - bots spread their attention instead of all hunting the same player.
import type { Identity } from 'spacetimedb';
import * as C from '@shared/config';
import { MAP_W, RIG7, T_ACID, T_SOLID, spawnWorldPos, tileAt } from '@shared/map';
import { lineOfSight } from '@shared/raycast';
import { PRIMARIES, WEAPONS, W_FRAG, W_KNIFE, W_PISTOL, W_RAIL, W_SMG, W_SNIPER, canThrow, isGun } from '@shared/weapons';
import { tables, type DbConnection } from '../module_bindings';
import type { Player, Pstate } from '../module_bindings/types';
import { openBotConnection } from '../net/connection';
import { Actor, type ActorInput, type Target, type WorldView, emptyInput } from './actor';

const BOT_NAMES = ['CPU Vex', 'CPU Kestrel', 'CPU Rivet', 'CPU Nova', 'CPU Brick', 'CPU Echo', 'CPU Flux', 'CPU Onyx'];
const DT = 1 / C.SIM_HZ;

/** Difficulty presets (index = room.rules.botSkill: easy, normal, hard). */
const SKILL = [
  { reaction: 0.8, aimError: 0.26, turn: 2.6, burstOn: [0.2, 0.4], burstOff: [0.8, 1.5], sight: 600, perceiveEvery: 0.45, nadeEvery: [10, 16] },
  { reaction: 0.5, aimError: 0.15, turn: 3.8, burstOn: [0.3, 0.55], burstOff: [0.5, 1.0], sight: 760, perceiveEvery: 0.28, nadeEvery: [7, 11] },
  { reaction: 0.3, aimError: 0.07, turn: 5.5, burstOn: [0.4, 0.9], burstOff: [0.25, 0.55], sight: 950, perceiveEvery: 0.15, nadeEvery: [4, 7] },
];

const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

// The acid pit's extent, found once from the map.
const ACID_TILES: number[] = [];
for (let ty = 0; ty < RIG7.rows; ty++) for (let tx = 0; tx < RIG7.cols; tx++) if (tileAt(RIG7, tx, ty) === T_ACID) ACID_TILES.push(tx, ty);
const pitL = Math.min(...ACID_TILES.filter((_, i) => i % 2 === 0)) * C.TILE;
const pitR = (Math.max(...ACID_TILES.filter((_, i) => i % 2 === 0)) + 1) * C.TILE;
const pitTop = Math.min(...ACID_TILES.filter((_, i) => i % 2 === 1)) * C.TILE;
/** Patrol waypoints: the spawn points, spread over every height of the map. */
const WAYPOINTS = RIG7.spawns.map(spawnWorldPos);

/** Decision-making for one bot. Plain heuristics a person can read and tune. */
export class BotBrain {
  targetKey: string | null = null;
  private target: Target | null = null;
  private retargetIn = 0;
  /** Where the bot believes its target is (refreshed only every `perceiveEvery` seconds). */
  private seenX = 0;
  private seenY = 0;
  private perceiveIn = 0;
  /** Seconds left to keep hunting the last place an enemy was seen. */
  private huntFor = 0;
  private seenFor = 0;
  private aimNoise = 0;
  private burstOn = false;
  private burstLeft = 0;
  private waypoint = WAYPOINTS[Math.floor(Math.random() * WAYPOINTS.length)];
  private stuckFor = 0;
  private strafeDir = 1;
  private strafeIn = 0;
  private nadeIn = rand(4, 8);
  private wasThrust = false;
  private tmp: Target[] = [];
  private input: ActorInput = emptyInput();

  /** `claims` counts how many other bots already chase each target, so they spread out. */
  think(a: Actor, world: WorldView, claims: Map<string, number>): ActorInput {
    const sk = SKILL[Math.min(world.rules.botSkill, SKILL.length - 1)];
    const inp = this.input;
    const b = a.body;
    const cx = b.x;
    const cy = b.y - C.PLAYER_H / 2;
    const map = world.map;
    inp.fire = inp.firePressed = inp.melee = inp.grenade = inp.swap = inp.reload = false;
    inp.down = false;

    // --- Notice enemies: within sight range and line of sight only ---
    const n = world.targets(a.key, this.tmp);
    let current: Target | null = null;
    for (let i = 0; i < n; i++) if (this.tmp[i].key === this.targetKey) current = this.tmp[i];
    // Team match: teammates are never targets.
    const visible = (t: Target) => {
      if (world.rules.teams && a.team !== 0 && t.team === a.team) return false;
      const d = Math.hypot(t.x - cx, t.y - C.PLAYER_H / 2 - cy);
      return d < sk.sight && lineOfSight(map, cx, cy, t.x, t.y - C.PLAYER_H / 2);
    };
    this.retargetIn -= DT;
    if (!current || this.retargetIn <= 0 || !visible(current)) {
      // Pick a visible enemy: nearer is likelier, with randomness and a penalty for enemies
      // other bots are already chasing (so they don't all gang up on one player).
      let best: Target | null = null;
      let bestScore = Infinity;
      for (let i = 0; i < n; i++) {
        const t = this.tmp[i];
        if (!visible(t)) continue;
        const d = Math.hypot(t.x - cx, t.y - C.PLAYER_H / 2 - cy);
        const crowd = (claims.get(t.key) ?? 0) - (t.key === this.targetKey ? 1 : 0);
        const score = d * rand(0.7, 1.3) * (1 + crowd * 0.8);
        if (score < bestScore) { bestScore = score; best = t; }
      }
      if (best?.key !== this.targetKey) {
        this.seenFor = 0;
        this.perceiveIn = 0;
      }
      this.target = best;
      this.targetKey = best?.key ?? null;
      this.retargetIn = rand(1.5, 3);
    } else {
      this.target = current;
    }

    let moveX = 0;
    let thrust = false;
    const t = this.target;
    const w = a.weapon;
    if (t) {
      this.huntFor = 4;
      this.seenFor += DT;
      // Delayed perception: the bot only "looks" every so often, so moving players are hard to hit.
      this.perceiveIn -= DT;
      if (this.perceiveIn <= 0) {
        this.perceiveIn = sk.perceiveEvery * rand(0.7, 1.3);
        this.seenX = t.x;
        this.seenY = t.y - C.PLAYER_H / 2;
      }
      const dx = this.seenX - cx;
      const dy = this.seenY - cy;
      const dist = Math.hypot(dx, dy);

      // Aim: a wandering error that shrinks a little while the target stays in view.
      this.aimNoise += (Math.random() - 0.5) * sk.aimError * 0.6;
      this.aimNoise = Math.max(-sk.aimError * 1.5, Math.min(sk.aimError * 1.5, this.aimNoise * 0.97));
      const focus = Math.max(0.5, 1 - this.seenFor * 0.15);
      let want = Math.atan2(dy, dx) + this.aimNoise * focus;
      if (w === W_FRAG || (canThrow(world.mode) && world.mode === C.MODE_BOOM)) want -= Math.min(0.5, dist / 1600); // lob grenades
      inp.aim = turnToward(a.aim, want, sk.turn * DT);

      // Distance keeping per weapon.
      let ideal = 280;
      if (world.mode === C.MODE_BLADES || w === W_KNIFE) ideal = 10;
      else if (w === W_SNIPER || w === W_RAIL) ideal = 600;
      else if (w === 2) ideal = 170;
      else if (w === W_SMG) ideal = 220;
      else if (world.mode === C.MODE_BOOM) ideal = 320;
      if (Math.abs(dx) > ideal + 60) moveX = Math.sign(dx);
      else if (Math.abs(dx) < ideal - 90 && ideal > 50) moveX = -Math.sign(dx);
      else {
        this.strafeIn -= DT;
        if (this.strafeIn <= 0) { this.strafeDir = -this.strafeDir; this.strafeIn = rand(0.5, 1.4); }
        moveX = this.strafeDir * 0.7;
        if (Math.random() < DT * 0.6) thrust = true; // occasional dodge hop
      }
      if (dy < -80 && b.fuel > 20) thrust = true;
      if (dy > 100 && b.grounded && Math.abs(dx) < 260) inp.down = true;

      // --- Attack: after the reaction time, in bursts, only when roughly on target ---
      const aimErr = Math.abs(angleDelta(a.aim, Math.atan2(dy, dx)));
      this.burstLeft -= DT;
      if (this.burstLeft <= 0) {
        this.burstOn = !this.burstOn;
        this.burstLeft = this.burstOn ? rand(sk.burstOn[0], sk.burstOn[1]) : rand(sk.burstOff[0], sk.burstOff[1]);
      }
      if (this.seenFor > sk.reaction) {
        if (isGun(w)) {
          const def = WEAPONS[w];
          if (this.burstOn && dist < def.range * 0.85 && aimErr < 0.25) {
            const left = w === W_RAIL ? a.power : w === W_PISTOL ? a.pistolMag : a.mag;
            if (left === 0 && !world.rules.infiniteAmmo) inp.reload = true;
            else {
              inp.fire = true;
              // Semi-auto weapons: a "click" only now and then, like a person tapping.
              inp.firePressed = def.kind === 'auto' || Math.random() < DT * def.rate * 0.8;
            }
          }
          if (a.mag === 0 && a.reserve === 0 && w !== W_PISTOL && w !== W_RAIL && !world.rules.infiniteAmmo) inp.swap = true;
        } else if (w === W_KNIFE) {
          if (dist < 70 && this.burstOn) inp.firePressed = true;
        } else if (w === W_FRAG && dist < 520 && aimErr < 0.5 && this.burstOn) {
          inp.fire = true;
        }
        if (dist < 55 && world.mode !== C.MODE_BLADES && Math.random() < DT * 3) inp.melee = true;
        this.nadeIn -= DT;
        if (world.mode === C.MODE_ARMS && (a.grenades > 0 || world.rules.infiniteAmmo) && dist > 170 && dist < 460 && this.nadeIn <= 0) {
          inp.grenade = true;
          this.nadeIn = rand(sk.nadeEvery[0], sk.nadeEvery[1]);
        }
      }
    } else {
      // Nobody in view: first hunt the last known position, then patrol between waypoints.
      this.seenFor = 0;
      this.huntFor -= DT;
      const hunting = this.huntFor > 0;
      // Crates and shields are worth a detour; otherwise hunt, then patrol.
      const goal = world.goal(cx, b.y);
      const gx = goal ? goal.x : hunting ? this.seenX : this.waypoint.x;
      const gy = goal ? goal.y : hunting ? this.seenY + C.PLAYER_H / 2 : this.waypoint.y;
      const dx = gx - cx;
      const dy = gy - b.y;
      if (hunting && Math.abs(dx) < 40 && Math.abs(dy) < 60) this.huntFor = 0;
      if (Math.abs(dx) < 40 && Math.abs(dy) < 50) this.waypoint = WAYPOINTS[Math.floor(Math.random() * WAYPOINTS.length)];
      moveX = Math.abs(dx) > 20 ? Math.sign(dx) : 0;
      if (dy < -40 && b.fuel > 25) thrust = true;
      if (dy > 60 && b.grounded) inp.down = true;
      inp.aim = turnToward(a.aim, moveX >= 0 ? 0.1 : Math.PI - 0.1, 3 * DT);
    }

    // --- Navigation: hop walls, escape acid, get unstuck ---
    const aheadTx = Math.floor((cx + Math.sign(moveX || 1) * 24) / C.TILE);
    const bodyTy = Math.floor(cy / C.TILE);
    if (moveX !== 0 && (tileAt(map, aheadTx, bodyTy) === T_SOLID || tileAt(map, aheadTx, bodyTy + 1) === T_SOLID)) thrust = true;
    const feetTy = Math.floor((b.y + 4) / C.TILE);
    let inAcid = false;
    if (world.rules.acid) {
      inAcid = tileAt(map, Math.floor(cx / C.TILE), feetTy) === T_ACID || tileAt(map, Math.floor(cx / C.TILE), feetTy + 1) === T_ACID;
      const dir = Math.sign(moveX || b.vx || 1);
      for (let k = 0; k <= 4; k++) {
        if (tileAt(map, Math.floor((cx + dir * k * C.TILE) / C.TILE), feetTy) === T_ACID) thrust = true;
      }
      if (pitL <= cx && cx <= pitR && b.y > pitTop - 160 && b.fuel > 1) thrust = true;
      if (inAcid) {
        thrust = true;
        moveX = cx - pitL < pitR - cx ? -1 : 1;
      }
    }
    if (Math.abs(moveX) > 0.5 && Math.abs(b.vx) < 20 && b.grounded) this.stuckFor += DT;
    else this.stuckFor = 0;
    if (this.stuckFor > 0.6) {
      thrust = true;
      this.waypoint = WAYPOINTS[Math.floor(Math.random() * WAYPOINTS.length)];
      this.stuckFor = 0;
    }
    if (b.fuel < 8 && !inAcid) thrust = false;
    // On the ground a hop needs a fresh press: release for one step, then press again.
    if (thrust && b.grounded && this.wasThrust) thrust = false;
    this.wasThrust = thrust;
    if (cx < 60) moveX = 1;
    if (cx > MAP_W - 60) moveX = -1;

    inp.moveX = moveX;
    inp.thrust = thrust;
    return inp;
  }
}

function angleDelta(a: number, b: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function turnToward(current: number, target: number, maxStep: number): number {
  const d = angleDelta(current, target);
  return current + Math.max(-maxStep, Math.min(maxStep, d));
}

export interface Bot {
  conn: DbConnection;
  identity: Identity;
  key: string;
  actor: Actor;
  brain: BotBrain;
  name: string;
  lastLife: number;
  lastRow: Player | null;
}

/** Owns this tab's bots: connects them, runs their brains and sends their syncs. */
export class BotManager {
  bots: Bot[] = [];
  private adding = 0;
  private claims = new Map<string, number>();

  get count(): number {
    return this.bots.length + this.adding;
  }

  /** The bot with this identity key, if this tab hosts it. */
  get(key: string): Bot | undefined {
    return this.bots.find((b) => b.key === key);
  }

  async add(roomCode: string): Promise<void> {
    this.adding++;
    try {
      const { conn, identity } = await openBotConnection();
      // A bot only needs its own rows: everything else comes from the host's view of the room.
      conn.subscriptionBuilder().subscribe([
        tables.player.where((r) => r.identity.eq(identity)),
        tables.pstate.where((r) => r.identity.eq(identity)),
      ]);
      const used = new Set(this.bots.map((b) => b.name));
      const name = BOT_NAMES.find((n) => !used.has(n)) ?? `CPU ${this.bots.length + 1}`;
      await conn.reducers.joinRoom({ code: roomCode, name, bot: true });
      void conn.reducers.choosePrimary({ weapon: PRIMARIES[Math.floor(Math.random() * PRIMARIES.length)] }).catch(() => {});
      this.bots.push({ conn, identity, key: identity.toHexString(), actor: new Actor(identity, null), brain: new BotBrain(), name, lastLife: -1, lastRow: null });
    } finally {
      this.adding--;
    }
  }

  /** Disconnect one specific bot (e.g. after the host kicked it). */
  remove(bot: Bot): void {
    const i = this.bots.indexOf(bot);
    if (i >= 0) this.bots.splice(i, 1);
    bot.conn.disconnect();
  }

  removeOne(): void {
    const b = this.bots.pop();
    if (b) b.conn.disconnect(); // the server's disconnect handler removes the bot's rows
  }

  removeAll(): void {
    while (this.bots.length) this.removeOne();
  }

  /** Advance every bot by one fixed step and send syncs when due. */
  step(world: WorldView, runMul: number, fuelMul: number): void {
    const now = performance.now();
    this.claims.clear();
    for (const bot of this.bots) {
      if (bot.brain.targetKey) this.claims.set(bot.brain.targetKey, (this.claims.get(bot.brain.targetKey) ?? 0) + 1);
    }
    for (const bot of this.bots) {
      const row: Player | undefined = bot.conn.db.player.identity.find(bot.identity) ?? undefined;
      if (!row) continue;
      const ps: Pstate | undefined = bot.conn.db.pstate.identity.find(bot.identity) ?? undefined;
      // Merge the server row only when it changed, so local ammo prediction survives between updates.
      if (row !== bot.lastRow) {
        bot.lastRow = row;
        bot.actor.applyServer(row, ps);
      }
      if (!row.alive && bot.lastLife !== row.lifeId) {
        // Dead: maybe switch primary for the next life.
        bot.lastLife = row.lifeId;
        if (Math.random() < 0.3) void bot.conn.reducers.choosePrimary({ weapon: PRIMARIES[Math.floor(Math.random() * PRIMARIES.length)] }).catch(() => {});
      }
      if (!bot.actor.alive) continue;
      const input = bot.brain.think(bot.actor, world, this.claims);
      bot.actor.step(input, DT, world, runMul, fuelMul);
      const args = bot.actor.takeSync(now, input, world.serverNow());
      if (args) void bot.conn.reducers.sync(args).catch(() => {});
    }
  }

  knockback(world: WorldView, x: number, y: number): void {
    for (const b of this.bots) b.actor.knockback(world.map, x, y);
  }
}
