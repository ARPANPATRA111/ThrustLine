// Boot, loading screen and the screen router. Screens are plain DOM sections in index.html;
// the room's state (lobby / playing / ended) decides which one is visible.
import '@fontsource/russo-one/latin-400.css';
import '@fontsource/chakra-petch/latin-500.css';
import '@fontsource/chakra-petch/latin-600.css';
import '@fontsource/chakra-petch/latin-700.css';
import './style.css';
import { Application } from 'pixi.js';
import * as C from '@shared/config';
import { MAP_NAMES } from '@shared/map';
import { GRENADES, PRIMARIES, effectiveNade, nadeOptions } from '@shared/weapons';
import type { Player, Profile, Room, SeasonBoard } from './module_bindings/types';
import { Net, errorText } from './net/connection';
import { TimeSync } from './net/timesync';
import { buildAtlas } from './render/atlas';
import { installFont } from './render/font';
import { stickerDataURL } from './render/stickers';
import { TEAM_CSS, TEAM_NAMES, playerCss, setColorblind } from './render/soldier';
import { Audio } from './audio/audio';
import { Game } from './game/game';
import { ACTIONS, DEFAULT_KEYS, Input, keyLabel, type Action } from './game/input';
import { Hud, escapeHtml, pingClass, rankPlayers } from './ui/hud';
import { TouchControls } from './ui/touch';
import { LobbyView } from './ui/lobby';
import { randomCallsign, setupHowTo } from './ui/howto';
import { loadSettings, saveSettings, type Quality } from './ui/settings';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const DEV = params.get('dev') === '1';
/** Room code from an invite link (?room=ABCD). */
const INVITE = (params.get('room') ?? '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
const isTouchDevice = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;

const TIPS = [
  'Tap thrust for a hop, hold it to fly.',
  'Shotgun recoil launches you: blast-jump across the rig.',
  'A 3-kill streak makes you a gold bounty worth +50.',
  'The last minute is FRENZY: 1.5x damage, 2x fuel.',
  'Stay out of the green acid.',
  'Grenades bounce: bank them off walls.',
  'Shields soak damage before your health does.',
  'Airdrops carry a railgun that pierces everyone on the line.',
  'In the last 30 seconds the acid rises: get high.',
  'Hosts can add CPU players and change the house rules.',
];

/** Indexed by the room's objective. */
const OBJECTIVE_NAMES = ['Deathmatch', 'King of the Hill', 'Capture the Flag'];

const SCREENS = ['scr-loading', 'scr-home', 'scr-lobby', 'scr-game'];
function showScreen(id: string): void {
  for (const s of SCREENS) $(s).classList.toggle('hidden', s !== id);
  document.body.classList.toggle('in-game', id === 'scr-game');
  document.body.classList.toggle('menu-mode', id !== 'scr-game');
}
function showOverlay(id: string, on: boolean): void {
  $(id).classList.toggle('hidden', !on);
}

export function toast(msg: string, kind: 'error' | 'info' = 'error'): void {
  const el = document.createElement('div');
  el.className = `toast ${kind === 'info' ? 'info' : ''}`;
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

async function boot(): Promise<void> {
  const setProgress = (f: number, text?: string) => {
    $('load-bar').style.transform = `scaleX(${f})`;
    if (text) $('load-text').textContent = text;
  };
  let tip = Math.floor(Math.random() * TIPS.length);
  $('load-tip').textContent = TIPS[tip];
  const tipTimer = setInterval(() => { tip = (tip + 1) % TIPS.length; $('load-tip').textContent = TIPS[tip]; }, 3500);
  const settings = loadSettings();
  if (!settings.name) {
    settings.name = randomCallsign();
    saveSettings(settings);
  }

  // ---- Renderer: WebGPU where available, WebGL everywhere else ----
  const app = new Application();
  await app.init({
    preference: ['webgpu', 'webgl'],
    antialias: false,
    autoDensity: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    backgroundColor: 0x070b18,
    width: window.innerWidth,
    height: window.innerHeight,
  });
  $('stage').appendChild(app.canvas);
  console.info(`[thrustline] renderer: ${app.renderer.name}`);
  setProgress(0.1, 'Generating sprites…');
  await nextFrame();

  installFont();
  const atlas = buildAtlas();
  setProgress(0.3, 'Baking the rig…');
  await nextFrame();

  const net = new Net();
  const time = new TimeSync((clientMs) => void net.conn?.reducers.ping({ clientMs, rttMs: Math.round(time.rtt) }).catch(() => {}));
  const audio = new Audio();
  const input = new Input();
  const hud = new Hud();
  hud.causeIcons = { 0: atlas.iconURL('w0'), 1: atlas.iconURL('w1'), 2: atlas.iconURL('w2'), 3: atlas.iconURL('w3'), 4: atlas.iconURL('w4'), 5: atlas.iconURL('w5'), 6: atlas.iconURL('w6'), 7: atlas.iconURL('w7'), [C.CAUSE_ACID]: atlas.iconURL('bubbleAcid', 3), [C.CAUSE_IMPACT]: atlas.iconURL('nade1') };
  const game = new Game(app, atlas, audio, net, time, input, hud);
  game.setQuality(settings.quality);
  game.debug = settings.showDebug;
  game.setAttract(true); // the live map drifts behind the loading screen and menus
  const touch = new TouchControls($('touch'), input);
  if (isTouchDevice) {
    // Phones and tablets get the touch layout from the start (not only after the first touch).
    input.usingTouch = true;
    document.body.classList.add('touch-mode');
  }
  touch.setLefty(settings.lefty);
  setupHowTo(atlas);
  const crownURL = atlas.iconURL('crownIcon');
  // Exposed for automated tests and debugging in the console.
  (window as unknown as { __tl: unknown }).__tl = { game, net, time, app, audio };

  // Connect while the audio is being synthesised.
  const connected = net.connect();
  setProgress(0.45, 'Synthesising audio…');
  await audio.generate((f) => setProgress(0.45 + f * 0.55));
  setProgress(1, 'Ready');
  $('tap-label').textContent = INVITE ? `Join room ${INVITE}` : 'Tap to start';
  $('btn-tap').classList.remove('hidden');
  $('load-text').textContent = INVITE ? `You've been invited to room ${INVITE}` : '';

  // ---------------------------------------------------------------- state
  let myRoomId: bigint | null = null;
  let boardHeld = false;
  let menuOpen = false;
  /** Tracks death so the picker can close on respawn; it never opens by itself. */
  let wasDead = false;
  /** Primary weapon picked on the death screen, shown immediately while the server confirms. */
  let pendingPrimary: number | null = null;
  let pendingNade: number | null = null;
  let wakeLock: { release(): Promise<void> } | null = null;
  const myRow = (): Player | undefined => (net.identity ? net.conn?.db.player.identity.find(net.identity) ?? undefined : undefined);
  const myRoom = (): Room | undefined => (myRoomId !== null ? net.conn?.db.room.id.find(myRoomId) ?? undefined : undefined);
  const roomPlayers = (): Player[] => (myRoomId === null ? [] : [...(net.conn?.db.player.iter() ?? [])].filter((p) => p.roomId === myRoomId));
  const isHost = () => !!myRoom() && !!net.identity && myRoom()!.hostIdentity.isEqual(net.identity);
  const nameValue = () => ($<HTMLInputElement>('in-name').value.trim() || settings.name || randomCallsign()).slice(0, C.NAME_MAX);

  /** Wrap a reducer call: show SenderError text as a toast. */
  const call = async (p: Promise<void> | undefined): Promise<boolean> => {
    if (!p) { toast('Not connected'); return false; }
    try { await p; return true; } catch (e) { toast(errorText(e)); return false; }
  };

  // ---------------------------------------------------------------- emotes
  const emoteBar = $('emote-bar');
  const emoteDock = $('emote-dock');
  emoteBar.innerHTML = C.EMOTES.map((label, i) => {
    const text = escapeHtml(label);
    return `<button type="button" data-emote="${i}" role="menuitem" aria-label="${text}" title="${text}"><img src="${stickerDataURL(i)}" alt="" draggable="false"></button>`;
  }).join('');
  const setEmoteOpen = (open: boolean): void => {
    emoteBar.classList.toggle('hidden', !open);
    $('btn-emote').classList.toggle('on', open);
  };
  /** The emote button lives beside the mini leaderboard, wherever that ends up on this screen. */
  function placeEmoteDock(): void {
    if (emoteDock.classList.contains('hidden') || $('scr-game').classList.contains('hidden')) return;
    const r = $('mini-board').getBoundingClientRect();
    if (r.width < 10) return;
    emoteDock.style.top = `${Math.round(r.top)}px`;
    emoteDock.style.right = `${Math.max(8, Math.round(window.innerWidth - r.left + 8))}px`;
  }
  window.addEventListener('resize', placeEmoteDock);
  new ResizeObserver(placeEmoteDock).observe($('mini-board'));
  let myLevel = 1;
  /** Dim the stickers this player has not earned yet. */
  const paintStickerLocks = (): void => {
    emoteBar.querySelectorAll<HTMLButtonElement>('button[data-emote]').forEach((b) => {
      const need = C.STICKER_LEVELS[Number(b.dataset.emote)];
      b.classList.toggle('locked', myLevel < need);
      b.title = myLevel < need ? `Reach level ${need} to unlock` : b.getAttribute('aria-label') ?? '';
    });
  };
  paintStickerLocks();
  const sendEmote = (index: number): void => {
    if (myRoom()?.state !== 1) return;
    if (myLevel < C.STICKER_LEVELS[index]) {
      toast(`Reach level ${C.STICKER_LEVELS[index]} to unlock that sticker`, 'info');
      return;
    }
    audio.play('click');
    game.localEmote(index); // instant locally; the server echo reaches everyone else
    void call(net.conn?.reducers.emote({ emote: index }));
    setEmoteOpen(false);
  };
  /**
   * Fire on pointerdown, not click: a finger already holding a stick must not delay or swallow
   * the tap (multi-touch), and the picker should react the instant it is touched. Keyboard
   * activation still arrives as a click with `detail === 0`.
   */
  const press = (fn: () => void) => (e: Event): void => {
    if (e.type === 'pointerdown') {
      const pe = e as PointerEvent;
      if (pe.pointerType === 'mouse' && pe.button !== 0) return;
      e.preventDefault();
      fn();
    } else if ((e as MouseEvent).detail === 0) {
      fn(); // keyboard Enter/Space
    }
  };
  const toggleEmote = (): void => {
    if (emoteDock.classList.contains('hidden')) return;
    audio.play('click');
    setEmoteOpen(emoteBar.classList.contains('hidden'));
  };
  const emoteBtn = $('btn-emote');
  emoteBtn.addEventListener('pointerdown', press(toggleEmote));
  emoteBtn.addEventListener('click', press(toggleEmote));
  emoteBar.addEventListener('pointerdown', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-emote]');
    if (!b) return;
    e.preventDefault();
    sendEmote(Number(b.dataset.emote));
  });
  emoteBar.addEventListener('click', (e) => {
    if ((e as MouseEvent).detail !== 0) return; // pointer taps are handled above
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-emote]');
    if (b) sendEmote(Number(b.dataset.emote));
  });

  // ---------------------------------------------------------------- profile and season
  function renderProfile(p: Profile): void {
    myLevel = C.levelOf(p.xp);
    const from = C.xpForLevel(myLevel);
    const to = C.xpForLevel(myLevel + 1);
    $('pf-level').textContent = `LV ${myLevel}`;
    $('pf-fill').style.transform = `scaleX(${(p.xp - from) / (to - from)})`;
    $('profile-chip').title = `${p.xp} XP · ${p.wins} wins · ${p.kills} kills · best round ${p.bestKills} kills`;
    $('profile-chip').classList.remove('hidden');
    paintStickerLocks();
  }
  let boardRows: SeasonBoard[] = [];
  function renderSeason(): void {
    const season = C.seasonOf(Date.now());
    $('season-title').textContent = `Season · ${C.seasonName(season)}`;
    const rows = boardRows.filter((r) => r.season === season).sort((a, b) => b.score - a.score);
    $('season-empty').classList.toggle('hidden', rows.length > 0);
    $('season-table').classList.toggle('hidden', rows.length === 0);
    $('season-body').innerHTML = rows.map((r, i) => {
      const me = r.identity.toHexString() === net.myKey ? ' class="me"' : '';
      return `<tr${me}><td><span class="rank r${i + 1}">${i + 1}</span></td><td>${escapeHtml(r.name)}</td><td class="num">${r.level}</td><td class="num">${r.score}</td></tr>`;
    }).join('');
  }

  const lobby = new LobbyView({
    send: (mode, roundSec, teams, rules, match) => void call(net.conn?.reducers.updateRoomSettings({ mode, roundSec, teams, rules, match })),
    kick: (target) => {
      // Kicking one of our own CPU players: also close its connection.
      const bot = game.bots.get(target.toHexString());
      void call(net.conn?.reducers.kickPlayer({ target })).then((ok) => { if (ok && bot) game.bots.remove(bot); });
    },
    moveTeam: (target) => void call(net.conn?.reducers.movePlayerTeam({ target })),
    click: () => audio.play('click'),
  });

  // ---------------------------------------------------------------- net → game
  net.h = {
    state: (s) => {
      const text = s === 'waking' ? 'Waking up the server…' : s === 'reconnecting' ? 'Reconnecting…' : s === 'connecting' ? 'Connecting…' : s === 'offline' ? 'Offline' : '';
      $('conn-status').textContent = text;
      const notice = $('ov-reconnect');
      notice.textContent = text;
      notice.classList.toggle('hidden', s === 'connected' || !$('scr-loading').classList.contains('hidden') || s === 'connecting');
      if (s === 'connected') time.start();
    },
    reconnected: () => void rejoinSaved(),
    kicked: (e) => {
      toast(`The host removed you from room ${e.roomCode}`);
      leaveLocal(false);
    },
    pong: (e) => time.onPong(e.clientMs, e.serverMicros),
    profile: (p, old) => {
      if (p.identity.toHexString() !== net.myKey) return;
      const was = myLevel;
      renderProfile(p);
      if (old && p.xp > old.xp) toast(`+${p.xp - old.xp} XP`, 'info');
      if (old && myLevel > was) {
        audio.play('sting', 0.6);
        const opened = C.STICKER_LEVELS.findIndex((need) => need === myLevel);
        toast(opened >= 0 ? `LEVEL ${myLevel}! ${C.EMOTES[opened]} sticker unlocked` : `LEVEL ${myLevel}!`, 'info');
      }
    },
    seasonBoard: (rows) => {
      boardRows = rows;
      renderSeason();
    },
    roomChanged: (r) => {
      if (r && r.id === myRoomId) game.setRoom(r);
      queueRoute();
    },
    playerUpsert: (p, old) => {
      const mine = p.identity.toHexString() === net.myKey;
      if (mine) {
        if (p.roomId !== myRoomId) {
          enterRoom(p.roomId);
          restoreLoadout();
        }
        if (old && old.alive && !p.alive) game.killedBy = game.killedBy || 'Eliminated';
        if (pendingPrimary !== null && p.primary === pendingPrimary) pendingPrimary = null;
        if (pendingNade !== null && p.nade === pendingNade) pendingNade = null;
      }
      if (p.roomId === myRoomId) game.playerUpsert(p);
      queueRoute();
    },
    playerDelete: (p) => {
      if (p.identity.toHexString() === net.myKey) {
        if (myRoomId !== null && p.roomId === myRoomId) leaveLocal(false);
      } else if (p.roomId === myRoomId) {
        game.playerDelete(p);
        // One of our CPU players was removed (kicked): close its connection too.
        const bot = game.bots.get(p.identity.toHexString());
        if (bot) game.bots.remove(bot);
      }
      queueRoute();
    },
    pstateUpsert: (s) => { if (s.roomId === myRoomId) game.pstateUpsert(s); },
    pickupUpsert: (p) => { if (p.roomId === myRoomId) game.pickupUpsert(p); },
    pickupDelete: (p) => game.pickupDelete(p),
    grenadeInsert: (g) => { if (g.roomId === myRoomId) game.grenadeInsert(g); },
    grenadeDelete: (g) => game.grenadeDelete(g),
    shot: (e) => game.onShot(e),
    hit: (e) => game.onHit(e),
    kill: (e) => game.onKill(e),
    melee: (e) => game.onMelee(e),
    boom: (e) => game.onBoom(e),
    pickupTaken: (e) => game.onPickup(e),
    emote: (e) => game.onEmote(e),
    notice: (e) => game.onNotice(e),
    hillUpsert: (h) => game.hillUpsert(h),
    hillDelete: () => game.hillDelete(),
    flagUpsert: (f, old) => { if (f.roomId === myRoomId) game.flagUpsert(f, old); },
    flagDelete: (f) => game.flagDelete(f),
  };
  // The connection may already be up (it was started during loading): start the clock sync now.
  if (net.conn) time.start();

  function enterRoom(roomId: bigint): void {
    game.clear();
    boardHtml = '';
    pendingPrimary = null;
    pendingNade = null;
    myRoomId = roomId;
    net.subscribeRoom(roomId);
    const r = myRoom();
    if (r) Net.savedRoom = r.code;
  }

  function leaveLocal(callServer: boolean): void {
    if (callServer) void net.conn?.reducers.leaveRoom({}).catch(() => {});
    Net.savedRoom = null;
    myRoomId = null;
    boardHtml = '';
    pendingPrimary = null;
    pendingNade = null;
    net.subscribeRoom(null);
    game.clear();
    menuOpen = false;
    showOverlay('scr-menu', false);
    void wakeLock?.release().catch(() => {});
    wakeLock = null;
    if (INVITE) history.replaceState(null, '', location.pathname + (DEV ? '?dev=1' : ''));
    queueRoute();
  }

  async function rejoinSaved(): Promise<void> {
    const code = Net.savedRoom;
    if (!code || !net.conn) return;
    try {
      await net.conn.reducers.joinRoom({ code, name: nameValue(), bot: false });
    } catch {
      Net.savedRoom = null;
      queueRoute();
    }
  }

  // ---------------------------------------------------------------- router
  /**
   * A player row changes on almost every sync (HP, ammo, ping…), so routing per event used to
   * rebuild the lobby/scoreboard dozens of times a second and replay entry animations. Coalesce
   * all of those events into at most one route per animation frame.
   */
  let routeQueued = false;
  function queueRoute(): void {
    if (routeQueued) return;
    routeQueued = true;
    requestAnimationFrame(() => {
      routeQueued = false;
      route();
    });
  }
  /** Last scoreboard markup, so score updates redraw the table only when a value changed. */
  let boardHtml = '';
  function route(): void {
    if (!$('btn-tap').classList.contains('hidden') || !net.conn || !$('scr-loading').classList.contains('hidden')) return;
    const room = myRoom();
    const me = myRow();
    // Dev rooms allow teleporting, so nobody should join one without knowing.
    document.body.classList.toggle('dev-room', !!room?.dev);
    if (!room || !me || me.roomId !== room.id) {
      showScreen('scr-home');
      for (const id of ['scr-respawn', 'scr-loadout', 'scr-board', 'scr-menu']) showOverlay(id, false);
      game.stop();
      game.setAttract(true);
      input.enabled = false;
      setEmoteOpen(false);
      $('emote-dock').classList.add('hidden');
      wasDead = false;
      checkRotate();
      return;
    }
    if (Net.savedRoom !== room.code) Net.savedRoom = room.code;
    if (room.state === 0) {
      showScreen('scr-lobby');
      game.stop();
      game.setAttract(true);
      input.enabled = false;
      for (const id of ['scr-respawn', 'scr-loadout', 'scr-board']) showOverlay(id, false);
      setEmoteOpen(false);
      $('emote-dock').classList.add('hidden');
      wasDead = false;
      renderLobby(room);
      checkRotate();
      return;
    }
    showScreen('scr-game');
    touch.show(isTouchDevice || input.usingTouch);
    touch.setButtons(game.touchButtons());
    $('btn-fullscreen').classList.toggle('hidden', !document.fullscreenEnabled);
    game.start();
    void acquireWakeLock();
    const ended = room.state === 2;
    const choosing = room.state === 3;
    const dead = !me.alive && !ended && !choosing;
    input.enabled = !ended && !choosing && !menuOpen;
    showOverlay('scr-respawn', dead && !menuOpen);
    showOverlay('scr-loadout', choosing && !menuOpen);
    if (choosing) renderLoadout(me, room);
    // Emotes are for the match only; the dock stays above the respawn overlay while dead.
    $('emote-dock').classList.toggle('hidden', ended || choosing || menuOpen);
    if (ended || choosing || menuOpen) setEmoteOpen(false);
    // The picker only ever opens from the button/key; dying leaves it closed. Close it on respawn
    // so it does not cover the weapon picker when the next death screen appears.
    else if (!dead && wasDead) setEmoteOpen(false);
    wasDead = dead;
    if (dead) renderRespawn(me, room);
    else game.killedBy = '';
    showOverlay('scr-board', ended || (boardHeld && !choosing));
    if (ended || (boardHeld && !choosing)) renderBoard(ended);
    placeEmoteDock();
    checkRotate();
    fillQuickRoom(room);
  }

  /** Quick Play: the host's tab keeps the room lively with CPU players, and gives them up to humans. */
  let fillingRoom = false;
  function fillQuickRoom(room: Room): void {
    if (!room.quick || !isHost() || fillingRoom) return;
    const total = roomPlayers().length;
    if (total < C.QUICK_MIN_PLAYERS) {
      fillingRoom = true;
      void game.bots.add(room.code).catch((e) => console.warn('CPU player failed to join', e)).finally(() => {
        fillingRoom = false;
        queueRoute();
      });
    } else if (total > C.QUICK_MIN_PLAYERS && game.bots.bots.length > 0) {
      game.bots.removeOne();
    }
  }

  // ---------------------------------------------------------------- lobby
  function renderLobby(room: Room): void {
    const players = roomPlayers().sort((a, b) => (a.joinedAt.microsSinceUnixEpoch < b.joinedAt.microsSinceUnixEpoch ? -1 : 1));
    lobby.render(room, players, net.myKey, isHost(), crownURL);
    const host = isHost();
    $('btn-start').classList.toggle('hidden', !host);
    $('bot-row').classList.toggle('hidden', !host);
    $('btn-rmbot').classList.toggle('hidden', game.bots.count === 0);
    $<HTMLButtonElement>('btn-addbot').disabled = players.length + (game.bots.count - game.bots.bots.length) >= C.MAX_PLAYERS;
    $('lobby-wait').classList.toggle('hidden', host);
    $('btn-switch-team').classList.toggle('hidden', !room.teams);
  }

  // ---------------------------------------------------------------- respawn overlay
  function renderRespawn(me: Player, room: Room): void {
    $('killed-by').textContent = me.deaths === 0 && me.kills === 0 && !game.killedBy ? 'Deploying…' : game.killedBy || 'Eliminated';
    $('kill-recap').textContent = game.killedBy ? game.killRecap : '';
    renderPicks(me, room);
  }

  /** The respawn screen and the loadout screen offer the same choices and stay in step. */
  function renderPicks(me: Player, room: Room): void {
    const guns = room.mode === C.MODE_ARMS;
    $('primary-pick').classList.toggle('hidden', !guns);
    $('lo-guns-wrap').classList.toggle('hidden', !guns);
    const sel = pendingPrimary ?? me.primary;
    document.querySelectorAll<HTMLButtonElement>('.pick[data-w]').forEach((b) => b.classList.toggle('sel', Number(b.dataset.w) === sel));
    const nades = nadeOptions(room.mode);
    $('nade-pick').classList.toggle('hidden', nades.length === 0);
    $('lo-nades-wrap').classList.toggle('hidden', nades.length === 0);
    const nade = effectiveNade(room.mode, pendingNade ?? me.nade);
    document.querySelectorAll<HTMLButtonElement>('.pick[data-n]').forEach((b) => {
      const n = Number(b.dataset.n);
      b.classList.toggle('sel', n === nade);
      b.classList.toggle('hidden', !nades.includes(n));
    });
  }
  function renderLoadout(me: Player, room: Room): void {
    $('lo-map').textContent = MAP_NAMES[room.mapId] ?? '';
    const objective = OBJECTIVE_NAMES[room.match.objective] ?? '';
    $('lo-objective').textContent = room.teams && me.team ? `${objective} · ${TEAM_NAMES[me.team]} team` : objective;
    renderPicks(me, room);
  }
  /** Rooms start everyone on the defaults, so bring the last choice along. */
  function restoreLoadout(): void {
    const me = myRow();
    if (!me || !net.conn) return;
    if (PRIMARIES.includes(settings.primary) && me.primary !== settings.primary) void net.conn.reducers.choosePrimary({ weapon: settings.primary }).catch(() => {});
    if (GRENADES[settings.nade] && me.nade !== settings.nade) void net.conn.reducers.chooseGrenade({ kind: settings.nade }).catch(() => {});
  }
  let loadoutBeep = -1;
  setInterval(() => {
    const room = myRoom();
    if (!room || room.state !== 3) return;
    const left = Math.max(0, Number(room.startedAtMicros) / 1000 - time.serverNow());
    const secs = Math.ceil(left / 1000);
    $('lo-count').textContent = String(secs);
    $('lo-ring-fg').style.strokeDashoffset = String(276.5 * (1 - Math.min(1, left / (C.LOADOUT_SEC * 1000))));
    if (secs <= 3 && secs >= 1 && secs !== loadoutBeep) audio.play('beep', 0.5);
    loadoutBeep = secs;
  }, 100);
  setInterval(() => {
    if ($('scr-respawn').classList.contains('hidden')) return;
    const left = game.respawnLeft();
    const total = C.RESPAWN_SEC * 1000;
    $('respawn-count').textContent = String(Math.ceil(left / 1000));
    $('ring-fg').style.strokeDashoffset = String(276.5 * (1 - Math.min(1, left / total)));
  }, 100);
  document.querySelectorAll<HTMLButtonElement>('.pick[data-n]').forEach((b) => {
    b.addEventListener('click', () => {
      const kind = Number(b.dataset.n);
      if (!GRENADES[kind]) return;
      audio.play('click');
      pendingNade = kind;
      settings.nade = kind;
      saveSettings(settings);
      const me = myRow();
      const room = myRoom();
      if (me && room) renderPicks(me, room);
      void call(net.conn?.reducers.chooseGrenade({ kind })).then((ok) => {
        if (!ok && pendingNade === kind) { pendingNade = null; queueRoute(); }
      });
    });
  });
  document.querySelectorAll<HTMLButtonElement>('.pick[data-w]').forEach((b) => {
    b.addEventListener('click', () => {
      const w = Number(b.dataset.w);
      if (!PRIMARIES.includes(w)) return;
      audio.play('click');
      // Show the pick at once instead of waiting for the server row to come back.
      pendingPrimary = w;
      settings.primary = w;
      saveSettings(settings);
      const me = myRow();
      const room = myRoom();
      if (me && room) renderPicks(me, room);
      void call(net.conn?.reducers.choosePrimary({ weapon: w })).then((ok) => {
        if (!ok && pendingPrimary === w) { pendingPrimary = null; queueRoute(); }
      });
    });
  });

  // ---------------------------------------------------------------- scoreboard / round end
  function renderBoard(ended: boolean): void {
    const room = myRoom();
    const teams = !!room?.teams;
    let ranked = rankPlayers(roomPlayers());
    $('board-title').textContent = ended ? 'ROUND OVER' : 'SCOREBOARD';
    $('winner').classList.toggle('hidden', !ended || ranked.length === 0);
    if (teams) {
      // Team match: group by team, team with the higher total wins.
      const caps = game.flagCaps();
      const [red, blue] = caps ?? game.teamScores();
      ranked = [...ranked.filter((p) => p.team === C.TEAM_RED), ...ranked.filter((p) => p.team === C.TEAM_BLUE)];
      const myTeam = myRow()?.team ?? 0;
      // Level on captures, the team with more points takes it, as it does for XP.
      const [tieRed, tieBlue] = game.teamScores();
      const lead = red !== blue ? red - blue : caps ? tieRed - tieBlue : 0;
      const win = lead === 0 ? 0 : lead > 0 ? C.TEAM_RED : C.TEAM_BLUE;
      $('winner-name').innerHTML = win === 0 ? `DRAW · ${red} – ${blue}` : `<span style="color:${TEAM_CSS[win]}">${TEAM_NAMES[win]} TEAM WINS</span> · ${Math.max(red, blue)} – ${Math.min(red, blue)}${win === myTeam ? ' · VICTORY' : ''}`;
    } else if (ended && ranked[0]) {
      $('winner-name').textContent = ranked[0].identity.toHexString() === net.myKey ? 'YOU WIN!' : `${ranked[0].name} wins`;
    }
    const boardRows = ranked.map((p, i) => {
      const me = p.identity.toHexString() === net.myKey ? ' class="me"' : '';
      const ping = p.isBot ? '<span class="cpu-tag">CPU</span>' : !p.connected ? '<span class="lost-tag">LOST</span>' : p.pingMs ? `<span class="ping ${pingClass(p.pingMs)}">${p.pingMs}</span>` : '–';
      const rank = teams ? ranked.filter((q, j) => j <= i && q.team === p.team).length : i + 1;
      return `<tr${me}><td><span class="rank r${rank}">${rank}</span></td><td><span class="pn"><span class="avatar" style="width:12px;height:12px;border-radius:4px;background:${playerCss(p.colorIdx, teams ? p.team : 0)};color:${playerCss(p.colorIdx, teams ? p.team : 0)}"></span>${escapeHtml(p.name)}</span></td><td class="num">${p.score}</td><td class="num">${p.kills}</td><td class="num">${p.deaths}</td><td class="num">${ping}</td></tr>`;
    }).join('');
    if (boardRows !== boardHtml) {
      $('board-body').innerHTML = boardRows;
      boardHtml = boardRows;
    }
    $('end-actions').classList.toggle('hidden', !ended);
    $('btn-again').classList.toggle('hidden', !isHost() || !!room?.quick);
    $('btn-to-lobby').classList.toggle('hidden', !isHost() || !!room?.quick);
    $('lobby-countdown').classList.toggle('hidden', !ended);
    updateCountdown();
  }
  /** "Back to the lobby in N s": every player returns automatically when it reaches zero. */
  function updateCountdown(): void {
    const room = myRoom();
    if (!room || room.state !== 2 || room.lobbyAtMicros === 0n) return;
    const left = Math.max(0, Math.ceil((Number(room.lobbyAtMicros) / 1000 - time.serverNow()) / 1000));
    $('lobby-countdown').textContent = room.quick ? `Next round in ${left} s` : `Everyone returns to the lobby in ${left} s`;
  }
  setInterval(updateCountdown, 250);
  input.onScoreboard = (show) => { boardHeld = show; queueRoute(); };
  $('mini-board').addEventListener('click', () => { boardHeld = !boardHeld; queueRoute(); });
  $('scr-board').addEventListener('click', (e) => {
    if (boardHeld && !(e.target as HTMLElement).closest('button')) { boardHeld = false; queueRoute(); }
  });

  // ---------------------------------------------------------------- menu & settings
  const openMenu = (open: boolean) => {
    menuOpen = open;
    showOverlay('scr-menu', open);
    if (open) {
      input.reset();
      setEmoteOpen(false);
    }
    queueRoute();
  };
  input.onMenu = () => openMenu(!menuOpen);
  input.onQuickEmote = (slot) => {
    if (!$('emote-dock').classList.contains('hidden')) sendEmote(settings.quickStickers[slot] ?? slot);
  };
  input.onEmote = () => {
    if ($('emote-dock').classList.contains('hidden')) return;
    setEmoteOpen(emoteBar.classList.contains('hidden'));
  };
  input.onDebug = () => {
    settings.showDebug = !settings.showDebug;
    game.debug = settings.showDebug;
    $<HTMLInputElement>('set-fps').checked = settings.showDebug;
    saveSettings(settings);
  };
  $('btn-menu').addEventListener('click', () => openMenu(true));
  $('btn-menu-resume').addEventListener('click', () => openMenu(false));
  $('btn-menu-leave').addEventListener('click', () => leaveLocal(true));
  $('btn-menu-settings').addEventListener('click', () => showOverlay('scr-settings', true));
  $('btn-menu-howto').addEventListener('click', () => showOverlay('scr-howto', true));
  $('btn-settings').addEventListener('click', () => { audio.play('click'); showOverlay('scr-settings', true); });
  $('btn-howto').addEventListener('click', () => { audio.play('click'); showOverlay('scr-howto', true); });
  $('btn-season').addEventListener('click', () => { audio.play('click'); renderSeason(); showOverlay('scr-season', true); });
  $('btn-season-close').addEventListener('click', () => showOverlay('scr-season', false));
  $('btn-howto-close').addEventListener('click', () => showOverlay('scr-howto', false));
  $('btn-settings-close').addEventListener('click', () => showOverlay('scr-settings', false));
  for (const id of ['scr-howto', 'scr-settings', 'scr-season']) {
    $(id).addEventListener('click', (e) => { if (e.target === $(id)) showOverlay(id, false); });
  }
  const bindRange = (id: string, key: 'master' | 'music' | 'sfx') => {
    const el = $<HTMLInputElement>(id);
    el.value = String(audio.volumes[key]);
    el.addEventListener('input', () => audio.setVolumes({ [key]: Number(el.value) }));
  };
  bindRange('set-master', 'master');
  bindRange('set-music', 'music');
  bindRange('set-sfx', 'sfx');
  const segQ = $('seg-quality');
  const renderQuality = () => {
    segQ.innerHTML = (['auto', 'high', 'low'] as Quality[]).map((q) => `<button data-q="${q}" class="${q === settings.quality ? 'on' : ''}">${q}</button>`).join('');
  };
  renderQuality();
  segQ.addEventListener('click', (e) => {
    const q = (e.target as HTMLElement).closest<HTMLButtonElement>('button')?.dataset.q as Quality | undefined;
    if (!q) return;
    settings.quality = q;
    game.setQuality(q);
    saveSettings(settings);
    renderQuality();
  });
  const chkFps = $<HTMLInputElement>('set-fps');
  chkFps.checked = settings.showDebug;
  chkFps.addEventListener('change', () => { settings.showDebug = chkFps.checked; game.debug = chkFps.checked; saveSettings(settings); });
  const bindComfort = (id: string, key: 'shake' | 'particles') => {
    const el = $<HTMLInputElement>(id);
    el.value = String(settings[key]);
    el.addEventListener('input', () => {
      settings[key] = Number(el.value);
      game.setComfort(settings.shake, settings.particles);
      saveSettings(settings);
    });
  };
  bindComfort('set-shake', 'shake');
  bindComfort('set-particles', 'particles');
  game.setComfort(settings.shake, settings.particles);
  const applyPalette = () => {
    setColorblind(settings.colorblind);
    document.body.classList.toggle('cb', settings.colorblind);
    game.refreshColors();
  };
  applyPalette();
  const chkCb = $<HTMLInputElement>('set-colorblind');
  chkCb.checked = settings.colorblind;
  chkCb.addEventListener('change', () => { settings.colorblind = chkCb.checked; saveSettings(settings); applyPalette(); queueRoute(); });

  /** The keys in the panel and the on-screen cheat sheet both follow the player's bindings. */
  function applyKeys(): void {
    input.binds = { ...DEFAULT_KEYS, ...settings.keys };
    const k = input.binds;
    const l = keyLabel;
    $('key-binds').innerHTML = ACTIONS.map((a) => `<button type="button" class="bind" data-act="${a.id}"><span>${a.label}</span><kbd>${escapeHtml(l(k[a.id]))}</kbd></button>`).join('');
    $('key-hints').innerHTML =
      `<div class="kh-row"><kbd>${l(k.left)}${l(k.right)}</kbd> move <kbd>${l(k.jet)}</kbd> jet <kbd>LMB</kbd> fire <kbd>RMB</kbd> knife</div>` +
      `<div class="kh-row"><kbd>${l(k.emote)}</kbd> emote <kbd>1-4</kbd> sticker <kbd>${l(k.fire)}</kbd> fire <kbd>${l(k.melee)}</kbd> knife <kbd>${l(k.grenade)}</kbd> nade <kbd>${l(k.swap)}</kbd> swap <kbd>${l(k.reload)}</kbd> reload</div>`;
  }
  applyKeys();
  $('key-binds').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]');
    if (!b) return;
    const action = b.dataset.act as Action;
    b.querySelector('kbd')!.textContent = 'Press a key';
    input.captureKey((code) => {
      if (code) {
        // A key already in use swaps places, so no action is ever left without one.
        const clash = ACTIONS.find((a) => a.id !== action && input.binds[a.id] === code);
        if (clash) settings.keys[clash.id] = input.binds[action];
        settings.keys[action] = code;
        saveSettings(settings);
      }
      applyKeys();
    });
  });
  $('btn-keys-reset').addEventListener('click', () => { settings.keys = {}; saveSettings(settings); applyKeys(); });
  const quickRow = $('quick-stickers');
  quickRow.innerHTML = settings.quickStickers.map((sel, slot) =>
    `<label>${slot + 1}<select data-slot="${slot}">${C.EMOTES.map((name, i) => `<option value="${i}"${i === sel ? ' selected' : ''}>${escapeHtml(name)}</option>`).join('')}</select></label>`).join('');
  quickRow.addEventListener('change', (e) => {
    const el = e.target as HTMLSelectElement;
    settings.quickStickers[Number(el.dataset.slot)] = Number(el.value);
    saveSettings(settings);
  });

  const chkLefty = $<HTMLInputElement>('set-lefty');
  chkLefty.checked = settings.lefty;
  chkLefty.addEventListener('change', () => { settings.lefty = chkLefty.checked; touch.setLefty(chkLefty.checked); saveSettings(settings); });

  // ---------------------------------------------------------------- home
  const inName = $<HTMLInputElement>('in-name');
  inName.value = settings.name;
  const saveName = () => { settings.name = nameValue(); saveSettings(settings); };
  inName.addEventListener('change', saveName);
  $('btn-dice').addEventListener('click', () => { inName.value = randomCallsign(); saveName(); audio.play('click'); });
  const inCode = $<HTMLInputElement>('in-code');
  inCode.value = INVITE;
  inCode.addEventListener('input', () => { inCode.value = inCode.value.toUpperCase().replace(/[^A-Z]/g, ''); });
  $('btn-quick').addEventListener('click', async () => {
    audio.play('click');
    saveName();
    await call(net.conn?.reducers.quickPlay({ name: nameValue(), dev: DEV }));
  });
  $('btn-create').addEventListener('click', async () => {
    audio.play('click');
    saveName();
    await call(net.conn?.reducers.createRoom({ name: nameValue(), mode: C.MODE_ARMS, roundSec: C.DEFAULT_ROUND_SEC, dev: DEV }));
  });
  const join = async (code = inCode.value.trim().toUpperCase()) => {
    audio.play('click');
    if (code.length !== 4) { toast('Enter the 4-letter room code'); return false; }
    saveName();
    return call(net.conn?.reducers.joinRoom({ code, name: nameValue(), bot: false }));
  };
  $('btn-join').addEventListener('click', () => void join());
  inCode.addEventListener('keydown', (e) => { if (e.key === 'Enter') void join(); });

  // ---------------------------------------------------------------- lobby buttons
  /** Invite link: opening it joins this room directly with an automatic unique callsign. */
  const roomLink = () => `${location.origin}${location.pathname}?room=${myRoom()?.code ?? ''}${DEV ? '&dev=1' : ''}`;
  $('btn-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(roomLink()); toast('Invite link copied: paste it in your group', 'info'); } catch { toast(roomLink(), 'info'); }
  });
  $('btn-share').addEventListener('click', async () => {
    const url = roomLink();
    const data = { title: 'THRUSTLINE', text: `Join my THRUSTLINE room ${myRoom()?.code}! Tap to jump straight in:`, url };
    if (navigator.share) {
      try { await navigator.share(data); } catch { /* cancelled */ }
    } else {
      try { await navigator.clipboard.writeText(`${data.text} ${url}`); toast('Invite copied to clipboard', 'info'); } catch { toast(url, 'info'); }
    }
  });
  const startMatch = () => { audio.play('click'); void call(net.conn?.reducers.startRound({})); };
  $('btn-start').addEventListener('click', startMatch);
  $('btn-again').addEventListener('click', startMatch);
  $('btn-to-lobby').addEventListener('click', () => { audio.play('click'); void call(net.conn?.reducers.backToLobby({})); });
  $('btn-switch-team').addEventListener('click', () => { audio.play('click'); void call(net.conn?.reducers.switchTeam({})); });
  $('btn-leave').addEventListener('click', () => leaveLocal(true));
  $('btn-end-leave').addEventListener('click', () => leaveLocal(true));
  $('btn-addbot').addEventListener('click', async () => {
    const room = myRoom();
    if (!room) return;
    audio.play('click');
    try { await game.bots.add(room.code); } catch (e) { toast(errorText(e)); }
    queueRoute();
  });
  $('btn-rmbot').addEventListener('click', () => { game.bots.removeOne(); queueRoute(); });

  // ---------------------------------------------------------------- mobile niceties
  $('btn-fullscreen').addEventListener('click', async () => {
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      else await document.exitFullscreen();
      await (screen.orientation as unknown as { lock?: (o: string) => Promise<void> }).lock?.('landscape');
    } catch { /* not supported */ }
  });
  /** Phones: every screen is landscape-only. */
  function checkRotate(): void {
    const portrait = isTouchDevice && window.innerHeight > window.innerWidth;
    $('ov-rotate').classList.toggle('hidden', !portrait);
  }
  window.addEventListener('resize', checkRotate);
  window.addEventListener('orientationchange', () => setTimeout(checkRotate, 200));
  checkRotate();
  async function acquireWakeLock(): Promise<void> {
    if (wakeLock || !('wakeLock' in navigator)) return;
    try {
      wakeLock = await (navigator as unknown as { wakeLock: { request(t: string): Promise<{ release(): Promise<void> }> } }).wakeLock.request('screen');
    } catch { wakeLock = null; }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && myRoomId !== null) { wakeLock = null; void acquireWakeLock(); } });
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent);
  const standalone = (navigator as unknown as { standalone?: boolean }).standalone === true;

  // ---------------------------------------------------------------- tap to start
  const unlock = () => audio.unlock();
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);
  /**
   * The connection opens during boot, before the handlers above exist, so rows that arrived in
   * that window never fired a callback. Read what the client cache already holds.
   */
  function catchUp(): void {
    const db = net.conn?.db;
    if (!db || !net.identity) return;
    const pf = db.profile.identity.find(net.identity);
    if (pf) renderProfile(pf);
    boardRows = [...db.seasonBoard.iter()];
    renderSeason();
    const mine = db.player.identity.find(net.identity);
    if (mine && mine.roomId !== myRoomId) enterRoom(mine.roomId);
  }

  $('btn-tap').addEventListener('click', async () => {
    audio.unlock();
    audio.play('click');
    clearInterval(tipTimer);
    $('btn-tap').classList.add('hidden');
    $('load-text').textContent = 'Connecting…';
    await connected;
    catchUp();
    if (isTouchDevice && document.fullscreenEnabled) {
      try { await document.documentElement.requestFullscreen({ navigationUI: 'hide' }); } catch { /* optional */ }
    }
    $('scr-loading').classList.add('hidden');
    if (isIOS && !standalone && isTouchDevice) toast('Tip: Share → Add to Home Screen for fullscreen', 'info');
    if (INVITE && Net.savedRoom !== INVITE) {
      // Invite link: join straight away with the saved callsign (or a fresh random one).
      if (!(await join(INVITE))) queueRoute();
    } else {
      await rejoinSaved();
    }
    queueRoute();
  });
}

function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

boot().catch((e) => {
  console.error(e);
  const t = document.getElementById('load-text');
  if (t) t.textContent = `Failed to start: ${e instanceof Error ? e.message : e}`;
});
