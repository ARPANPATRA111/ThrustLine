// CPU players. Each bot is a real SpacetimeDB client with its own identity, opened from the
// host's browser tab: it joins the room by code and plays through the same `sync` reducer as a
// human, so the server validates bots exactly like people. The "brain" turns what the bot can
// see into the same ActorInput a keyboard would produce.
import type { Identity } from 'spacetimedb';
import * as C from '@shared/config';
import { MAP_W, RIG7, T_ACID, T_SOLID, tileAt } from '@shared/map';
import { lineOfSight } from '@shared/raycast';
import { PRIMARIES, WEAPONS, W_FRAG, W_KNIFE, isGun } from '@shared/weapons';
import { tables, type DbConnection } from '../module_bindings';
import type { Player, Pstate } from '../module_bindings/types';
import { openBotConnection } from '../net/connection';
import { Actor, type ActorInput, type Target, type WorldView, emptyInput } from './actor';

const BOT_NAMES = ['CPU Vex', 'CPU Kestrel', 'CPU Rivet', 'CPU Nova', 'CPU Brick', 'CPU Echo', 'CPU Flux', 'CPU Onyx'];
const DT = 1 / C.SIM_HZ;

// The acid pit's extent, found once from the map.
const ACID_TILES: number[] = [];
for (let ty = 0; ty < RIG7.rows; ty++) for (let tx = 0; tx < RIG7.cols; tx++) if (tileAt(RIG7, tx, ty) === T_ACID) ACID_TILES.push(tx, ty);
const pitL = Math.min(...ACID_TILES.filter((_, i) => i % 2 === 0)) * C.TILE;
const pitR = (Math.max(...ACID_TILES.filter((_, i) => i % 2 === 0)) + 1) * C.TILE;
const pitTop = Math.min(...ACID_TILES.filter((_, i) => i % 2 === 1)) * C.TILE;

/** Decision-making for one bot. Plain heuristics, re-evaluated a few times per second. */
export class BotBrain {
  private target: Target | null = null;
  private retargetIn = 0;
  private seenFor = 0; // reaction time: how long the current target has been visible
  private aimNoise = 0;
  private wanderDir = Math.random() < 0.5 ? -1 : 1;
  private stuckFor = 0;
  private strafeDir = 1;
  private strafeIn = 0;
  private nadeIn = 2 + Math.random() * 3;
  private wasThrust = false;
  private tmp: Target[] = [];
  private input: ActorInput = emptyInput();

  think(a: Actor, world: WorldView): ActorInput {
    const inp = this.input;
    const b = a.body;
    const cx = b.x;
    const cy = b.y - C.PLAYER_H / 2;
    const map = world.map;
    inp.fire = inp.firePressed = inp.melee = inp.grenade = inp.swap = inp.reload = false;
    inp.down = false;

    // --- Pick the nearest enemy, preferring ones in line of sight ---
    this.retargetIn -= DT;
    const n = world.targets(a.key, this.tmp);
    if (this.retargetIn <= 0 || (this.target && !this.tmp.slice(0, n).some((t) => t.key === this.target!.key))) {
      this.retargetIn = 0.5;
      let best: Target | null = null;
      let bestScore = Infinity;
      for (let i = 0; i < n; i++) {
        const t = this.tmp[i];
        const d = Math.hypot(t.x - cx, t.y - C.PLAYER_H / 2 - cy);
        const score = d * (lineOfSight(map, cx, cy, t.x, t.y - C.PLAYER_H / 2) ? 1 : 2.5);
        if (score < bestScore) { bestScore = score; best = t; }
      }
      if (best?.key !== this.target?.key) this.seenFor = 0;
      this.target = best;
    } else if (this.target) {
      // Refresh the target's position from this frame's list.
      for (let i = 0; i < n; i++) if (this.tmp[i].key === this.target.key) this.target = this.tmp[i];
    }

    let moveX = 0;
    let thrust = false;
    const t = this.target;
    if (t) {
      const tx = t.x;
      const ty = t.y - C.PLAYER_H / 2;
      const dx = tx - cx;
      const dy = ty - cy;
      const dist = Math.hypot(dx, dy);
      const visible = lineOfSight(map, cx, cy, tx, ty);
      this.seenFor = visible ? this.seenFor + DT : 0;

      // Aim with a wandering error that shrinks the longer the target stays in view.
      this.aimNoise += (Math.random() - 0.5) * 0.08;
      this.aimNoise *= 0.94;
      const errorScale = Math.max(0.25, 1 - this.seenFor);
      let want = Math.atan2(dy, dx) + this.aimNoise * errorScale;
      const w = a.weapon;
      if (w === W_FRAG || world.mode === C.MODE_BOOM) want -= Math.min(0.5, dist / 1600); // lob grenades
      inp.aim = turnToward(a.aim, want, 7 * DT);

      // Distance keeping: guns stay at mid range, knives rush in, grenades keep a gap.
      let ideal = 260;
      if (world.mode === C.MODE_BLADES || w === W_KNIFE) ideal = 10;
      else if (w === 3) ideal = 600;
      else if (w === 2) ideal = 150;
      else if (world.mode === C.MODE_BOOM) ideal = 300;
      if (Math.abs(dx) > ideal + 40) moveX = Math.sign(dx);
      else if (Math.abs(dx) < ideal - 80 && ideal > 50) moveX = -Math.sign(dx);
      else {
        // Strafe a little so the bot isn't a sitting duck.
        this.strafeIn -= DT;
        if (this.strafeIn <= 0) { this.strafeDir = -this.strafeDir; this.strafeIn = 0.6 + Math.random() * 0.8; }
        moveX = this.strafeDir * 0.6;
      }
      // Fly up toward targets above; drop through platforms toward targets below.
      if (dy < -70 && b.fuel > 15) thrust = true;
      if (dy > 90 && b.grounded && Math.abs(dx) < 300) inp.down = true;

      // --- Attack ---
      const aimErr = Math.abs(angleDelta(a.aim, Math.atan2(dy, dx)));
      const reacted = this.seenFor > 0.3;
      if (visible && reacted) {
        if (isGun(w)) {
          const def = WEAPONS[w];
          if (dist < def.range * 0.9 && aimErr < 0.2) {
            const left = w === 0 ? a.pistolMag : a.mag;
            if (left === 0) inp.reload = true;
            else { inp.fire = true; inp.firePressed = true; }
          }
          if (a.mag === 0 && a.reserve === 0 && w !== 0) inp.swap = true; // primary dry: use the pistol
        } else if (w === W_KNIFE) {
          if (dist < 70) inp.firePressed = true;
        } else if (w === W_FRAG && dist < 520 && aimErr < 0.5) {
          inp.fire = true;
        }
        if (dist < 60 && world.mode !== C.MODE_BLADES) inp.melee = true;
        this.nadeIn -= DT;
        if (world.mode === C.MODE_ARMS && a.grenades > 0 && dist > 160 && dist < 480 && this.nadeIn <= 0) {
          inp.grenade = true;
          this.nadeIn = 4 + Math.random() * 4;
        }
      }
    } else {
      // Nobody to fight: patrol.
      inp.aim = turnToward(a.aim, this.wanderDir > 0 ? 0 : Math.PI, 4 * DT);
      moveX = this.wanderDir;
      if (cx < 200) this.wanderDir = 1;
      if (cx > MAP_W - 200) this.wanderDir = -1;
    }

    // --- Navigation: hop walls, escape acid, get unstuck ---
    const aheadTx = Math.floor((cx + Math.sign(moveX || 1) * 24) / C.TILE);
    const bodyTy = Math.floor(cy / C.TILE);
    if (moveX !== 0 && (tileAt(map, aheadTx, bodyTy) === T_SOLID || tileAt(map, aheadTx, bodyTy + 1) === T_SOLID)) thrust = true;
    const feetTy = Math.floor((b.y + 4) / C.TILE);
    const inAcid = tileAt(map, Math.floor(cx / C.TILE), feetTy) === T_ACID || tileAt(map, Math.floor(cx / C.TILE), feetTy + 1) === T_ACID;
    // Look ahead along the floor: acid within 4 tiles means jump and fly over it.
    const dir = Math.sign(moveX || b.vx || 1);
    for (let k = 0; k <= 4; k++) {
      if (tileAt(map, Math.floor((cx + dir * k * C.TILE) / C.TILE), feetTy) === T_ACID) thrust = true;
    }
    // Above the pit (but low): keep flying across it.
    if (pitL <= cx && cx <= pitR && b.y > pitTop - 160 && b.fuel > 1) thrust = true;
    if (inAcid) {
      thrust = true;
      moveX = cx - pitL < pitR - cx ? -1 : 1; // nearest edge
    }
    if (Math.abs(moveX) > 0.5 && Math.abs(b.vx) < 20 && b.grounded) this.stuckFor += DT;
    else this.stuckFor = 0;
    if (this.stuckFor > 0.6) {
      thrust = true;
      this.wanderDir = -this.wanderDir;
      this.stuckFor = 0;
    }
    // Save fuel: stop thrusting when nearly empty unless escaping acid.
    if (b.fuel < 8 && !inAcid) thrust = false;
    // On the ground a hop needs a fresh press: release for one step, then press again.
    if (thrust && b.grounded && this.wasThrust) thrust = false;
    this.wasThrust = thrust;

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

interface Bot {
  conn: DbConnection;
  identity: Identity;
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

  get count(): number {
    return this.bots.length + this.adding;
  }

  keys(): Set<string> {
    return new Set(this.bots.map((b) => b.identity.toHexString()));
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
      // Each bot picks a random primary weapon.
      void conn.reducers.choosePrimary({ weapon: PRIMARIES[Math.floor(Math.random() * PRIMARIES.length)] }).catch(() => {});
      this.bots.push({ conn, identity, actor: new Actor(identity, null), brain: new BotBrain(), name, lastLife: -1, lastRow: null });
    } finally {
      this.adding--;
    }
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
        if (Math.random() < 0.3) void bot.conn.reducers.choosePrimary({ weapon: PRIMARIES[Math.floor(Math.random() * 3)] }).catch(() => {});
      }
      if (!bot.actor.alive) continue;
      const input = bot.brain.think(bot.actor, world);
      bot.actor.step(input, DT, world, runMul, fuelMul);
      const args = bot.actor.takeSync(now, input);
      if (args) void bot.conn.reducers.sync(args).catch(() => {});
    }
  }

  knockback(world: WorldView, x: number, y: number): void {
    for (const b of this.bots) b.actor.knockback(world.map, x, y);
  }
}
