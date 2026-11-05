// An Actor is one soldier simulated on this client: the local player, or a CPU bot hosted
// in this tab. It runs the shared physics at 60 Hz, predicts ammo, performs hitscan locally
// (raycast against tiles and the other players' drawn hitboxes) and queues actions that are
// sent to the server in the next `sync` call.
import type { Identity } from 'spacetimedb';
import * as C from '@shared/config';
import type { GameMap } from '@shared/map';
import { type MoveInput, type PlayerBody, applyImpulse, makeBody, stepPlayer } from '@shared/physics';
import { castTiles, rayVsBox, lineOfSight } from '@shared/raycast';
import { WEAPONS, W_FRAG, W_KNIFE, W_PISTOL, W_RAIL, allowedWeapons, canThrow, defaultWeapon, isGun, isPrimary } from '@shared/weapons';
import type { DbConnection } from '../module_bindings';
import type { Player, Pstate } from '../module_bindings/types';

export type SyncArgs = Parameters<DbConnection['reducers']['sync']>[0];
type ShotIn = SyncArgs['shots'][number];

export interface ActorInput extends MoveInput {
  aim: number;
  /** Fire held this frame (automatic weapons keep firing). */
  fire: boolean;
  /** Fire newly pressed this frame (semi-auto weapons need a fresh press). */
  firePressed: boolean;
  melee: boolean;
  grenade: boolean;
  swap: boolean;
  reload: boolean;
}

export function emptyInput(): ActorInput {
  return { moveX: 0, thrust: false, thrustAmount: 1, down: false, aim: 0, fire: false, firePressed: false, melee: false, grenade: false, swap: false, reload: false };
}

/** A hittable player as seen by this client (feet position). */
export interface Target {
  id: Identity;
  key: string;
  x: number;
  y: number;
  /** 0 = no team (free-for-all), 1 red, 2 blue. */
  team: number;
  /** Time (server clock, ms) of the position this client is showing, for lag compensation. */
  viewMs: number;
}

/** Visual/audio side effects of local actions. Bots use a silent sink. */
export interface FxSink {
  shot(weapon: number, ox: number, oy: number, ends: number[], wallHits: boolean[], colorIdx: number): void;
  melee(x: number, y: number, angle: number): void;
  throwG(): void;
  empty(): void;
  reload(): void;
  shake(amount: number): void;
  /**
   * The local shot's own raycast found these targets. Show a provisional hit marker now; the
   * server's `hit_ev` (which carries the damage number and the kill flag) still arrives one
   * round trip later. Optional so bots can keep a silent sink.
   */
  hit?(x: number, y: number): void;
}

/** The room's house rules as the simulation needs them. */
export interface SimRules {
  infiniteFuel: boolean;
  infiniteAmmo: boolean;
  acid: boolean;
  botSkill: number;
  /** Team match on, and whether teammates can be hurt. */
  teams: boolean;
  friendlyFire: boolean;
}

export interface WorldView {
  map: GameMap;
  mode: number;
  rules: SimRules;
  serverNow(): number;
  /** Where a CPU player with nothing to shoot should head (feet position), if anywhere. */
  goal(x: number, y: number): { x: number; y: number } | null;
  /** The live King of the Hill zone in world px, if this round has one. */
  hillRect(): { x0: number; y0: number; x1: number; y1: number } | null;
  /** World y of the rising acid, or Infinity outside sudden death. */
  acidLine(): number;
  /** Everyone this actor could hit, excluding itself. */
  targets(selfKey: string, out: Target[]): number;
}

const tmpTargets: Target[] = [];

export class Actor {
  body: PlayerBody = makeBody(0, 0);
  prevX = 0;
  prevY = 0;
  aim = 0;
  alive = false;
  lifeId = 0;
  correction = 0;
  colorIdx = 0;
  team = 0;

  // Weapon state (predicted locally, overwritten by every server row update).
  weapon = W_PISTOL;
  primary = 1;
  mag = 0;
  pistolMag = 12;
  reserve = 0;
  grenades = 0;
  /** Railgun shots left from an airdrop. */
  power = 0;
  reloadUntilMs = 0;
  private lastShotMs = WEAPONS.map(() => 0);
  private lastMeleeMs = 0;
  private lastThrowMs = 0;

  // Actions waiting for the next sync.
  private shots: ShotIn[] = [];
  private meleeAngle: number | undefined;
  private throwAngle: number | undefined;
  private wantReload = false;
  private seq = 0;
  private lastSyncMs = 0;
  private lastSentX = 0;
  private lastSentY = 0;
  private lastSentAim = 0;
  private activeUntilMs = 0;

  constructor(public identity: Identity, public fx: FxSink | null) {}

  get key(): string {
    return this.identity.toHexString();
  }

  get centerY(): number {
    return this.body.y - C.PLAYER_H / 2;
  }

  /**
   * Merge the server's row. Snap the local simulation only when the server says so:
   * lifeId changed (respawn: jump to the spawn in pstate) or correction increased (rejected
   * move: jump back to cx, cy). Returns 'respawn' | 'correct' | null.
   */
  applyServer(row: Player, ps: Pstate | undefined): 'respawn' | 'correct' | null {
    let snapped: 'respawn' | 'correct' | null = null;
    this.colorIdx = row.colorIdx;
    this.team = row.team;
    if (row.lifeId !== this.lifeId) {
      this.lifeId = row.lifeId;
      if (row.alive) {
        const x = ps ? ps.x : row.cx;
        const y = ps ? ps.y : row.cy;
        this.snapTo(x, y);
        this.body.fuel = C.FUEL_MAX;
        this.weapon = row.weapon;
        this.lastShotMs = WEAPONS.map(() => 0);
        snapped = 'respawn';
      }
      this.correction = row.correction;
    } else if (row.correction > this.correction) {
      this.correction = row.correction;
      this.snapTo(row.cx, row.cy);
      snapped = 'correct';
    }
    this.alive = row.alive;
    this.primary = row.primary;
    this.mag = row.mag;
    this.pistolMag = row.pistolMag;
    this.reserve = row.reserve;
    this.grenades = row.grenades;
    // A crate was just opened: the server has already put the railgun in our hands.
    if (row.alive && row.power === C.RAIL_SHOTS && this.power < C.RAIL_SHOTS) this.weapon = W_RAIL;
    this.power = row.power;
    this.reloadUntilMs = Number(row.reloadUntilMicros) / 1000;
    if (snapped === 'respawn') this.weapon = row.weapon;
    return snapped;
  }

  private snapTo(x: number, y: number): void {
    this.body.x = this.prevX = x;
    this.body.y = this.prevY = y;
    this.body.vx = 0;
    this.body.vy = 0;
    this.shots.length = 0;
    this.meleeAngle = undefined;
    this.throwAngle = undefined;
  }

  get reloading(): boolean {
    return this.reloadUntilMs > 0;
  }

  /** One fixed 60 Hz step: physics, then weapons. */
  step(input: ActorInput, dt: number, world: WorldView, runMul: number, fuelMul: number): void {
    this.prevX = this.body.x;
    this.prevY = this.body.y;
    if (!this.alive) return;
    this.aim = input.aim;
    stepPlayer(world.map, this.body, input, dt, { runSpeedMul: runMul, fuelRefillMul: fuelMul, infiniteFuel: world.rules.infiniteFuel });
    this.weapons(input, world);
  }

  private weapons(input: ActorInput, world: WorldView): void {
    const now = world.serverNow();
    const mode = world.mode;
    // A finished reload: predict the refill (the server does the same on the next sync).
    if (this.reloadUntilMs > 0 && now >= this.reloadUntilMs) this.finishReloadLocal();

    if (input.swap) this.swapWeapon(mode);
    if (input.reload && !world.rules.infiniteAmmo) this.requestReload();

    const w = this.weapon;
    if (isGun(w)) {
      const def = WEAPONS[w];
      const trigger = def.kind === 'auto' ? input.fire : input.firePressed;
      if (trigger && now - this.lastShotMs[w] >= 1000 / def.rate && !this.reloading) {
        const left = w === W_RAIL ? this.power : w === W_PISTOL ? this.pistolMag : this.mag;
        if (left > 0 || (world.rules.infiniteAmmo && w !== W_RAIL)) this.fire(def.id, world, now);
        else if (input.firePressed) {
          this.fx?.empty();
          if (!world.rules.infiniteAmmo) this.requestReload();
        }
      }
    } else if (w === W_KNIFE && input.firePressed) {
      this.doMelee(now);
    } else if (w === W_FRAG && (input.fire || input.firePressed)) {
      // Edge too: a quick tap can start and end between two frames on a slow device.
      this.doThrow(now, mode, world.rules.infiniteAmmo);
    }
    if (input.melee) this.doMelee(now);
    // The grenade key / NADE button throws in every mode that has grenades (Arms and Boom).
    if (input.grenade && canThrow(mode)) this.doThrow(now, mode, world.rules.infiniteAmmo);
  }

  private swapWeapon(mode: number): void {
    const list = allowedWeapons(mode, this.primary, this.power).filter((x) => mode !== C.MODE_ARMS || x !== W_KNIFE);
    if (list.length < 2) return;
    const i = list.indexOf(this.weapon);
    this.weapon = list[(i + 1) % list.length];
    this.reloadUntilMs = 0;
    this.markActive();
  }

  private requestReload(): void {
    const w = this.weapon;
    if (!isGun(w) || w === W_RAIL || this.reloading) return;
    const def = WEAPONS[w];
    if (w === W_PISTOL ? this.pistolMag >= def.mag : this.mag >= def.mag || this.reserve <= 0) return;
    this.wantReload = true;
    // Block firing until the server row tells us when the reload really ends.
    this.reloadUntilMs = Number.MAX_SAFE_INTEGER;
    this.fx?.reload();
    this.markActive();
  }

  private finishReloadLocal(): void {
    this.reloadUntilMs = 0;
    if (this.weapon === W_PISTOL) this.pistolMag = WEAPONS[W_PISTOL].mag;
    else if (isPrimary(this.weapon)) {
      const take = Math.min(WEAPONS[this.weapon].mag - this.mag, this.reserve);
      this.mag += take;
      this.reserve -= take;
    }
  }

  /**
   * Hitscan fire. Each pellet is a ray: first find where it hits a wall (DDA), then test every
   * other player's hitbox with the slab test and keep the nearest hit before the wall.
   */
  private fire(wid: number, world: WorldView, now: number): void {
    const def = WEAPONS[wid];
    this.lastShotMs[wid] = now;
    if (wid === W_RAIL) this.power = Math.max(0, this.power - 1);
    else if (!world.rules.infiniteAmmo) {
      if (wid === W_PISTOL) this.pistolMag--;
      else this.mag--;
    }

    const cx = this.body.x;
    const cy = this.centerY;
    const ox = cx + Math.cos(this.aim) * 20;
    const oy = cy + Math.sin(this.aim) * 20;
    // Don't let the muzzle poke through a wall: fall back to the body centre.
    const startX = lineOfSight(world.map, cx, cy, ox, oy) ? ox : cx;
    const startY = startX === ox ? oy : cy;

    const moving = Math.abs(this.body.vx) > 40 || !this.body.grounded;
    const spreadRad = ((moving ? def.spreadMoving : def.spreadStill) * Math.PI) / 180;
    const nTargets = world.targets(this.key, tmpTargets);
    const ends: number[] = [];
    const wallHits: boolean[] = [];
    const hitCount = new Map<string, { t: Target; pellets: number; angleSum: number }>();
    // Friendly fire off: bullets pass straight through teammates.
    const skipTeam = world.rules.teams && !world.rules.friendlyFire && this.team !== 0 ? this.team : -1;
    const pierce = wid === W_RAIL;

    for (let p = 0; p < def.pellets; p++) {
      // Shotgun pellets spread evenly across the cone with a little jitter; others are random.
      const off = def.pellets > 1
        ? spreadRad * ((p / (def.pellets - 1)) * 2 - 1) + (Math.random() - 0.5) * spreadRad * 0.3
        : (Math.random() * 2 - 1) * spreadRad;
      const ang = this.aim + off;
      const dx = Math.cos(ang);
      const dy = Math.sin(ang);
      let best = castTiles(world.map, startX, startY, dx, dy, def.range);
      let wall = best < def.range;
      let hitT: Target | null = null;
      const land = (t: Target) => {
        const e = hitCount.get(t.key) ?? { t, pellets: 0, angleSum: 0 };
        e.pellets++;
        e.angleSum += ang;
        hitCount.set(t.key, e);
      };
      for (let i = 0; i < nTargets; i++) {
        const t = tmpTargets[i];
        if (t.team === skipTeam) continue;
        const d = rayVsBox(startX, startY, dx, dy, t.x - C.PLAYER_W / 2, t.y - C.PLAYER_H, t.x + C.PLAYER_W / 2, t.y, best);
        if (d >= 0 && d < best) {
          if (pierce) {
            land(t); // the slug carries on to the wall
            continue;
          }
          best = d;
          hitT = t;
          wall = false;
        }
      }
      ends.push(startX + dx * best, startY + dy * best);
      wallHits.push(wall);
      if (hitT) land(hitT);
    }

    const hits = [...hitCount.values()].map((e) => ({ target: e.t.id, pellets: e.pellets, angle: e.angleSum / e.pellets, viewMs: e.t.viewMs }));
    this.shots.push({ weapon: wid, ox: startX, oy: startY, angle: this.aim, ends, hits });
    // Instant local feedback: at 250 ms the server's confirmation is a visible pause. The
    // damage number still waits for the authoritative event.
    for (const e of hitCount.values()) this.fx?.hit?.(e.t.x, e.t.y - C.PLAYER_H / 2);
    if (def.recoil > 0) applyImpulse(this.body, -Math.cos(this.aim) * def.recoil, -Math.sin(this.aim) * def.recoil);
    this.fx?.shot(wid, startX, startY, ends, wallHits, this.colorIdx);
    this.fx?.shake(def.shake);
    if (wid === W_RAIL && this.power === 0) this.weapon = defaultWeapon(world.mode, this.primary);
    this.markActive();
  }

  private doMelee(now: number): void {
    const knife = WEAPONS[W_KNIFE];
    if (now - this.lastMeleeMs < 1000 / knife.rate) return;
    this.lastMeleeMs = now;
    this.meleeAngle = this.aim;
    applyImpulse(this.body, Math.cos(this.aim) * C.KNIFE_LUNGE, Math.sin(this.aim) * C.KNIFE_LUNGE * 0.5);
    this.fx?.melee(this.body.x, this.centerY, this.aim);
    this.markActive();
  }

  private doThrow(now: number, mode: number, infinite: boolean): void {
    if (!canThrow(mode)) return;
    const cooldown = mode === C.MODE_BOOM ? C.GRENADE_COOLDOWN_BOOM : C.GRENADE_COOLDOWN_ARMS;
    if (now - this.lastThrowMs < cooldown * 1000) return;
    if (mode === C.MODE_ARMS && !infinite) {
      if (this.grenades <= 0) return;
      this.grenades--;
    }
    this.lastThrowMs = now;
    this.throwAngle = this.aim;
    this.fx?.throwG();
    this.markActive();
  }

  /** Grenade knockback: the client owns its movement, so it applies blasts to itself. */
  knockback(map: GameMap, bx: number, by: number): void {
    if (!this.alive) return;
    const cx = this.body.x;
    const cy = this.centerY;
    const d = Math.hypot(cx - bx, cy - by);
    if (d >= C.GRENADE_BLAST_RADIUS || !lineOfSight(map, bx, by, cx, cy)) return;
    const k = C.GRENADE_KNOCKBACK * (1 - d / C.GRENADE_BLAST_RADIUS);
    const nx = d > 1 ? (cx - bx) / d : 0;
    const ny = d > 1 ? (cy - by) / d : -1;
    applyImpulse(this.body, nx * k, ny * k - k * 0.25);
    this.markActive();
  }

  private markActive(): void {
    this.activeUntilMs = performance.now() + 300;
  }

  /**
   * Build the next sync payload if it's due: every 50 ms while moving or acting, every
   * 200 ms when idle. Returns null when nothing should be sent yet.
   */
  takeSync(nowMs: number, input: ActorInput, serverNow: number): SyncArgs | null {
    if (!this.alive) return null;
    const b = this.body;
    const moving =
      Math.abs(b.vx) > 1 || Math.abs(b.vy) > 1 ||
      Math.abs(b.x - this.lastSentX) > 0.5 || Math.abs(b.y - this.lastSentY) > 0.5 ||
      Math.abs(this.aim - this.lastSentAim) > 0.01 || input.fire || nowMs < this.activeUntilMs;
    const pending = this.shots.length > 0 || this.meleeAngle !== undefined || this.throwAngle !== undefined || this.wantReload;
    const interval = moving || pending ? C.SYNC_INTERVAL_MS : C.SYNC_IDLE_INTERVAL_MS;
    // An action waiting in the queue does not wait for the next 50 ms tick: send it as soon as
    // the minimum gap allows. This removes up to 50 ms from every shot/knife/throw at 250 ms.
    const gap = pending ? C.SYNC_MIN_GAP_MS : interval;
    if (nowMs - this.lastSyncMs < gap) return null;
    this.lastSyncMs = nowMs;
    this.lastSentX = b.x;
    this.lastSentY = b.y;
    this.lastSentAim = this.aim;

    let flags = 0;
    if (Math.cos(this.aim) >= 0) flags |= C.FLAG_FACING_RIGHT;
    if (b.grounded) flags |= C.FLAG_GROUNDED;
    if (b.jetting) flags |= C.FLAG_JETTING;
    if (this.reloading) flags |= C.FLAG_RELOADING;

    const args: SyncArgs = {
      seq: ++this.seq >>> 0,
      life: this.lifeId,
      corr: this.correction,
      t: serverNow,
      x: b.x,
      y: b.y,
      vx: b.vx,
      vy: b.vy,
      aim: this.aim,
      flags,
      weapon: this.weapon,
      shots: this.shots,
      melee: this.meleeAngle,
      throwG: this.throwAngle,
      reload: this.wantReload,
    };
    this.shots = [];
    this.meleeAngle = undefined;
    this.throwAngle = undefined;
    this.wantReload = false;
    return args;
  }
}
