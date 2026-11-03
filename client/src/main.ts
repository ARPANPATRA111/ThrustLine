// Boot, loading screen and the screen router. Screens are plain DOM sections in index.html;
// the room's state (lobby / playing / ended) decides which one is visible.
import '@fontsource/russo-one/latin-400.css';
import '@fontsource/chakra-petch/latin-500.css';
import '@fontsource/chakra-petch/latin-600.css';
import '@fontsource/chakra-petch/latin-700.css';
import './style.css';
import { Application } from 'pixi.js';
import * as C from '@shared/config';
import { PRIMARIES } from '@shared/weapons';
import type { Player, Room } from './module_bindings/types';
import { Net, errorText } from './net/connection';
import { TimeSync } from './net/timesync';
import { buildAtlas } from './render/atlas';
import { installFont } from './render/font';
import { TEAM_CSS, TEAM_NAMES, playerCss } from './render/soldier';
import { Audio } from './audio/audio';
import { Game } from './game/game';
import { Input } from './game/input';
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
  'Hosts can add CPU players and change the house rules.',
];

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
  setProgress(0.3, 'Baking RIG-7…');
  await nextFrame();

  const net = new Net();
  const time = new TimeSync((clientMs) => void net.conn?.reducers.ping({ clientMs, rttMs: Math.round(time.rtt) }).catch(() => {}));
  const audio = new Audio();
  const input = new Input();
  const hud = new Hud();
  hud.causeIcons = { 0: atlas.iconURL('w0'), 1: atlas.iconURL('w1'), 2: atlas.iconURL('w2'), 3: atlas.iconURL('w3'), 4: atlas.iconURL('w4'), 5: atlas.iconURL('w5'), [C.CAUSE_ACID]: atlas.iconURL('bubbleAcid', 3) };
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

  const lobby = new LobbyView({
    send: (mode, roundSec, teams, rules) => void call(net.conn?.reducers.updateRoomSettings({ mode, roundSec, teams, rules })),
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
    roomChanged: (r) => {
      if (r && r.id === myRoomId) game.setRoom(r);
      queueRoute();
    },
    playerUpsert: (p, old) => {
      const mine = p.identity.toHexString() === net.myKey;
      if (mine) {
        if (p.roomId !== myRoomId) enterRoom(p.roomId);
        if (old && old.alive && !p.alive) game.killedBy = game.killedBy || 'Eliminated';
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
  };
  // The connection may already be up (it was started during loading): start the clock sync now.
  if (net.conn) time.start();

  function enterRoom(roomId: bigint): void {
    game.clear();
    boardHtml = '';
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
    if (!room || !me || me.roomId !== room.id) {
      showScreen('scr-home');
      for (const id of ['scr-respawn', 'scr-board', 'scr-menu']) showOverlay(id, false);
      game.stop();
      game.setAttract(true);
      input.enabled = false;
      checkRotate();
      return;
    }
    if (Net.savedRoom !== room.code) Net.savedRoom = room.code;
    if (room.state === 0) {
      showScreen('scr-lobby');
      game.stop();
      game.setAttract(true);
      input.enabled = false;
      for (const id of ['scr-respawn', 'scr-board']) showOverlay(id, false);
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
    const dead = !me.alive && !ended;
    input.enabled = !ended && !menuOpen;
    showOverlay('scr-respawn', dead && !menuOpen);
    if (dead) renderRespawn(me, room);
    else game.killedBy = '';
    showOverlay('scr-board', ended || boardHeld);
    if (ended || boardHeld) renderBoard(ended);
    checkRotate();
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
    $('primary-pick').classList.toggle('hidden', room.mode !== C.MODE_ARMS);
    document.querySelectorAll<HTMLButtonElement>('#primary-pick .pick').forEach((b) => b.classList.toggle('sel', Number(b.dataset.w) === me.primary));
  }
  setInterval(() => {
    if ($('scr-respawn').classList.contains('hidden')) return;
    const left = game.respawnLeft();
    const total = (myRoom()?.rules.respawnSec ?? C.RESPAWN_SEC) * 1000;
    $('respawn-count').textContent = String(Math.ceil(left / 1000));
    $('ring-fg').style.strokeDashoffset = String(276.5 * (1 - Math.min(1, left / total)));
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
    const room = myRoom();
    const teams = !!room?.teams;
    let ranked = rankPlayers(roomPlayers());
    $('board-title').textContent = ended ? 'ROUND OVER' : 'SCOREBOARD';
    $('winner').classList.toggle('hidden', !ended || ranked.length === 0);
    if (teams) {
      // Team match: group by team, team with the higher total wins.
      const [red, blue] = game.teamScores();
      ranked = [...ranked.filter((p) => p.team === C.TEAM_RED), ...ranked.filter((p) => p.team === C.TEAM_BLUE)];
      const myTeam = myRow()?.team ?? 0;
      const win = red === blue ? 0 : red > blue ? C.TEAM_RED : C.TEAM_BLUE;
      $('winner-name').innerHTML = win === 0 ? `DRAW · ${red} – ${blue}` : `<span style="color:${TEAM_CSS[win]}">${TEAM_NAMES[win]} TEAM WINS</span> · ${Math.max(red, blue)} – ${Math.min(red, blue)}${win === myTeam ? ' · VICTORY' : ''}`;
    } else if (ended && ranked[0]) {
      $('winner-name').textContent = ranked[0].identity.toHexString() === net.myKey ? 'YOU WIN!' : `${ranked[0].name} wins`;
    }
    const boardRows = ranked.map((p, i) => {
      const me = p.identity.toHexString() === net.myKey ? ' class="me"' : '';
      const ping = p.isBot ? '<span class="cpu-tag">CPU</span>' : p.pingMs ? `<span class="ping ${pingClass(p.pingMs)}">${p.pingMs}</span>` : '–';
      const rank = teams ? ranked.filter((q, j) => j <= i && q.team === p.team).length : i + 1;
      return `<tr${me}><td><span class="rank r${rank}">${rank}</span></td><td><span class="pn"><span class="avatar" style="width:12px;height:12px;border-radius:4px;background:${playerCss(p.colorIdx, teams ? p.team : 0)};color:${playerCss(p.colorIdx, teams ? p.team : 0)}"></span>${escapeHtml(p.name)}</span></td><td class="num">${p.score}</td><td class="num">${p.kills}</td><td class="num">${p.deaths}</td><td class="num">${ping}</td></tr>`;
    }).join('');
    if (boardRows !== boardHtml) {
      $('board-body').innerHTML = boardRows;
      boardHtml = boardRows;
    }
    $('end-actions').classList.toggle('hidden', !ended);
    $('btn-again').classList.toggle('hidden', !isHost());
    $('btn-to-lobby').classList.toggle('hidden', !isHost());
    $('lobby-countdown').classList.toggle('hidden', !ended);
    updateCountdown();
  }
  /** "Back to the lobby in N s": every player returns automatically when it reaches zero. */
  function updateCountdown(): void {
    const room = myRoom();
    if (!room || room.state !== 2 || room.lobbyAtMicros === 0n) return;
    const left = Math.max(0, Math.ceil((Number(room.lobbyAtMicros) / 1000 - time.serverNow()) / 1000));
    $('lobby-countdown').textContent = `Everyone returns to the lobby in ${left} s`;
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
    if (open) input.reset();
    queueRoute();
  };
  input.onMenu = () => openMenu(!menuOpen);
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
  $('btn-howto-close').addEventListener('click', () => showOverlay('scr-howto', false));
  $('btn-settings-close').addEventListener('click', () => showOverlay('scr-settings', false));
  for (const id of ['scr-howto', 'scr-settings']) {
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
  $('btn-tap').addEventListener('click', async () => {
    audio.unlock();
    audio.play('click');
    clearInterval(tipTimer);
    $('btn-tap').classList.add('hidden');
    $('load-text').textContent = 'Connecting…';
    await connected;
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
