// Boot, loading screen and the screen router. Screens are plain DOM sections in index.html;
// the room's state (lobby / playing / ended) decides which one is visible.
import './style.css';
import { Application } from 'pixi.js';
import * as C from '@shared/config';
import { PRIMARIES } from '@shared/weapons';
import type { Player, Room } from './module_bindings/types';
import { Net, errorText } from './net/connection';
import { TimeSync } from './net/timesync';
import { buildAtlas } from './render/atlas';
import { installFont } from './render/font';
import { PLAYER_CSS } from './render/soldier';
import { Audio } from './audio/audio';
import { Game } from './game/game';
import { Input } from './game/input';
import { Hud, escapeHtml, rankPlayers } from './ui/hud';
import { TouchControls } from './ui/touch';
import { loadSettings, saveSettings, type Quality } from './ui/settings';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const DEV = params.get('dev') === '1';
const isTouchDevice = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;

const SCREENS = ['scr-loading', 'scr-home', 'scr-lobby', 'scr-game'];
function showScreen(id: string): void {
  for (const s of SCREENS) $(s).classList.toggle('hidden', s !== id);
  document.body.classList.toggle('in-game', id === 'scr-game');
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
  const settings = loadSettings();

  // ---- Renderer: WebGPU where available, WebGL everywhere else ----
  const app = new Application();
  await app.init({
    preference: ['webgpu', 'webgl'],
    antialias: false,
    autoDensity: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    backgroundColor: 0x0b1020,
    width: window.innerWidth,
    height: window.innerHeight,
  });
  $('stage').appendChild(app.canvas);
  console.info(`[thrustline] renderer: ${app.renderer.name}`);
  setProgress(0.1, 'Generating sprites…');
  await nextFrame();

  installFont();
  const atlas = buildAtlas();
  setProgress(0.3, 'Baking RIG-7…');
  await nextFrame();

  const net = new Net();
  const time = new TimeSync((clientMs) => void net.conn?.reducers.ping({ clientMs }).catch(() => {}));
  const audio = new Audio();
  const input = new Input();
  const hud = new Hud();
  hud.skullURL = atlas.iconURL('skull');
  const game = new Game(app, atlas, audio, net, time, input, hud);
  game.setQuality(settings.quality);
  game.debug = settings.showDebug;
  const touch = new TouchControls($('touch'), input);
  touch.setLefty(settings.lefty);
  // Exposed for automated tests and debugging in the console.
  (window as unknown as { __tl: unknown }).__tl = { game, net, time, app, audio };

  // Connect while the audio is being synthesised.
  const connected = net.connect();
  setProgress(0.45, 'Synthesising audio…');
  await audio.generate((f) => setProgress(0.45 + f * 0.55));
  setProgress(1, 'Ready');
  $('btn-tap').classList.remove('hidden');
  $('load-text').textContent = '';

  // ---------------------------------------------------------------- state
  let myRoomId: bigint | null = null;
  let boardHeld = false;
  let menuOpen = false;
  let wakeLock: { release(): Promise<void> } | null = null;
  const myRow = (): Player | undefined => (net.identity ? net.conn?.db.player.identity.find(net.identity) ?? undefined : undefined);
  const myRoom = (): Room | undefined => (myRoomId !== null ? net.conn?.db.room.id.find(myRoomId) ?? undefined : undefined);
  const roomPlayers = (): Player[] => (myRoomId === null ? [] : [...(net.conn?.db.player.iter() ?? [])].filter((p) => p.roomId === myRoomId));
  const isHost = () => !!myRoom() && !!net.identity && myRoom()!.hostIdentity.isEqual(net.identity);
  const nameValue = () => ($<HTMLInputElement>('in-name').value.trim() || 'Rigger').slice(0, C.NAME_MAX);

  /** Wrap a reducer call: show SenderError text as a toast. */
  const call = async (p: Promise<void> | undefined): Promise<boolean> => {
    if (!p) { toast('Not connected'); return false; }
    try { await p; return true; } catch (e) { toast(errorText(e)); return false; }
  };

  // ---------------------------------------------------------------- net → game
  net.h = {
    state: (s) => {
      const text = s === 'waking' ? 'Waking up the server…' : s === 'reconnecting' ? 'Reconnecting…' : s === 'connecting' ? 'Connecting…' : s === 'offline' ? 'Offline' : '';
      $('conn-status').textContent = text;
      const notice = $('ov-reconnect');
      notice.textContent = text;
      notice.classList.toggle('hidden', s === 'connected' || $('scr-loading').offsetParent !== null || s === 'connecting');
      if (s === 'connected') { time.start(); }
    },
    reconnected: () => void rejoinSaved(),
    pong: (e) => time.onPong(e.clientMs, e.serverMicros),
    roomChanged: (r) => {
      if (r && r.id === myRoomId) game.setRoom(r);
      route();
    },
    playerUpsert: (p, old) => {
      const mine = p.identity.toHexString() === net.myKey;
      if (mine) {
        if (p.roomId !== myRoomId) enterRoom(p.roomId);
        if (old && old.alive && !p.alive) game.killedBy = game.killedBy || 'Eliminated';
      }
      if (p.roomId === myRoomId) game.playerUpsert(p);
      route();
    },
    playerDelete: (p) => {
      if (p.identity.toHexString() === net.myKey) {
        // Our own row is gone (left, or cleaned up after a disconnect).
        if (myRoomId !== null && p.roomId === myRoomId) leaveLocal(false);
      } else if (p.roomId === myRoomId) game.playerDelete(p);
      route();
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
  };

  // The connection may already be up (it was started during loading): start the clock sync now.
  if (net.conn) time.start();

  function enterRoom(roomId: bigint): void {
    game.clear();
    myRoomId = roomId;
    net.subscribeRoom(roomId);
    const r = myRoom();
    if (r) Net.savedRoom = r.code;
  }

  function leaveLocal(callServer: boolean): void {
    if (callServer) void net.conn?.reducers.leaveRoom({}).catch(() => {});
    Net.savedRoom = null;
    myRoomId = null;
    net.subscribeRoom(null);
    game.clear();
    menuOpen = false;
    showOverlay('scr-menu', false);
    void wakeLock?.release().catch(() => {});
    wakeLock = null;
    route();
  }

  async function rejoinSaved(): Promise<void> {
    const code = Net.savedRoom;
    if (!code || !net.conn) return;
    try {
      await net.conn.reducers.joinRoom({ code, name: nameValue(), bot: false });
    } catch {
      Net.savedRoom = null;
      route();
    }
  }

  // ---------------------------------------------------------------- router
  function route(): void {
    if (!$('btn-tap').classList.contains('hidden') || !net.conn) return; // still on the loading screen
    const room = myRoom();
    const me = myRow();
    if (!room || !me || me.roomId !== room.id) {
      showScreen('scr-home');
      for (const id of ['scr-respawn', 'scr-board', 'scr-menu']) showOverlay(id, false);
      game.stop();
      input.enabled = false;
      return;
    }
    if (Net.savedRoom !== room.code) Net.savedRoom = room.code;
    if (room.state === 0) {
      showScreen('scr-lobby');
      game.stop();
      input.enabled = false;
      for (const id of ['scr-respawn', 'scr-board']) showOverlay(id, false);
      renderLobby(room);
      return;
    }
    showScreen('scr-game');
    touch.show(isTouchDevice || input.usingTouch);
    $('btn-fullscreen').classList.toggle('hidden', !document.fullscreenEnabled);
    game.start();
    void acquireWakeLock();
    const ended = room.state === 2;
    const dead = !me.alive && !ended;
    input.enabled = !ended && !menuOpen;
    showOverlay('scr-respawn', dead && !menuOpen);
    if (dead) renderRespawn(me, room);
    else game.killedBy = '';
    showOverlay('scr-board', ended || boardHeld);
    if (ended || boardHeld) renderBoard(ended);
  }

  // ---------------------------------------------------------------- lobby
  const selRound = $<HTMLSelectElement>('sel-round');
  const roundOptions = (dev: boolean) => (dev ? [C.DEV_ROUND_SEC, ...C.ROUND_LENGTHS_SEC] : C.ROUND_LENGTHS_SEC);
  function renderLobby(room: Room): void {
    $('lobby-code').textContent = room.code;
    const players = roundPlayersSorted();
    const myKey = net.myKey;
    $('lobby-players').innerHTML = players.map((p) => {
      const host = room.hostIdentity.isEqual(p.identity) ? `<img class="crown" src="${atlas.iconURL('crownIcon')}" width="18" height="12" alt="host">` : '';
      const you = p.identity.toHexString() === myKey ? ' <span class="muted">(you)</span>' : '';
      const cpu = p.isBot ? ' <span class="cpu-tag">CPU</span>' : '';
      return `<li><span class="swatch" style="color:${PLAYER_CSS[p.colorIdx]};background:${PLAYER_CSS[p.colorIdx]}"></span>${escapeHtml(p.name)}${cpu}${you}${host}</li>`;
    }).join('');
    const host = isHost();
    const opts = roundOptions(room.dev);
    const optsHtml = opts.map((s) => `<option value="${s}">${s < 60 ? `${s} s` : `${s / 60} min`}</option>`).join('');
    if (selRound.dataset.html !== optsHtml) { selRound.innerHTML = optsHtml; selRound.dataset.html = optsHtml; }
    $<HTMLSelectElement>('sel-mode').value = String(room.mode);
    selRound.value = String(room.roundSec);
    $<HTMLSelectElement>('sel-mode').disabled = !host;
    selRound.disabled = !host;
    $('btn-start').classList.toggle('hidden', !host);
    $('btn-addbot').classList.toggle('hidden', !host);
    $('btn-rmbot').classList.toggle('hidden', !host || game.bots.count === 0);
    $<HTMLButtonElement>('btn-addbot').disabled = players.length + (game.bots.count - game.bots.bots.length) >= C.MAX_PLAYERS;
    $('lobby-wait').classList.toggle('hidden', host);
    $('btn-share').classList.toggle('hidden', !navigator.share);
  }
  const roundPlayersSorted = () => roomPlayers().sort((a, b) => (a.joinedAt.microsSinceUnixEpoch < b.joinedAt.microsSinceUnixEpoch ? -1 : 1));

  // ---------------------------------------------------------------- respawn overlay
  function renderRespawn(me: Player, room: Room): void {
    $('killed-by').textContent = me.deaths === 0 && me.kills === 0 && !game.killedBy ? 'Deploying…' : game.killedBy || 'Eliminated';
    $('primary-pick').classList.toggle('hidden', room.mode !== C.MODE_ARMS);
    document.querySelectorAll<HTMLButtonElement>('#primary-pick .pick').forEach((b) => b.classList.toggle('sel', Number(b.dataset.w) === me.primary));
  }
  setInterval(() => {
    if ($('scr-respawn').classList.contains('hidden')) return;
    const left = game.respawnLeft();
    $('respawn-count').textContent = String(Math.ceil(left / 1000));
    $('ring-fg').style.strokeDashoffset = String(276.5 * (1 - left / (C.RESPAWN_SEC * 1000)));
  }, 100);
  document.querySelectorAll<HTMLButtonElement>('#primary-pick .pick').forEach((b) => {
    b.addEventListener('click', () => {
      const w = Number(b.dataset.w);
      if (PRIMARIES.includes(w)) void call(net.conn?.reducers.choosePrimary({ weapon: w }));
      audio.play('click');
    });
  });

  // ---------------------------------------------------------------- scoreboard / round end
  function renderBoard(ended: boolean): void {
    $('board-title').textContent = ended ? 'ROUND OVER' : 'SCOREBOARD';
    const ranked = rankPlayers(roomPlayers());
    $('board-body').innerHTML = ranked.map((p, i) => {
      const me = p.identity.toHexString() === net.myKey ? ' class="me"' : '';
      return `<tr${me}><td>${i + 1}</td><td><span class="swatch" style="display:inline-block;color:${PLAYER_CSS[p.colorIdx]};background:${PLAYER_CSS[p.colorIdx]}"></span></td><td>${escapeHtml(p.name)}${p.isBot ? ' <span class="cpu-tag">CPU</span>' : ''}</td><td class="num">${p.score}</td><td class="num">${p.kills}</td><td class="num">${p.deaths}</td></tr>`;
    }).join('');
    $('end-actions').classList.toggle('hidden', !ended);
    $('btn-again').classList.toggle('hidden', !isHost());
    $('wait-host').classList.toggle('hidden', isHost());
  }
  input.onScoreboard = (show) => { boardHeld = show; route(); };
  $('mini-board').addEventListener('click', () => { boardHeld = !boardHeld; route(); });
  $('scr-board').addEventListener('click', (e) => {
    if (boardHeld && !(e.target as HTMLElement).closest('button')) { boardHeld = false; route(); }
  });

  // ---------------------------------------------------------------- menu & settings
  const openMenu = (open: boolean) => {
    menuOpen = open;
    showOverlay('scr-menu', open);
    if (open) input.reset();
    route();
  };
  input.onMenu = () => openMenu(!menuOpen);
  input.onDebug = () => {
    settings.showDebug = !settings.showDebug;
    game.debug = settings.showDebug;
    saveSettings(settings);
  };
  $('btn-menu').addEventListener('click', () => openMenu(true));
  $('btn-menu-resume').addEventListener('click', () => openMenu(false));
  $('btn-menu-leave').addEventListener('click', () => leaveLocal(true));
  $('btn-menu-settings').addEventListener('click', () => showOverlay('scr-settings', true));
  $('btn-settings').addEventListener('click', () => showOverlay('scr-settings', true));
  $('btn-howto').addEventListener('click', () => showOverlay('scr-howto', true));
  $('btn-howto-close').addEventListener('click', () => showOverlay('scr-howto', false));
  $('btn-settings-close').addEventListener('click', () => showOverlay('scr-settings', false));
  const bindRange = (id: string, key: 'master' | 'music' | 'sfx') => {
    const el = $<HTMLInputElement>(id);
    el.value = String(audio.volumes[key]);
    el.addEventListener('input', () => audio.setVolumes({ [key]: Number(el.value) }));
  };
  bindRange('set-master', 'master');
  bindRange('set-music', 'music');
  bindRange('set-sfx', 'sfx');
  const selQ = $<HTMLSelectElement>('set-quality');
  selQ.value = settings.quality;
  selQ.addEventListener('change', () => { settings.quality = selQ.value as Quality; game.setQuality(settings.quality); saveSettings(settings); });
  const chkFps = $<HTMLInputElement>('set-fps');
  chkFps.checked = settings.showDebug;
  chkFps.addEventListener('change', () => { settings.showDebug = chkFps.checked; game.debug = chkFps.checked; saveSettings(settings); });
  const chkLefty = $<HTMLInputElement>('set-lefty');
  chkLefty.checked = settings.lefty;
  chkLefty.addEventListener('change', () => { settings.lefty = chkLefty.checked; touch.setLefty(chkLefty.checked); saveSettings(settings); });

  // ---------------------------------------------------------------- home
  const inName = $<HTMLInputElement>('in-name');
  inName.value = settings.name;
  inName.addEventListener('change', () => { settings.name = inName.value.trim().slice(0, C.NAME_MAX); saveSettings(settings); });
  const inCode = $<HTMLInputElement>('in-code');
  inCode.value = (params.get('room') ?? '').toUpperCase().slice(0, 4);
  inCode.addEventListener('input', () => { inCode.value = inCode.value.toUpperCase().replace(/[^A-Z]/g, ''); });
  $('btn-create').addEventListener('click', async () => {
    audio.play('click');
    settings.name = nameValue();
    saveSettings(settings);
    await call(net.conn?.reducers.createRoom({ name: nameValue(), mode: C.MODE_ARMS, roundSec: C.DEFAULT_ROUND_SEC, dev: DEV }));
  });
  const join = async () => {
    audio.play('click');
    const code = inCode.value.trim().toUpperCase();
    if (code.length !== 4) { toast('Enter the 4-letter room code'); return; }
    settings.name = nameValue();
    saveSettings(settings);
    await call(net.conn?.reducers.joinRoom({ code, name: nameValue(), bot: false }));
  };
  $('btn-join').addEventListener('click', join);
  inCode.addEventListener('keydown', (e) => { if (e.key === 'Enter') void join(); });

  // ---------------------------------------------------------------- lobby buttons
  const roomLink = () => `${location.origin}${location.pathname}?room=${myRoom()?.code ?? ''}${DEV ? '&dev=1' : ''}`;
  $('btn-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(roomLink()); toast('Link copied', 'info'); } catch { toast(roomLink(), 'info'); }
  });
  $('btn-share').addEventListener('click', () => void navigator.share?.({ title: 'THRUSTLINE', text: `Join my THRUSTLINE room ${myRoom()?.code}`, url: roomLink() }).catch(() => {}));
  const pushSettings = () => void call(net.conn?.reducers.updateRoomSettings({ mode: Number($<HTMLSelectElement>('sel-mode').value), roundSec: Number(selRound.value) }));
  $('sel-mode').addEventListener('change', pushSettings);
  selRound.addEventListener('change', pushSettings);
  $('btn-start').addEventListener('click', () => { audio.play('click'); void call(net.conn?.reducers.startRound({})); });
  $('btn-again').addEventListener('click', () => { audio.play('click'); void call(net.conn?.reducers.startRound({})); });
  $('btn-leave').addEventListener('click', () => leaveLocal(true));
  $('btn-end-leave').addEventListener('click', () => leaveLocal(true));
  $('btn-addbot').addEventListener('click', async () => {
    const room = myRoom();
    if (!room) return;
    audio.play('click');
    try { await game.bots.add(room.code); } catch (e) { toast(errorText(e)); }
    route();
  });
  $('btn-rmbot').addEventListener('click', () => { game.bots.removeOne(); route(); });

  // ---------------------------------------------------------------- mobile niceties
  $('btn-fullscreen').addEventListener('click', async () => {
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      else await document.exitFullscreen();
      await (screen.orientation as unknown as { lock?: (o: string) => Promise<void> }).lock?.('landscape');
    } catch { /* not supported */ }
  });
  const checkRotate = () => {
    const portrait = isTouchDevice && window.innerHeight > window.innerWidth && !$('scr-game').classList.contains('hidden');
    $('ov-rotate').classList.toggle('hidden', !portrait);
  };
  window.addEventListener('resize', checkRotate);
  setInterval(checkRotate, 1000);
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
  $('btn-tap').addEventListener('click', async () => {
    audio.unlock();
    audio.play('click');
    $('btn-tap').classList.add('hidden');
    $('load-text').textContent = 'Connecting…';
    await connected;
    showScreen('scr-home');
    if (isIOS && !standalone) toast('Tip: Share → Add to Home Screen for fullscreen', 'info');
    await rejoinSaved();
    route();
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
