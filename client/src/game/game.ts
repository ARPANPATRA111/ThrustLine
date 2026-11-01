// The match: fixed-step simulation of the local player (and any CPU bots hosted here),
// interpolation of remote players, server events turned into effects, and rendering.
import { type Application, Container, Sprite, type Texture, TilingSprite } from 'pixi.js';
import type { Identity } from 'spacetimedb';
import * as C from '@shared/config';
import { RIG7, MAP_H, MAP_W } from '@shared/map';
import { fuseTicks, grenadePath } from '@shared/grenade';
import { W_FRAG, W_KNIFE, W_PISTOL, W_SNIPER, canThrow, isGun, pickupActive } from '@shared/weapons';
import type { BoomEv, Grenade, HitEv, KillEv, MeleeEv, Pickup, PickupEv, Player, Pstate, Room, ShotEv } from '../module_bindings/types';
import type { Net } from '../net/connection';
import type { TimeSync } from '../net/timesync';
import { LagEstimator, SnapshotBuffer, type Sample } from '../net/interp';
import { Radar, type RadarEntry } from '../render/radar';
import type { Atlas } from '../render/atlas';
import { bakeMap, acidRect, makeAcid, makeParallaxTextures } from '../render/mapbake';
import { Particles } from '../render/particles';
import { Effects } from '../render/effects';
import { SoldierView, playerColor, playerCss } from '../render/soldier';
import type { Audio } from '../audio/audio';
import { type Hud, rankPlayers } from '../ui/hud';
import { Actor, type ActorInput, type FxSink, type SimRules, type Target, type WorldView, emptyInput } from './actor';
import { BotManager } from './bot';
import { Camera } from './camera';
import type { Input } from './input';
import type { Quality } from '../ui/settings';

const STEP = 1 / C.SIM_HZ;
const WEAPON_SOUND = ['pistol', 'ar', 'shotgun', 'sniper'] as const;

interface Remote {
  id: Identity;
  key: string;
  row: Player;
  buf: SnapshotBuffer;
  lag: LagEstimator;
  /** Time (server clock) of the position currently drawn: what a shot at it should claim. */
  viewMs: number;
  view: SoldierView;
  s: Sample;
  hasSample: boolean;
  lastLife: number;
  bounty: boolean;
}

interface GrenadeView {
  row: Grenade;
  path: Float32Array;
  ticks: number;
  thrownMs: number;
  sprite: Sprite;
}

interface PickupView {
  row: Pickup;
  sprite: Sprite;
  baseY: number;
}

// Quality steps: resolution, particle cap, parallax layer count.
const QUALITY_STEPS = [
  { res: 2, particles: C.PARTICLE_CAP_HIGH, parallax: 3 },
  { res: 1.5, particles: C.PARTICLE_CAP_HIGH, parallax: 3 },
  { res: 1, particles: C.PARTICLE_CAP_HIGH, parallax: 3 },
  { res: 1, particles: C.PARTICLE_CAP_LOW, parallax: 3 },
  { res: 1, particles: C.PARTICLE_CAP_LOW, parallax: 1 },
];

export class Game implements WorldView {
  map = RIG7;
  mode = C.MODE_ARMS;
  /** House rules of the current room (defaults until the room row arrives). */
  rules: SimRules = { ...C.DEFAULT_RULES, teams: false };
  teams = false;
  floating = false;
  maxHp = C.MAX_HP;
  pickupsOn = true;
  frenzyOn = true;
  room: Room | undefined;
  local: Actor | null = null;
  localRow: Player | null = null;
  bots = new BotManager();
  camera = new Camera();
  running = false;
  killedBy = '';
  debug = false;
  /** Counters for automated tests: hits this client dealt, explosions seen. */
  hitsDealt = 0;
  booms = 0;

  private tex: Record<string, Texture>;
  private world = new Container();
  private bg = new Container();
  private parallax: TilingSprite[] = [];
  private acid: TilingSprite;
  private acidGlow: Sprite;
  private acidR = acidRect(RIG7);
  private pickupLayer = new Container();
  private grenadeLayer = new Container();
  private playerLayer = new Container();
  private particles: Particles;
  private effects: Effects;
  private localView: SoldierView | null = null;
  private radar!: Radar;
  /** When each player last fired (server ms): reveals them on the radar. */
  private firedAt = new Map<string, number>();
  private radarEntries: RadarEntry[] = [];
  /** Faint aim line shown on touch screens (no mouse crosshair there). */
  private aimLine: Sprite;
  private remotes = new Map<string, Remote>();
  private grenades = new Map<bigint, GrenadeView>();
  private pickups = new Map<bigint, PickupView>();
  private input: ActorInput = emptyInput();
  private acc = 0;
  private wasFrenzy = false;
  private lastBeepSec = -1;
  private targetPool: Target[] = [];
  private fps = 60;
  private fpsLow = 0;
  private fpsHigh = 0;
  private qualityStep = 0;
  quality: Quality = 'auto';
  private hudTimer = 0;

  constructor(
    private app: Application,
    atlas: Atlas,
    private audio: Audio,
    private net: Net,
    private time: TimeSync,
    private controls: Input,
    private hud: Hud,
  ) {
    this.tex = atlas.tex;
    this.particles = new Particles(this.tex.square);
    this.effects = new Effects(this.tex);
    for (const t of makeParallaxTextures()) {
      const ts = new TilingSprite({ texture: t, width: 100, height: 100 });
      this.parallax.push(ts);
      this.bg.addChild(ts);
    }
    this.aimLine = new Sprite(this.tex.tracer);
    this.aimLine.anchor.set(0, 0.5);
    this.aimLine.alpha = 0.25;
    this.aimLine.scale.set(240 / 8, 0.6);
    this.acid = makeAcid(this.acidR);
    this.acidGlow = new Sprite(this.tex.dot);
    this.acidGlow.anchor.set(0.5);
    this.acidGlow.tint = 0x7cff4f;
    this.acidGlow.blendMode = 'add';
    this.acidGlow.alpha = 0.35;
    this.acidGlow.position.set(this.acidR.x + this.acidR.w / 2, this.acidR.y);
    this.acidGlow.scale.set((this.acidR.w * 1.4) / 32, 90 / 32);
    this.world.addChild(
      bakeMap(RIG7), this.acid, this.acidGlow, this.pickupLayer, this.grenadeLayer, this.playerLayer,
      this.particles.normal, this.aimLine, this.effects.layer, this.particles.additive, this.effects.textLayer,
    );
    this.radar = new Radar(this.tex, RIG7);
    app.stage.addChild(this.bg, this.world, this.radar.root);
    app.stage.visible = false;
    app.ticker.add(() => this.frame());
    app.ticker.stop();
    document.addEventListener('visibilitychange', () => {
      if (!this.running && !this.attract) return;
      if (document.hidden) app.ticker.stop();
      else app.ticker.start();
    });
    this.onResize();
    window.addEventListener('resize', () => this.onResize());
  }

  // ------------------------------------------------------------------ lifecycle

  /** Show and run the game view (playing or round-end). */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.app.stage.visible = true;
    this.app.ticker.maxFPS = 0; // uncapped during play (the display's refresh rate)
    this.acc = 0;
    this.app.ticker.start();
  }

  stop(): void {
    this.running = false;
    this.audio.setJet(false);
    this.audio.setMusic(null);
    this.setAttract(this.attract);
  }

  /** Behind the menus: render the empty map with a slow camera drift at 30 fps. */
  attract = false;
  setAttract(on: boolean): void {
    this.attract = on;
    if (this.running) return;
    if (on) {
      this.app.stage.visible = true;
      this.app.ticker.maxFPS = 30;
      this.app.ticker.start();
    } else {
      this.app.ticker.stop();
      this.app.stage.visible = false;
    }
  }

  /** Forget everything about the current room (leaving). */
  clear(): void {
    this.stop();
    this.bots.removeAll();
    for (const r of this.remotes.values()) r.view.destroy();
    this.remotes.clear();
    for (const g of this.grenades.values()) g.sprite.destroy();
    this.grenades.clear();
    for (const p of this.pickups.values()) p.sprite.destroy();
    this.pickups.clear();
    this.localView?.destroy();
    this.localView = null;
    this.local = null;
    this.localRow = null;
    this.room = undefined;
    this.wasFrenzy = false;
  }

  serverNow(): number {
    return this.time.serverNow();
  }

  get frenzy(): boolean {
    return !!this.room && this.room.state === 1 && this.frenzyOn && C.isFrenzy(this.serverNow(), Number(this.room.endsAtMicros) / 1000);
  }

  // ------------------------------------------------------------------ server data

  setRoom(r: Room | undefined): void {
    const prev = this.room;
    this.room = r;
    if (!r) return;
    this.mode = r.mode;
    this.teams = r.teams;
    this.rules = { infiniteFuel: r.rules.infiniteFuel, infiniteAmmo: r.rules.infiniteAmmo, acid: r.rules.acid, botSkill: r.rules.botSkill, teams: r.teams, friendlyFire: r.rules.friendlyFire };
    this.floating = r.rules.floatingGrenades;
    this.refreshColors();
    this.maxHp = r.rules.maxHp;
    this.pickupsOn = r.rules.pickups;
    this.frenzyOn = r.rules.frenzy;
    if (prev && prev.state === 1 && r.state === 2) {
      this.audio.play('sting', 0.8);
      this.audio.setMusic(null);
    }
    if (r.state === 1 && (!prev || prev.state !== 1 || prev.roundNo !== r.roundNo)) {
      this.wasFrenzy = false;
      this.lastBeepSec = -1;
      this.hud.reset();
      this.hud.showBanner('FIGHT!', '#22d3ee');
      this.audio.play('beep', 0.7, undefined, undefined, 1.5);
    }
  }

  /** A player row was inserted or updated. */
  playerUpsert(p: Player): void {
    const key = p.identity.toHexString();
    if (key === this.net.myKey) {
      this.localRow = p;
      if (!this.local) this.local = new Actor(p.identity, this.makeFx());
      if (!this.localView) {
        this.localView = new SoldierView(this.tex, p.name, p.colorIdx);
        this.playerLayer.addChild(this.localView.root);
      }
      const ps = this.net.conn?.db.pstate.identity.find(p.identity) ?? undefined;
      const snap = this.local.applyServer(p, ps);
      if (snap === 'respawn') {
        this.camera.follow(this.local.body.x, this.local.centerY, this.local.aim, false, 0, true);
        this.effects.ring(this.local.body.x, this.local.centerY, 60, playerColor(p.colorIdx, this.teams ? p.team : 0), 0.5, true);
      }
      this.refreshColors();
      return;
    }
    let r = this.remotes.get(key);
    if (!r) {
      r = {
        id: p.identity, key, row: p, buf: new SnapshotBuffer(), lag: new LagEstimator(), viewMs: 0, view: new SoldierView(this.tex, p.name, p.colorIdx),
        s: { x: 0, y: 0, vx: 0, vy: 0, aim: 0, flags: 0, weapon: 0 }, hasSample: false, lastLife: p.lifeId, bounty: false,
      };
      this.remotes.set(key, r);
      this.playerLayer.addChild(r.view.root);
      const ps = this.net.conn?.db.pstate.identity.find(p.identity);
      if (ps) this.pstateUpsert(ps);
    }
    if (p.lifeId !== r.lastLife) {
      // Respawned: don't interpolate from the death spot to the spawn.
      r.lastLife = p.lifeId;
      r.buf.clear();
      const ps = this.net.conn?.db.pstate.identity.find(p.identity);
      if (ps) this.pstateUpsert(ps);
    }
    r.row = p;
    r.view.setName(p.isBot ? `${p.name}` : p.name);
    this.refreshColors();
  }

  playerDelete(p: Player): void {
    const key = p.identity.toHexString();
    const r = this.remotes.get(key);
    if (r) {
      r.view.destroy();
      this.remotes.delete(key);
    }
  }

  pstateUpsert(s: Pstate): void {
    const key = s.identity.toHexString();
    const r = this.remotes.get(key);
    if (!r) return;
    // Stamp snapshots on the sender's timeline and learn how late they arrive.
    r.buf.push(s.sentMs, s);
    r.lag.sample(this.serverNow() - s.sentMs);
  }

  pickupUpsert(p: Pickup): void {
    let v = this.pickups.get(p.id);
    if (!v) {
      const sprite = new Sprite(this.tex[`pk${p.kind}`]);
      sprite.anchor.set(0.5);
      const baseY = p.ty * C.TILE + C.TILE / 2;
      sprite.position.set(p.tx * C.TILE + C.TILE / 2, baseY);
      this.pickupLayer.addChild(sprite);
      v = { row: p, sprite, baseY };
      this.pickups.set(p.id, v);
    }
    v.row = p;
  }

  pickupDelete(p: Pickup): void {
    const v = this.pickups.get(p.id);
    if (v) { v.sprite.destroy(); this.pickups.delete(p.id); }
  }

  grenadeInsert(g: Grenade): void {
    this.firedAt.set(g.owner.toHexString(), this.serverNow());
    // Pre-compute the whole deterministic flight once; drawing is then a lookup per frame.
    const ticks = fuseTicks(g.fuseMs);
    const sprite = new Sprite(this.tex.w5);
    sprite.anchor.set(0.5);
    this.grenadeLayer.addChild(sprite);
    this.grenades.set(g.id, { row: g, path: grenadePath(RIG7, g.x0, g.y0, g.vx0, g.vy0, ticks, g.zeroG), ticks, thrownMs: Number(g.thrownMicros) / 1000, sprite });
  }

  grenadeDelete(g: Grenade): void {
    const v = this.grenades.get(g.id);
    if (v) { v.sprite.destroy(); this.grenades.delete(g.id); }
  }

  // ------------------------------------------------------------------ events

  onShot(e: ShotEv): void {
    const key = e.shooter.toHexString();
    this.firedAt.set(key, this.serverNow());
    if (key === this.net.myKey) return; // our own tracers were drawn instantly
    const tracerColor = e.weapon === W_SNIPER ? 0xffffff : 0xfff2b0;
    for (let i = 0; i + 1 < e.ends.length; i += 2) {
      this.effects.tracer(e.x0, e.y0, e.ends[i], e.ends[i + 1], tracerColor, e.weapon === W_SNIPER ? 3 : 2);
      this.sparks(e.ends[i], e.ends[i + 1], 0xcfd8ff, 2);
    }
    const ang = e.ends.length >= 2 ? Math.atan2(e.ends[1] - e.y0, e.ends[0] - e.x0) : 0;
    this.effects.flash(e.x0, e.y0, ang, e.weapon === 2);
    this.audio.play(WEAPON_SOUND[e.weapon] ?? 'pistol', 0.9, e.x0, e.y0, e.weapon === 1 ? 0.95 + Math.random() * 0.1 : 1);
  }

  onHit(e: HitEv): void {
    const victimKey = e.target.toHexString();
    const attackerKey = e.attacker.toHexString();
    const vColor = this.colorOf(victimKey);
    this.sparks(e.x, e.y, vColor, 6);
    if (attackerKey === this.net.myKey && victimKey !== this.net.myKey) {
      this.hitsDealt++;
      const sx = (e.x - this.camera.left) * this.camera.zoom;
      const sy = (e.y - this.camera.top) * this.camera.zoom;
      this.hud.hit(sx, sy, e.killed);
      this.effects.damageNumber(e.x, e.y - 20, e.dmg, e.killed ? 0xff4d6d : 0xffffff);
      this.audio.play('hit', 0.6, undefined, undefined, e.killed ? 0.7 : 1);
      if (this.controls.usingTouch) navigator.vibrate?.(15);
    }
    if (victimKey === this.net.myKey) {
      let angle: number | null = null;
      const src = this.positionOf(attackerKey);
      if (src && attackerKey !== victimKey && this.local) angle = Math.atan2(src.y - this.local.centerY, src.x - this.local.body.x);
      this.hud.hurt(angle);
      this.audio.play('hurt', 0.8);
      this.camera.shake(4);
    }
  }

  onKill(e: KillEv): void {
    const vKey = e.victim.toHexString();
    const kKey = e.killer.toHexString();
    const victim = this.rowOf(vKey);
    const killer = this.rowOf(kKey);
    const self = vKey === kKey || e.cause === C.CAUSE_ACID;
    const css = (p?: Player) => playerCss(p?.colorIdx ?? 0, this.teams ? p?.team ?? 0 : 0);
    this.hud.killFeed(self ? '' : killer?.name ?? '?', css(killer), e.cause, victim?.name ?? '?', css(victim), e.teamkill);
    const pos = this.positionOf(vKey);
    if (pos) this.deathBurst(pos.x, pos.y, this.colorOf(vKey));
    if (vKey === this.net.myKey) {
      this.killedBy = self ? (e.cause === C.CAUSE_ACID ? 'Dissolved in acid' : 'Blown up by your own grenade') : `Eliminated by ${killer?.name ?? '?'}`;
    }
    if (kKey === this.net.myKey && !self) {
      this.hud.showBanner(e.bounty ? 'BOUNTY! +150' : '+100', e.bounty ? '#ffd54a' : '#22d3ee', 1.2);
    }
  }

  onMelee(e: MeleeEv): void {
    this.firedAt.set(e.attacker.toHexString(), this.serverNow());
    if (e.attacker.toHexString() === this.net.myKey) return;
    this.effects.slash(e.x, e.y, e.dir, this.colorOf(e.attacker.toHexString()));
    this.audio.play('knife', 0.8, e.x, e.y);
  }

  onBoom(e: BoomEv): void {
    this.booms++;
    this.explosion(e.x, e.y);
    this.local?.knockback(RIG7, e.x, e.y);
    this.bots.knockback(this, e.x, e.y);
  }

  onPickup(e: PickupEv): void {
    const v = this.pickups.get(e.pickupId);
    if (v) this.effects.ring(v.sprite.x, v.sprite.y, 40, [0xff4d6d, 0xfbbf24, 0x7cff4f][e.kind] ?? 0xffffff, 0.4, true);
    if (e.identity.toHexString() === this.net.myKey) this.audio.play('pickup', 0.7);
  }

  // ------------------------------------------------------------------ helpers for events

  private rowOf(key: string): Player | undefined {
    if (key === this.net.myKey) return this.localRow ?? undefined;
    return this.remotes.get(key)?.row;
  }

  /** Re-tint every soldier: team colours in team matches (plus an ally chevron), else own colour. */
  refreshColors(): void {
    const myTeam = this.teams ? this.localRow?.team ?? 0 : 0;
    if (this.localRow && this.localView) this.localView.setColor(this.localRow.colorIdx, myTeam, false);
    for (const r of this.remotes.values()) {
      const team = this.teams ? r.row.team : 0;
      r.view.setColor(r.row.colorIdx, team, team !== 0 && team === myTeam);
    }
  }

  private colorOf(key: string): number {
    const row = this.rowOf(key);
    return playerColor(row?.colorIdx ?? 0, this.teams ? row?.team ?? 0 : 0);
  }

  /** Where a player is drawn right now (centre). */
  private positionOf(key: string): { x: number; y: number } | null {
    if (key === this.net.myKey && this.local) return { x: this.local.body.x, y: this.local.centerY };
    const r = this.remotes.get(key);
    if (r && r.hasSample) return { x: r.s.x, y: r.s.y - C.PLAYER_H / 2 };
    return null;
  }

  private sparks(x: number, y: number, color: number, n: number): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 120 + Math.random() * 260;
      this.particles.emit({ tex: this.tex.spark, x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.25 + Math.random() * 0.2, scale0: 1, scale1: 0.3, color, additive: true, gravity: 600, drag: 2, align: true });
    }
  }

  private deathBurst(x: number, y: number, color: number): void {
    for (let i = 0; i < 18; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 100 + Math.random() * 300;
      this.particles.emit({ tex: this.tex.dot, x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.5 + Math.random() * 0.3, scale0: 0.7, scale1: 0.1, color, additive: true, drag: 3 });
    }
    // Body parts scatter.
    for (const name of ['helmet', 'torso', 'leg', 'leg', 'jetpack']) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.2;
      const sp = 250 + Math.random() * 250;
      this.particles.emit({ tex: this.tex[name], x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1.1, scale0: 1, scale1: 0.8, color: name === 'helmet' || name === 'torso' ? color : 0xffffff, gravity: 1400, spin: (Math.random() - 0.5) * 14 });
    }
    this.effects.ring(x, y, 50, color, 0.4, true);
  }

  private explosion(x: number, y: number): void {
    this.effects.ring(x, y, C.GRENADE_BLAST_RADIUS, 0xffd54a, 0.35);
    this.effects.ring(x, y, C.GRENADE_BLAST_RADIUS * 1.4, 0xffffff, 0.5, true);
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 40 + Math.random() * 160;
      this.particles.emit({ tex: this.tex.smoke, x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 40, life: 0.9 + Math.random() * 0.5, scale0: 1.2, scale1: 3, color: 0x3a4570, alpha: 0.8, drag: 2.5 });
    }
    for (let i = 0; i < 10; i++) {
      const a = Math.random() * Math.PI * 2;
      this.particles.emit({ tex: this.tex.dot, x, y, vx: Math.cos(a) * 200, vy: Math.sin(a) * 200, life: 0.35, scale0: 2.5, scale1: 0.5, color: 0xffb35c, additive: true, drag: 4 });
    }
    this.sparks(x, y, 0xffd54a, 14);
    this.audio.play('boom', 1, x, y);
    if (this.local) {
      const d = Math.hypot(this.local.body.x - x, this.local.centerY - y);
      this.camera.shake(Math.max(2, 16 * (1 - d / 900)));
    }
  }

  /** The local player's side effects (sounds, flashes, tracers). */
  private makeFx(): FxSink {
    return {
      shot: (w, ox, oy, ends, wallHits) => {
        for (let i = 0; i + 1 < ends.length; i += 2) {
          this.effects.tracer(ox, oy, ends[i], ends[i + 1], w === W_SNIPER ? 0xffffff : 0xfff2b0, w === W_SNIPER ? 3 : 2);
          if (wallHits[i / 2]) this.sparks(ends[i], ends[i + 1], 0xcfd8ff, 3);
        }
        const a = this.local ? this.local.aim : 0;
        this.effects.flash(ox, oy, a, w === 2);
        this.audio.play(WEAPON_SOUND[w] ?? 'pistol', 0.85, undefined, undefined, w === 1 ? 0.95 + Math.random() * 0.1 : 1);
      },
      melee: (x, y, angle) => {
        this.effects.slash(x, y, angle, this.localRow ? this.colorOf(this.net.myKey) : 0xffffff);
        this.audio.play('knife', 0.8);
      },
      throwG: () => this.audio.play('knife', 0.5, undefined, undefined, 0.6),
      empty: () => this.audio.play('empty', 0.7),
      reload: () => this.audio.play('reload', 0.7),
      shake: (n) => this.camera.shake(n),
    };
  }

  // ------------------------------------------------------------------ WorldView

  /** Everyone hittable by `selfKey`: alive, not spawn-protected; positions as drawn here. */
  targets(selfKey: string, out: Target[]): number {
    const now = this.serverNow();
    let n = 0;
    const push = (id: Identity, key: string, x: number, y: number, team: number, viewMs: number) => {
      let t = this.targetPool[n];
      if (!t) { t = { id, key, x, y, team, viewMs }; this.targetPool[n] = t; }
      t.id = id; t.key = key; t.x = x; t.y = y; t.team = this.teams ? team : 0; t.viewMs = viewMs;
      out[n++] = t;
    };
    if (this.local && this.localRow && this.local.alive && this.net.myKey !== selfKey && Number(this.localRow.spawnProtectUntilMicros) / 1000 <= now) {
      push(this.local.identity, this.net.myKey, this.local.body.x, this.local.body.y, this.localRow.team, now);
    }
    for (const r of this.remotes.values()) {
      if (r.key === selfKey || !r.row.alive || !r.hasSample || Number(r.row.spawnProtectUntilMicros) / 1000 > now) continue;
      // Bots hosted in this tab: use their exact simulated position.
      const bot = this.bots.get(r.key);
      if (bot) push(r.id, r.key, bot.actor.body.x, bot.actor.body.y, r.row.team, now);
      else push(r.id, r.key, r.s.x, r.s.y, r.row.team, r.viewMs);
    }
    out.length = n;
    return n;
  }

  // ------------------------------------------------------------------ frame loop

  private frame(): void {
    const dt = Math.min(this.app.ticker.deltaMS / 1000, 0.1);
    const now = this.serverNow();
    const playing = this.room?.state === 1;
    const frenzy = this.frenzy;
    const runMul = this.mode === C.MODE_BLADES ? C.BLADES_RUN_MUL : 1;
    const fuelMul = frenzy ? C.FRENZY_FUEL_MUL : 1;
    if (!playing && !this.running) this.attractCamera(dt);

    // --- Fixed 60 Hz simulation with an accumulator ---
    const local = this.local;
    if (local && playing) {
      this.controls.read(this.input, (sx, sy) => {
        const w = this.camera.screenToWorld(sx, sy);
        return Math.atan2(w.y - local.centerY, w.x - local.body.x);
      }, local.aim);
    }
    this.acc += dt;
    let steps = 0;
    while (this.acc >= STEP) {
      this.acc -= STEP;
      if (playing) {
        if (local) local.step(this.input, STEP, this, runMul, fuelMul);
        this.bots.step(this, runMul, fuelMul);
      }
      if (steps === 0) {
        // One-shot presses apply to exactly one step.
        this.controls.clearEdges();
        this.input.firePressed = this.input.melee = this.input.grenade = this.input.swap = this.input.reload = false;
      }
      steps++;
    }
    const alpha = this.acc / STEP;

    // --- Send our sync if due ---
    if (local && playing) {
      const args = local.takeSync(performance.now(), this.input, now);
      if (args) this.net.conn?.reducers.sync(args).catch(() => {});
    }

    // --- Draw the local player between the last two steps ---
    if (local && this.localView && this.localRow) {
      const show = local.alive && playing;
      this.localView.root.visible = show;
      if (show) {
        const x = local.prevX + (local.body.x - local.prevX) * alpha;
        const y = local.prevY + (local.body.y - local.prevY) * alpha;
        const b = local.body;
        const flags = (b.grounded ? C.FLAG_GROUNDED : 0) | (b.jetting ? C.FLAG_JETTING : 0);
        const bounty = this.localRow.streak >= C.BOUNTY_STREAK;
        this.localView.update(x, y, local.aim, b.vx, flags, local.weapon, dt, bounty, Number(this.localRow.spawnProtectUntilMicros) / 1000 > now);
        this.localView.refreshColor(this.localRow.colorIdx, bounty);
        this.aimLine.position.set(x, y - 30);
        this.aimLine.rotation = local.aim;
        const sniper = local.weapon === W_SNIPER;
        this.camera.follow(x, y - C.PLAYER_H / 2, local.aim, sniper, dt);
      }
      this.aimLine.visible = show && this.controls.usingTouch;
      this.audio.setJet(show && local.body.jetting);
    }

    // --- Remote players, each drawn a little in the past (adaptive to its measured lag) ---
    for (const r of this.remotes.values()) {
      const renderT = now - r.lag.update(dt);
      r.viewMs = renderT;
      const bot = this.bots.get(r.key);
      if (bot && bot.actor.alive) {
        const b = bot.actor.body;
        r.s.x = bot.actor.prevX + (b.x - bot.actor.prevX) * alpha;
        r.s.y = bot.actor.prevY + (b.y - bot.actor.prevY) * alpha;
        r.s.vx = b.vx;
        r.s.vy = b.vy;
        r.s.aim = bot.actor.aim;
        r.s.flags = (b.grounded ? C.FLAG_GROUNDED : 0) | (b.jetting ? C.FLAG_JETTING : 0);
        r.s.weapon = bot.actor.weapon;
        r.hasSample = true;
      } else {
        r.hasSample = r.buf.sample(renderT, r.s);
      }
      const show = r.hasSample && r.row.alive && playing;
      r.view.root.visible = show;
      if (!show) continue;
      const bounty = r.row.streak >= C.BOUNTY_STREAK;
      if (bounty !== r.bounty) { r.bounty = bounty; r.view.refreshColor(r.row.colorIdx, bounty); }
      r.view.update(r.s.x, r.s.y, r.s.aim, r.s.vx, r.s.flags, r.s.weapon, dt, bounty, Number(r.row.spawnProtectUntilMicros) / 1000 > now);
    }

    // --- Grenades: look up the precomputed path at the current server time ---
    for (const g of this.grenades.values()) {
      const tf = Math.max(0, Math.min(g.ticks, ((now - g.thrownMs) * C.GRENADE_TICK_HZ) / 1000));
      const i = Math.floor(tf);
      const j = Math.min(g.ticks, i + 1);
      const f = tf - i;
      g.sprite.x = g.path[i * 2] + (g.path[j * 2] - g.path[i * 2]) * f;
      g.sprite.y = g.path[i * 2 + 1] + (g.path[j * 2 + 1] - g.path[i * 2 + 1]) * f;
      g.sprite.rotation += dt * 8 * Math.sign(g.row.vx0 || 1) * Math.min(1, (g.ticks - tf) / 60 + 0.2);
      // Blink faster as the fuse runs out.
      const left = (g.ticks - tf) / C.GRENADE_TICK_HZ;
      g.sprite.tint = left < 1 && Math.floor(now / (left < 0.4 ? 60 : 140)) % 2 === 0 ? 0xff4d6d : 0xffffff;
    }

    // --- Pickups bob, hidden while respawning ---
    const tSec = now / 1000;
    for (const p of this.pickups.values()) {
      const avail = this.pickupsOn && p.row.availableAtMicros === 0n && pickupActive(this.mode, p.row.kind);
      p.sprite.visible = avail;
      if (avail) p.sprite.y = p.baseY - 6 + Math.sin(tSec * 3 + p.row.tx) * 3;
    }

    // --- Acid ---
    this.acid.tilePosition.x += dt * 18;
    this.acidGlow.alpha = (this.rules.acid ? 0.3 : 0.12) + Math.sin(tSec * 2) * 0.08;
    if (Math.random() < dt * 8) {
      this.particles.emit({ tex: this.tex.bubbleAcid, x: this.acidR.x + Math.random() * this.acidR.w, y: this.acidR.y + 6, vx: 0, vy: -20 - Math.random() * 30, life: 0.8, scale0: 0.6, scale1: 1.4, color: 0xb8ff9a, additive: true });
    }

    // --- Camera, world transform, parallax ---
    const cam = this.camera;
    if ((!local || !local.alive || !playing) && this.running) cam.follow(cam.x, cam.y, 0, false, dt);
    const z = cam.zoom;
    this.world.scale.set(z);
    this.world.position.set(Math.round((-cam.left + cam.shakeX) * z), Math.round((-cam.top + cam.shakeY) * z));
    const sw = this.app.screen.width;
    const sh = this.app.screen.height;
    const factors = [0.15, 0.4, 0.7];
    const layers = QUALITY_STEPS[this.qualityStep].parallax;
    this.parallax.forEach((p, i) => {
      p.visible = i < layers;
      const scale = (sh / 512) * 1.15;
      p.tileScale.set(scale);
      p.tilePosition.x = -cam.left * factors[i] * z;
      p.tilePosition.y = -(sh * 0.15) * (cam.top / Math.max(1, MAP_H - cam.viewH)) * (i + 1) * 0.5;
      p.width = sw;
      p.height = sh;
    });

    this.particles.update(dt, cam.left, cam.top, cam.right, cam.bottom);
    this.effects.update(dt);
    this.audio.listenerX = cam.x;
    this.audio.listenerY = cam.y;
    this.audio.hearing = cam.viewW / 2;

    // --- Music and Frenzy ---
    if (playing) {
      this.audio.setMusic(frenzy ? 'musicFrenzy' : 'music');
      if (frenzy && !this.wasFrenzy) {
        this.hud.showBanner('FRENZY', '#ff4d6d', 2.2);
        this.audio.play('alarm', 0.8);
      }
      this.wasFrenzy = frenzy;
      const leftSec = Math.ceil((Number(this.room!.endsAtMicros) / 1000 - now) / 1000);
      if (leftSec <= 5 && leftSec >= 1 && leftSec !== this.lastBeepSec) {
        this.lastBeepSec = leftSec;
        this.audio.play('beep', 0.6);
      }
    }

    // --- HUD (DOM writes only on change) ---
    this.hudTimer -= dt;
    this.updateHud(now, frenzy);
    this.hud.update(dt);
    if (!this.controls.usingTouch) this.hud.setCrosshair(this.controls.mouseX, this.controls.mouseY);
    if (playing) this.updateRadar(now);
    this.radar.root.visible = playing && !!this.localRow;
    this.governQuality(dt);
  }

  private updateHud(now: number, frenzy: boolean): void {
    const r = this.room;
    const local = this.local;
    const row = this.localRow;
    if (r && !this.time.synced) {
      this.hud.setTimer('-:--', false);
    } else if (r) {
      const left = r.state === 1 ? Math.max(0, Number(r.endsAtMicros) / 1000 - now) : 0;
      const s = Math.ceil(left / 1000);
      this.hud.setTimer(frenzy ? `FRENZY ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`, frenzy);
    }
    if (local && row) {
      this.hud.setHP(row.alive ? row.hp : 0, this.maxHp);
      this.hud.setFuel(local.body.fuel, this.rules.infiniteFuel);
      this.hud.setWeapon(local.weapon);
      const w = local.weapon;
      if (isGun(w)) {
        if (this.rules.infiniteAmmo) this.hud.setAmmo('∞', '');
        else this.hud.setAmmo(String(w === W_PISTOL ? local.pistolMag : local.mag), w === W_PISTOL ? '/∞' : `/${local.reserve}`);
      } else if (w === W_FRAG) {
        this.hud.setAmmo('∞', '');
      } else {
        this.hud.setAmmo(w === W_KNIFE ? '—' : '', '');
      }
      this.hud.setNades(this.mode === C.MODE_ARMS ? (this.rules.infiniteAmmo ? '● ∞' : '● '.repeat(local.grenades).trim() || '○') : '');
      this.hud.setReloading(local.reloading && isGun(w));
    }
    if (this.hudTimer <= 0) {
      this.hudTimer = 0.25;
      this.hud.setNet(this.time.synced ? this.time.rtt : null, this.fps);
      this.hud.setTeamScore(this.teams ? this.teamScores() : null, this.teams ? this.localRow?.team ?? 0 : 0);
      const players = this.allPlayers();
      this.hud.setMiniBoard(rankPlayers(players), this.net.myKey, this.teams);
      if (this.debug) {
        this.hud.setDebug(
          `FPS ${this.fps.toFixed(0)}\nRTT ${this.time.rtt.toFixed(0)} ms\nRenderer ${this.app.renderer.name}\nPlayers ${players.length}\nQuality ${this.quality} (step ${this.qualityStep})\nParticles cap ${this.particles.cap}`,
        );
      } else this.hud.setDebug(null);
    }
  }

  /** Slow, smooth drift across the map for the menu background. */
  private attractT = Math.random() * 100;
  private attractCamera(dt: number): void {
    this.attractT += dt;
    const t = this.attractT * 0.05;
    const cam = this.camera;
    cam.x = MAP_W / 2 + Math.sin(t) * (MAP_W / 2 - cam.viewW / 2);
    cam.y = MAP_H * 0.62 + Math.sin(t * 1.7) * MAP_H * 0.25;
    cam.clamp();
  }

  /** Which touch buttons make sense right now (mode + rules). */
  touchButtons(): { reload: boolean; swap: boolean; grenade: boolean; melee: boolean } {
    const m = this.mode;
    return {
      reload: (m === C.MODE_ARMS || m === C.MODE_SNIPERS) && !this.rules.infiniteAmmo,
      swap: m === C.MODE_ARMS || m === C.MODE_SNIPERS,
      grenade: canThrow(m),
      melee: m !== C.MODE_BLADES, // in Blades the fire stick already swings the knife
    };
  }

  private updateRadar(now: number): void {
    const out = this.radarEntries;
    out.length = 0;
    const myTeam = this.teams ? this.localRow?.team ?? 0 : 0;
    if (this.local?.alive) out.push({ x: this.local.body.x, y: this.local.centerY, color: 0xffffff, kind: 'me', firedAgo: Infinity });
    for (const r of this.remotes.values()) {
      if (!r.row.alive || !r.hasSample) continue;
      const ally = myTeam !== 0 && r.row.team === myTeam;
      const fired = this.firedAt.get(r.key);
      out.push({ x: r.s.x, y: r.s.y - C.PLAYER_H / 2, color: this.colorOf(r.key), kind: ally ? 'ally' : 'enemy', firedAgo: fired === undefined ? Infinity : now - fired });
    }
    const cam = this.camera;
    const z = cam.zoom;
    this.radar.update(out, { l: cam.left, t: cam.top, r: cam.right, b: cam.bottom }, (x, y) => ({ sx: (x - cam.left) * z, sy: (y - cam.top) * z }), this.app.screen.width, this.app.screen.height);
  }

  /** Team totals (sum of member scores) for team matches. */
  teamScores(): [number, number] {
    let red = 0, blue = 0;
    for (const p of this.allPlayers()) {
      if (p.team === C.TEAM_RED) red += p.score;
      else if (p.team === C.TEAM_BLUE) blue += p.score;
    }
    return [red, blue];
  }

  /** Snapshot of what this client sees, for automated tests (window.__tl.game.debugState()). */
  debugState() {
    const cam = this.camera;
    const toScreen = (x: number, y: number) => ({ sx: (x - cam.left) * cam.zoom, sy: (y - cam.top) * cam.zoom });
    return {
      room: this.room ? { code: this.room.code, state: this.room.state } : null,
      me: this.local ? { x: this.local.body.x, y: this.local.body.y, alive: this.local.alive, weapon: this.local.weapon, grenades: this.local.grenades, ...toScreen(this.local.body.x, this.local.centerY) } : null,
      mode: this.mode,
      hitsDealt: this.hitsDealt,
      booms: this.booms,
      remotes: [...this.remotes.values()].map((r) => ({ name: r.row.name, alive: r.row.alive, x: r.s.x, y: r.s.y, ...toScreen(r.s.x, r.s.y - C.PLAYER_H / 2) })),
      kills: this.allPlayers().reduce((n, p) => n + p.kills, 0),
      renderer: this.app.renderer.name,
    };
  }

  allPlayers(): Player[] {
    const list: Player[] = [];
    if (this.localRow) list.push(this.localRow);
    for (const r of this.remotes.values()) list.push(r.row);
    return list;
  }

  // ------------------------------------------------------------------ quality governor

  setQuality(q: Quality): void {
    this.quality = q;
    this.applyQualityStep(q === 'low' ? QUALITY_STEPS.length - 1 : 0);
  }

  private applyQualityStep(step: number): void {
    this.qualityStep = step;
    const qs = QUALITY_STEPS[step];
    const res = Math.min(window.devicePixelRatio || 1, qs.res);
    if (this.app.renderer.resolution !== res) {
      this.app.renderer.resolution = res;
      this.onResize();
    }
    this.particles.cap = qs.particles;
  }

  /** Auto quality: step down after 3 s under 50 fps, back up after 10 s above 58. */
  private governQuality(dt: number): void {
    const inst = 1 / Math.max(dt, 1e-3);
    this.fps += (inst - this.fps) * Math.min(1, dt * 2);
    if (this.quality !== 'auto') return;
    if (this.fps < 50) { this.fpsLow += dt; this.fpsHigh = 0; }
    else if (this.fps > 58) { this.fpsHigh += dt; this.fpsLow = 0; }
    else { this.fpsLow = 0; this.fpsHigh = 0; }
    if (this.fpsLow > 3 && this.qualityStep < QUALITY_STEPS.length - 1) { this.applyQualityStep(this.qualityStep + 1); this.fpsLow = 0; }
    if (this.fpsHigh > 10 && this.qualityStep > 0) { this.applyQualityStep(this.qualityStep - 1); this.fpsHigh = 0; }
  }

  onResize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.app.renderer.resize(w, h);
    this.camera.resize(w, h);
    this.radar?.layout(w, h);
    this.camera.clamp();
  }

  /** Fraction of the respawn countdown remaining (for the overlay). */
  respawnLeft(): number {
    if (!this.localRow || this.localRow.respawnAtMicros === 0n) return 0;
    return Math.max(0, Number(this.localRow.respawnAtMicros) / 1000 - this.serverNow());
  }

}
