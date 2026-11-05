// The match: fixed-step simulation of the local player (and any CPU bots hosted here),
// interpolation of remote players, server events turned into effects, and rendering.
import { type Application, Container, Graphics, Sprite, type Texture, TilingSprite } from 'pixi.js';
import type { Identity } from 'spacetimedb';
import * as C from '@shared/config';
import { MAPS, MAP_H, MAP_NAMES, MAP_W, PICKUP_DROP, PICKUP_SHIELD, inZone, movesAround } from '@shared/map';
import { fuseTicks, grenadePath } from '@shared/grenade';
import { W_FRAG, W_KNIFE, W_PISTOL, W_RAIL, W_SMG, W_SNIPER, canThrow, isGun, pickupActive } from '@shared/weapons';
import type { BoomEv, EmoteEv, Grenade, Hill, HitEv, KillEv, MeleeEv, NoticeEv, Pickup, PickupEv, Player, Pstate, Room, ShotEv } from '../module_bindings/types';
import type { Net } from '../net/connection';
import type { TimeSync } from '../net/timesync';
import { LagEstimator, SnapshotBuffer, type Sample } from '../net/interp';
import { Radar, type RadarEntry } from '../render/radar';
import type { Atlas } from '../render/atlas';
import { bakeMap, acidRect, makeAcid, makeParallaxTextures } from '../render/mapbake';
import { stickerTextures } from '../render/stickers';
import { Particles } from '../render/particles';
import { Effects } from '../render/effects';
import { SoldierView, playerColor, playerCss } from '../render/soldier';
import type { Audio } from '../audio/audio';
import { CAUSE_NAMES, type Hud, rankPlayers } from '../ui/hud';
import { Actor, type ActorInput, type FxSink, type SimRules, type Target, type WorldView, emptyInput } from './actor';
import { BotManager } from './bot';
import { Camera } from './camera';
import type { Input } from './input';
import type { Quality } from '../ui/settings';

const STEP = 1 / C.SIM_HZ;
/** Gun id -> sound name (knife and frag have their own cues). */
const WEAPON_SOUND: Record<number, 'pistol' | 'ar' | 'smg' | 'shotgun' | 'sniper' | 'rail'> = {
  [W_PISTOL]: 'pistol',
  1: 'ar',
  2: 'shotgun',
  [W_SNIPER]: 'sniper',
  [W_SMG]: 'smg',
  [W_RAIL]: 'rail',
};
/** Tracer colour and thickness per gun. */
function tracerStyle(w: number): { color: number; width: number; fadeMs: number } {
  if (w === W_RAIL) return { color: 0x67e8f9, width: 7, fadeMs: 420 }; // a beam that hangs in the air
  if (w === W_SNIPER) return { color: 0xffffff, width: 3, fadeMs: C.TRACER_FADE_MS * 2 };
  return { color: 0xfff2b0, width: 2, fadeMs: C.TRACER_FADE_MS };
}
/** Rapid-fire guns get a little pitch jitter so long bursts don't sound like a machine. */
function gunPitch(w: number): number {
  return w === 1 || w === W_SMG ? 0.95 + Math.random() * 0.1 : 1;
}

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
  /** Airdrop crates fall on a parachute. */
  chute: Sprite | null;
}

/** An emote sticker floating above a player (or frozen at a dead player's death spot). */
interface EmoteView {
  index: number;
  sprite: Sprite;
  started: number;
  until: number;
  /** Centre position when it cannot follow a live player. */
  x: number;
  y: number;
  /** True while the sender is alive: keep the emote above their head. */
  follow: boolean;
}

/** Drawn size of an emote sticker in world pixels. */
const EMOTE_PX = 96;

// Quality steps: resolution, particle cap, parallax layer count.
const QUALITY_STEPS = [
  { res: 2, particles: C.PARTICLE_CAP_HIGH, parallax: 3 },
  { res: 1.5, particles: C.PARTICLE_CAP_HIGH, parallax: 3 },
  { res: 1, particles: C.PARTICLE_CAP_HIGH, parallax: 3 },
  { res: 1, particles: C.PARTICLE_CAP_LOW, parallax: 3 },
  { res: 1, particles: C.PARTICLE_CAP_LOW, parallax: 1 },
];

export class Game implements WorldView {
  map = MAPS[0];
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
  /** Second line of the death screen: what killed you and how the fight went. */
  killRecap = '';
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
  private mapId = -1;
  /** The map being shown; each map is baked once, the first time it is played. */
  private mapLayer = new Container();
  private baked = new Map<number, Container>();
  private acidR = acidRect(MAPS[0]);
  /** Sudden death: a sheet of acid across the whole map, rising from the floor. */
  private acidSheet: TilingSprite;
  private wasSuddenDeath = false;
  /** King of the Hill: the live zone and how it is drawn. */
  private hill: Hill | null = null;
  private hillGfx = new Graphics();
  private pickupLayer = new Container();
  private grenadeLayer = new Container();
  private playerLayer = new Container();
  private emoteLayer = new Container();
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
  private emotes = new Map<string, EmoteView>();
  /** Where the local player died: the camera holds here until respawn. */
  private deathSpot: { x: number; y: number } | null = null;
  /** How far the player has panned away from the death spot while waiting. */
  private lookX = 0;
  private lookY = 0;
  /** Damage this life to each player, for the death recap. */
  private dealt = new Map<string, number>();
  /** Player setting: share of the particle budget to use, 0..1. */
  private particleScale = 1;
  /** Local-clock time of the last emote this client sent (optimistic rate limit). */
  private localEmoteAt = 0;
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
    this.acidSheet = makeAcid({ x: 0, y: 0, w: MAP_W, h: MAP_H });
    this.acidSheet.alpha = 0.72;
    this.acidSheet.visible = false;
    this.hillGfx.visible = false;
    this.world.addChild(
      this.mapLayer, this.acid, this.acidGlow, this.hillGfx, this.pickupLayer, this.grenadeLayer, this.playerLayer, this.emoteLayer, this.acidSheet,
      this.particles.normal, this.aimLine, this.effects.layer, this.particles.additive, this.effects.textLayer,
    );
    this.radar = new Radar(this.tex);
    this.setMap(0);
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
    for (const em of this.emotes.values()) em.sprite.destroy();
    this.emotes.clear();
    this.deathSpot = null;
    this.localEmoteAt = 0;
    this.hill = null;
    this.hillGfx.visible = false;
    this.hud.setHill(null, '');
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

  /** Switch arenas: tiles, acid pit, minimap and the hill zone all follow. */
  private setMap(id: number): void {
    if (id === this.mapId) return;
    this.mapId = id;
    this.map = MAPS[id] ?? MAPS[0];
    let layer = this.baked.get(id);
    if (!layer) {
      layer = bakeMap(this.map);
      this.baked.set(id, layer);
    }
    this.mapLayer.removeChildren();
    this.mapLayer.addChild(layer);
    this.acidR = acidRect(this.map);
    this.acid.position.set(this.acidR.x, this.acidR.y);
    this.acid.width = this.acidR.w;
    this.acid.height = this.acidR.h;
    this.acidGlow.position.set(this.acidR.x + this.acidR.w / 2, this.acidR.y);
    this.acidGlow.scale.set((this.acidR.w * 1.4) / 32, 90 / 32);
    this.radar.setMap(id, this.map);
    this.drawHill();
  }

  get frenzy(): boolean {
    return !!this.room && this.room.state === 1 && this.frenzyOn && C.isFrenzy(this.serverNow(), Number(this.room.endsAtMicros) / 1000);
  }

  // ------------------------------------------------------------------ server data

  setRoom(r: Room | undefined): void {
    const prev = this.room;
    this.room = r;
    if (!r) return;
    this.setMap(r.mapId);
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
      this.wasSuddenDeath = false;
      this.lastBeepSec = -1;
      this.hud.reset();
      this.hud.showBanner('FIGHT!', '#22d3ee');
      const objective = r.match.objective === C.OBJECTIVE_HILL ? 'KING OF THE HILL' : 'DEATHMATCH';
      this.hud.showNotice(`${objective} · ${MAP_NAMES[r.mapId] ?? ''}`, '#eef2ff', 3);
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
      const wasAlive = this.local.alive;
      const snap = this.local.applyServer(p, ps);
      if (snap === 'respawn') {
        this.deathSpot = null;
        this.lookX = this.lookY = 0;
        this.dealt.clear();
        this.camera.follow(this.local.body.x, this.local.centerY, this.local.aim, false, 0, true);
        this.effects.ring(this.local.body.x, this.local.centerY, 60, playerColor(p.colorIdx, this.teams ? p.team : 0), 0.5, true);
      } else if (wasAlive && !p.alive) {
        // Freeze the camera and any live emote on the exact spot where we died.
        this.deathSpot = { x: this.local.body.x, y: this.local.centerY };
        this.camera.snapTo(this.deathSpot.x, this.deathSpot.y);
        const em = this.emotes.get(this.net.myKey);
        if (em) {
          em.follow = false;
          em.x = this.deathSpot.x;
          em.y = this.deathSpot.y;
        }
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
    this.dropEmote(key);
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
      let chute: Sprite | null = null;
      if (p.kind === PICKUP_DROP) {
        chute = new Sprite(this.tex.chute);
        chute.anchor.set(0.5, 1);
        chute.y = -12;
        sprite.addChild(chute);
      }
      v = { row: p, sprite, baseY, chute };
      this.pickups.set(p.id, v);
    } else if (p.kind === PICKUP_DROP && v.row.availableAtMicros !== 0n && p.availableAtMicros === 0n) {
      this.effects.ring(v.sprite.x, v.baseY, 70, 0xffd54a, 0.5, true); // touchdown
    } else if (v.row.tx !== p.tx || v.row.ty !== p.ty) {
      // Health and shields come back somewhere new.
      v.baseY = p.ty * C.TILE + C.TILE / 2;
      v.sprite.position.set(p.tx * C.TILE + C.TILE / 2, v.baseY);
      this.effects.ring(v.sprite.x, v.baseY, 50, p.kind === PICKUP_SHIELD ? 0x22d3ee : 0xff4d6d, 0.5, true);
    }
    v.row = p;
  }

  pickupDelete(p: Pickup): void {
    const v = this.pickups.get(p.id);
    if (v) { v.sprite.destroy(); this.pickups.delete(p.id); }
  }

  hillUpsert(h: Hill): void {
    const moved = this.hill?.idx !== h.idx;
    this.hill = h;
    if (moved) this.drawHill();
  }

  hillDelete(): void {
    this.hill = null;
    this.hillGfx.visible = false;
    this.hud.setHill(null, '');
  }

  /** Is the zone held by me or my team? */
  private hillIsMine(h: Hill): boolean {
    if (h.state !== C.HILL_HELD) return false;
    return this.teams ? h.team === this.localRow?.team : h.holder?.toHexString() === this.net.myKey;
  }

  private hillColor(h: Hill): number {
    if (h.state === C.HILL_CONTESTED) return 0xff4d6d;
    if (h.state === C.HILL_EMPTY) return 0x22d3ee;
    if (this.hillIsMine(h)) return document.body.classList.contains('cb') ? 0x56b4e9 : 0x7cff4f;
    return 0xffd54a;
  }

  private drawHill(): void {
    const h = this.hill;
    if (!h) return;
    const z = this.map.hills[h.idx];
    const pad = 3;
    this.hillGfx.clear()
      .rect(z.tx * C.TILE, z.ty * C.TILE, z.tw * C.TILE, z.th * C.TILE).fill({ color: 0xffffff, alpha: 0.13 })
      .rect(z.tx * C.TILE + pad, z.ty * C.TILE + pad, z.tw * C.TILE - pad * 2, z.th * C.TILE - pad * 2).stroke({ width: 3, color: 0xffffff, alpha: 0.9 });
    this.hillGfx.visible = true;
  }

  grenadeInsert(g: Grenade): void {
    this.firedAt.set(g.owner.toHexString(), this.serverNow());
    // Pre-compute the whole deterministic flight once; drawing is then a lookup per frame.
    const ticks = fuseTicks(g.fuseMs);
    const sprite = new Sprite(this.tex.w5);
    sprite.anchor.set(0.5);
    this.grenadeLayer.addChild(sprite);
    this.grenades.set(g.id, { row: g, path: grenadePath(this.map, g.x0, g.y0, g.vx0, g.vy0, ticks, g.zeroG), ticks, thrownMs: Number(g.thrownMicros) / 1000, sprite });
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
    const tr = tracerStyle(e.weapon);
    for (let i = 0; i + 1 < e.ends.length; i += 2) {
      this.effects.tracer(e.x0, e.y0, e.ends[i], e.ends[i + 1], tr.color, tr.width, tr.fadeMs);
      this.sparks(e.ends[i], e.ends[i + 1], 0xcfd8ff, 2);
    }
    const ang = e.ends.length >= 2 ? Math.atan2(e.ends[1] - e.y0, e.ends[0] - e.x0) : 0;
    this.effects.flash(e.x0, e.y0, ang, e.weapon === 2);
    this.audio.play(WEAPON_SOUND[e.weapon] ?? 'pistol', 0.9, e.x0, e.y0, gunPitch(e.weapon));
  }

  onHit(e: HitEv): void {
    const victimKey = e.target.toHexString();
    const attackerKey = e.attacker.toHexString();
    const vColor = this.colorOf(victimKey);
    this.sparks(e.x, e.y, vColor, 6);
    if (attackerKey === this.net.myKey && victimKey !== this.net.myKey) {
      this.hitsDealt++;
      this.dealt.set(victimKey, (this.dealt.get(victimKey) ?? 0) + e.dmg);
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
      const hp = killer?.alive ? Math.ceil(killer.hp) : 0;
      const did = Math.round(this.dealt.get(kKey) ?? 0);
      this.killRecap = self ? '' : `${CAUSE_NAMES[e.cause] ?? ''} · they have ${hp} HP left · you dealt ${did}`;
      this.audio.play('death', 0.75);
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
    this.local?.knockback(this.map, e.x, e.y);
    this.bots.knockback(this, e.x, e.y);
  }

  onPickup(e: PickupEv): void {
    const v = this.pickups.get(e.pickupId);
    if (v) this.effects.ring(v.sprite.x, v.sprite.y, 40, [0xff4d6d, 0xfbbf24, 0x7cff4f, 0x22d3ee, 0xffd54a][e.kind] ?? 0xffffff, 0.4, true);
    if (e.identity.toHexString() === this.net.myKey) {
      this.audio.play('pickup', 0.7);
      if (e.kind === PICKUP_DROP) this.hud.showNotice('RAILGUN · 3 SHOTS', '#67e8f9', 1.8);
      if (e.kind === PICKUP_SHIELD) this.hud.showNotice('SHIELD UP', '#22d3ee', 1.2);
    } else if (e.kind === PICKUP_DROP) {
      this.hud.showNotice(`${this.rowOf(e.identity.toHexString())?.name ?? 'Someone'} has the railgun`, '#ffd54a', 2);
    }
  }

  /** A room-wide announcement from the server. */
  onNotice(e: NoticeEv): void {
    if (e.kind === C.NOTICE_AIRDROP) {
      this.hud.showNotice('AIRDROP INCOMING', '#ffd54a', 2.5);
      this.audio.play('alarm', 0.5);
    } else if (e.kind === C.NOTICE_HILL_MOVED) {
      this.hud.showNotice('THE HILL MOVED', '#22d3ee', 2);
      this.audio.play('beep', 0.6);
    }
  }

  hillRect(): { x0: number; y0: number; x1: number; y1: number } | null {
    const h = this.hill;
    if (!h || this.room?.state !== 1) return null;
    const z = this.map.hills[h.idx];
    return { x0: z.tx * C.TILE, y0: z.ty * C.TILE, x1: (z.tx + z.tw) * C.TILE, y1: (z.ty + z.th) * C.TILE };
  }

  acidLine(): number {
    const r = this.room;
    if (!r || r.state !== 1 || !r.match.suddenDeath || !r.rules.acid) return Infinity;
    return C.acidSurface(this.serverNow(), Number(r.endsAtMicros) / 1000, r.roundSec);
  }

  /** Where a CPU player with nothing to shoot should head: the crate, else a shield close by. */
  goal(x: number, y: number): { x: number; y: number } | null {
    const hill = this.hillRect();
    if (hill) return { x: (hill.x0 + hill.x1) / 2, y: hill.y1 };
    let best: { x: number; y: number } | null = null;
    let bestD = 700;
    for (const p of this.pickups.values()) {
      if (p.row.availableAtMicros !== 0n || !this.pickupsOn || !pickupActive(this.mode, p.row.kind)) continue;
      const at = { x: (p.row.tx + 0.5) * C.TILE, y: (p.row.ty + 1) * C.TILE };
      if (p.row.kind === PICKUP_DROP) return at;
      const d = Math.hypot(at.x - x, at.y - y);
      if (p.row.kind === PICKUP_SHIELD && d < bestD) {
        bestD = d;
        best = at;
      }
    }
    return best;
  }

  /** Someone in the room sent an emote: show it above their head (or at their death spot). */
  onEmote(e: EmoteEv): void {
    if (!this.room || e.roomId !== this.room.id) return;
    const key = e.identity.toHexString();
    const row = this.rowOf(key);
    this.applyEmote(key, e.emote, e.x, e.y, !!row?.alive);
  }

  /** Show the local player's emote instantly, before the server round-trip confirms it. */
  localEmote(index: number): void {
    if (!this.local || !this.localRow || this.room?.state !== 1) return;
    const now = performance.now();
    if (now - this.localEmoteAt < C.EMOTE_COOLDOWN_SEC * 1000) return;
    this.localEmoteAt = now;
    const alive = this.localRow.alive;
    const x = alive || !this.deathSpot ? this.local.body.x : this.deathSpot.x;
    const y = alive || !this.deathSpot ? this.local.centerY : this.deathSpot.y;
    this.applyEmote(this.net.myKey, index, x, y, alive);
  }

  private applyEmote(key: string, index: number, x: number, y: number, follow: boolean): void {
    if (!C.EMOTES[index]) return;
    const now = performance.now();
    let em = this.emotes.get(key);
    if (!em) {
      const sprite = new Sprite(stickerTextures()[index]);
      sprite.anchor.set(0.5, 1);
      this.emoteLayer.addChild(sprite);
      em = { index, sprite, started: now, until: now, x, y, follow };
      this.emotes.set(key, em);
    }
    if (em.index !== index) {
      em.index = index;
      em.sprite.texture = stickerTextures()[index];
    }
    em.started = now;
    em.until = now + C.EMOTE_SHOW_SEC * 1000;
    em.x = x;
    em.y = y;
    em.follow = follow;
  }

  /** Keep live emotes above their sender; freeze them when the sender dies. */
  private updateEmotes(nowMs: number): void {
    for (const [key, em] of this.emotes) {
      if (nowMs >= em.until) {
        this.dropEmote(key);
        continue;
      }
      if (em.follow) {
        if (this.rowOf(key)?.alive) {
          const pos = this.positionOf(key);
          if (pos) {
            em.x = pos.x;
            em.y = pos.y;
          }
        } else em.follow = false;
      }
      const age = (nowMs - em.started) / 1000;
      const pop = Math.min(1, age * 12);
      const fade = Math.min(1, Math.max(0, (em.until - nowMs) / 400));
      // A small overshoot and a slow wobble make the sticker feel hand-slapped on.
      const scale = (EMOTE_PX / em.sprite.texture.width) * (0.55 + 0.45 * pop) * (1 + 0.08 * Math.sin(pop * Math.PI));
      em.sprite.scale.set(scale);
      em.sprite.rotation = Math.sin(age * 3.2 + key.length) * 0.055 * pop;
      em.sprite.position.set(Math.round(em.x), Math.round(em.y - 46 - Math.sin(age * 2.4) * 3));
      em.sprite.alpha = fade;
    }
  }

  private dropEmote(key: string): void {
    const em = this.emotes.get(key);
    if (!em) return;
    em.sprite.destroy();
    this.emotes.delete(key);
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
          const tr = tracerStyle(w);
          this.effects.tracer(ox, oy, ends[i], ends[i + 1], tr.color, tr.width, tr.fadeMs);
          if (wallHits[i / 2]) this.sparks(ends[i], ends[i + 1], 0xcfd8ff, 3);
        }
        const a = this.local ? this.local.aim : 0;
        this.effects.flash(ox, oy, a, w === 2);
        this.audio.play(WEAPON_SOUND[w] ?? 'pistol', 0.85, undefined, undefined, gunPitch(w));
      },
      melee: (x, y, angle) => {
        this.effects.slash(x, y, angle, this.localRow ? this.colorOf(this.net.myKey) : 0xffffff);
        this.audio.play('knife', 0.8);
      },
      throwG: () => this.audio.play('knife', 0.5, undefined, undefined, 0.6),
      empty: () => this.audio.play('empty', 0.7),
      reload: () => this.audio.play('reload', 0.7),
      shake: (n) => this.camera.shake(n),
      hit: (x, y) => {
        // Provisional marker from our own raycast (the authoritative hit_ev follows).
        this.hud.hit((x - this.camera.left) * this.camera.zoom, (y - this.camera.top) * this.camera.zoom, false);
      },
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
    const pnow = performance.now();
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
        this.localView.update(x, y, local.aim, b.vx, flags, local.weapon, dt, bounty, Number(this.localRow.spawnProtectUntilMicros) / 1000 > now, this.localRow.shield / C.SHIELD_MAX);
        this.localView.refreshColor(this.localRow.colorIdx, bounty);
        this.aimLine.position.set(x, y - 30);
        this.aimLine.rotation = local.aim;
        const sniper = local.weapon === W_SNIPER;
        this.camera.follow(x, y - C.PLAYER_H / 2, local.aim, sniper, dt);
      }
      this.aimLine.visible = show && (this.controls.usingTouch || this.controls.usingPad);
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
      r.view.update(r.s.x, r.s.y, r.s.aim, r.s.vx, r.s.flags, r.s.weapon, dt, bounty, Number(r.row.spawnProtectUntilMicros) / 1000 > now, r.row.shield / C.SHIELD_MAX);
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
      const falling = p.row.kind === PICKUP_DROP && p.row.availableAtMicros !== 0n;
      const avail = p.row.availableAtMicros === 0n || falling;
      const show = this.pickupsOn && avail && pickupActive(this.mode, p.row.kind);
      p.sprite.visible = show;
      if (p.chute) p.chute.visible = falling;
      if (falling) {
        p.sprite.y = p.baseY - Math.max(0, Number(p.row.availableAtMicros) / 1000 - now) / 1000 * C.AIRDROP_FALL_PX_PER_SEC;
        // Mark the landing spot: the crate itself is above the screen for most of its fall.
        if (Math.floor(tSec * 1.5) !== Math.floor((tSec - dt) * 1.5)) this.effects.ring(p.sprite.x, p.baseY, 46, 0xffd54a, 0.6, true);
      }
      else if (show) p.sprite.y = p.baseY - 6 + Math.sin(tSec * 3 + p.row.tx) * 3;
    }

    // --- King of the Hill zone: colour by who holds it, pulsing while it matters ---
    if (this.hill && playing) {
      this.hillGfx.tint = this.hillColor(this.hill);
      this.hillGfx.alpha = this.hill.state === C.HILL_CONTESTED ? 0.55 + Math.sin(tSec * 12) * 0.35 : 0.75 + Math.sin(tSec * 3) * 0.2;
    }
    this.hillGfx.visible = !!this.hill && playing;

    // --- Sudden death: the acid sheet climbs with the clock ---
    const surface = this.acidLine();
    const suddenDeath = Number.isFinite(surface);
    this.acidSheet.visible = suddenDeath;
    if (suddenDeath) {
      this.acidSheet.y = surface;
      this.acidSheet.height = Math.max(1, MAP_H - surface);
      this.acidSheet.tilePosition.x += dt * 26;
      if (!this.wasSuddenDeath) {
        this.hud.showBanner('ACID RISING', '#7cff4f', 2.2);
        this.audio.play('alarm', 0.8);
      }
    }
    this.wasSuddenDeath = suddenDeath;

    // --- Acid ---
    this.acid.tilePosition.x += dt * 18;
    this.acidGlow.alpha = (this.rules.acid ? 0.3 : 0.12) + Math.sin(tSec * 2) * 0.08;
    if (Math.random() < dt * 8) {
      this.particles.emit({ tex: this.tex.bubbleAcid, x: this.acidR.x + Math.random() * this.acidR.w, y: this.acidR.y + 6, vx: 0, vy: -20 - Math.random() * 30, life: 0.8, scale0: 0.6, scale1: 1.4, color: 0xb8ff9a, additive: true });
    }

    // --- Camera, world transform, parallax ---
    this.updateEmotes(pnow);
    const cam = this.camera;
    if ((!local || !local.alive || !playing) && this.running) {
      cam.hold(dt);
      // Dead: the view stays on the death spot for the whole respawn wait, unless the player
      // pans away with the movement controls to see what is going on.
      if (local && !local.alive && playing && this.deathSpot) {
        const pan = 620 * dt;
        this.lookX += this.input.moveX * pan;
        this.lookY += ((this.input.down ? 1 : 0) - (this.input.thrust ? 1 : 0)) * pan;
        cam.snapTo(this.deathSpot.x + this.lookX, this.deathSpot.y + this.lookY);
      }
    }
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
      this.hud.setShield(row.alive ? row.shield : 0);
      this.hud.setFuel(local.body.fuel, this.rules.infiniteFuel);
      this.hud.setWeapon(local.weapon);
      const w = local.weapon;
      if (w === W_RAIL) {
        this.hud.setAmmo(String(local.power), '');
      } else if (isGun(w)) {
        if (this.rules.infiniteAmmo) this.hud.setAmmo('∞', '');
        else this.hud.setAmmo(String(w === W_PISTOL ? local.pistolMag : local.mag), w === W_PISTOL ? '/∞' : `/${local.reserve}`);
      } else if (w === W_FRAG) {
        this.hud.setAmmo('∞', '');
      } else {
        this.hud.setAmmo(w === W_KNIFE ? '—' : '', '');
      }
      this.updateHillChip(now);
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
        // On phones the detailed panel is one compact line: the three numbers that matter
        // (frame rate, round trip, quality step) without covering the play area.
        const compact = document.body.classList.contains('touch-mode');
        this.hud.setDebug(compact
          ? `${this.fps.toFixed(0)} FPS · ${this.time.rtt.toFixed(0)} ms · ${this.quality}${this.qualityStep ? ` ${this.qualityStep}` : ''}`
          : `FPS ${this.fps.toFixed(0)}\nRTT ${this.time.rtt.toFixed(0)} ms\nRenderer ${this.app.renderer.name}\nPlayers ${players.length}\nQuality ${this.quality} (step ${this.qualityStep})\nParticles cap ${this.particles.cap}`,
        );
      } else this.hud.setDebug(null);
    }
  }

  /** One line under the timer: who holds the hill and when it moves. */
  private updateHillChip(now: number): void {
    const h = this.hill;
    if (!h || this.room?.state !== 1) {
      this.hud.setHill(null, '');
      return;
    }
    const secs = Math.max(0, Math.ceil((Number(h.movesAtMicros) / 1000 - now) / 1000));
    if (h.state === C.HILL_CONTESTED) this.hud.setHill('HILL CONTESTED', 'contested');
    else if (h.state === C.HILL_EMPTY) this.hud.setHill(`HILL OPEN · MOVES ${secs}s`, 'open');
    else if (this.hillIsMine(h)) this.hud.setHill(`HOLDING +${C.HILL_POINTS_PER_SEC}/s · ${secs}s`, 'mine');
    else {
      const who = this.teams ? (h.team === C.TEAM_RED ? 'RED' : 'BLUE') : this.rowOf(h.holder?.toHexString() ?? '')?.name ?? 'Someone';
      this.hud.setHill(`${who} HOLDS · ${secs}s`, 'enemy');
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
    for (const p of this.pickups.values()) {
      if (p.row.kind === PICKUP_DROP) out.push({ x: p.sprite.x, y: p.baseY, color: 0xffd54a, kind: 'objective', firedAgo: 0 });
      // They move around, so the minimap shows where they turned up.
      else if (movesAround(p.row.kind) && p.sprite.visible) out.push({ x: p.sprite.x, y: p.baseY, color: p.row.kind === PICKUP_SHIELD ? 0x22d3ee : 0xff4d6d, kind: 'item', firedAgo: 0 });
    }
    const hill = this.hillRect();
    if (hill && !(this.local?.alive && this.inHill())) {
      out.push({ x: (hill.x0 + hill.x1) / 2, y: (hill.y0 + hill.y1) / 2, color: this.hill ? this.hillColor(this.hill) : 0xffffff, kind: 'objective', firedAgo: 0 });
    }
    const cam = this.camera;
    const z = cam.zoom;
    this.radar.update(out, { l: cam.left, t: cam.top, r: cam.right, b: cam.bottom }, (x, y) => ({ sx: (x - cam.left) * z, sy: (y - cam.top) * z }), this.app.screen.width, this.app.screen.height);
  }

  private inHill(): boolean {
    const h = this.hill;
    return !!h && !!this.local && inZone(this.map.hills[h.idx], this.local.body.x, this.local.centerY);
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
      me: this.local ? { x: this.local.body.x, y: this.local.body.y, alive: this.local.alive, weapon: this.local.weapon, grenades: this.local.grenades, power: this.local.power, ...toScreen(this.local.body.x, this.local.centerY) } : null,
      mode: this.mode,
      hitsDealt: this.hitsDealt,
      booms: this.booms,
      remotes: [...this.remotes.values()].map((r) => ({ name: r.row.name, alive: r.row.alive, x: r.s.x, y: r.s.y, ...toScreen(r.s.x, r.s.y - C.PLAYER_H / 2) })),
      kills: this.allPlayers().reduce((n, p) => n + p.kills, 0),
      pickups: [...this.pickups.values()].map((p) => ({ kind: p.row.kind, tx: p.row.tx, ty: p.row.ty, ready: p.row.availableAtMicros === 0n })),
      mapId: this.mapId,
      hill: this.hill ? { idx: this.hill.idx, state: this.hill.state, zone: this.map.hills[this.hill.idx], mine: this.hillIsMine(this.hill) } : null,
      acidLine: this.acidLine(),
      renderer: this.app.renderer.name,
      camera: { x: cam.x, y: cam.y, left: cam.left, top: cam.top, right: cam.right, bottom: cam.bottom, zoom: cam.zoom },
      deathSpot: this.deathSpot,
      emotes: [...this.emotes.entries()].map(([key, em]) => ({
        key, index: em.index, x: em.x, y: em.y, follow: em.follow, ...toScreen(em.x, em.y - 44),
      })),
    };
  }

  allPlayers(): Player[] {
    const list: Player[] = [];
    if (this.localRow) list.push(this.localRow);
    for (const r of this.remotes.values()) list.push(r.row);
    return list;
  }

  // ------------------------------------------------------------------ quality governor

  /** Comfort settings. */
  setComfort(shake: number, particles: number): void {
    this.camera.shakeScale = shake;
    this.particleScale = particles;
    this.applyQualityStep(this.qualityStep);
  }

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
    this.particles.cap = Math.max(10, Math.round(qs.particles * this.particleScale));
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
