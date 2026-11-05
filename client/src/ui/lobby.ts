// Lobby screen: player slots and the host's match settings (match type, mode, round length,
// health, CPU skill and house-rule toggles). Everyone sees the settings; only
// the host can change them, kick players, or move players between teams.
import * as C from '@shared/config';
import type { Identity } from 'spacetimedb';
import type { Player, Room } from '../module_bindings/types';
import { TEAM_CSS, TEAM_NAMES, playerCss } from '../render/soldier';
import { escapeHtml } from './hud';

export type Rules = Room['rules'];
export type Match = Room['match'];

/** The host's editable settings, as one snapshot. */
interface Draft {
  mode: number;
  roundSec: number;
  teams: boolean;
  rules: Rules;
  match: Match;
}

export interface LobbyActions {
  send(mode: number, roundSec: number, teams: boolean, rules: Rules, match: Match): void;
  kick(target: Identity): void;
  moveTeam(target: Identity): void;
  click(): void;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const roundLabel = (s: number) => (s < 60 ? `${s}s` : `${s / 60} min`);
const SKILL_LABELS = ['Easy', 'Normal', 'Hard'];

export class LobbyView {
  private room: Room | null = null;
  private host = false;
  private segs = new Map<string, string>();
  private players: Player[] = [];
  /**
   * Local copy of the settings. Rapid clicks used to merge into the last server snapshot, so
   * two clicks in the same round trip clobbered each other and the next render reverted the
   * checkbox. The draft is the source of truth for the controls while an edit is in flight.
   */
  private draft: Draft | null = null;
  private pending = false;
  private pendingAt = 0;
  private roomId = '';

  constructor(private act: LobbyActions) {
    $('mode-cards').querySelectorAll<HTMLButtonElement>('.mode').forEach((b) => {
      b.addEventListener('click', () => this.change({ mode: Number(b.dataset.mode) }));
    });
    document.querySelectorAll<HTMLInputElement>('#room-settings [data-rule]').forEach((el) => {
      el.addEventListener('change', () => this.change({ rules: { [el.dataset.rule!]: el.checked } }));
    });
    document.querySelectorAll<HTMLInputElement>('#room-settings [data-match]').forEach((el) => {
      el.addEventListener('change', () => this.change({ match: { [el.dataset.match!]: el.checked } }));
    });
    // Kick / move buttons inside the player list (event delegation: the list is re-rendered).
    $('lobby-players').addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]');
      if (!btn || !this.host) return;
      const p = this.players.find((q) => q.identity.toHexString() === btn.dataset.id);
      if (!p) return;
      this.act.click();
      if (btn.dataset.act === 'kick') this.act.kick(p.identity);
      else this.act.moveTeam(p.identity);
    });
  }

  private fromRoom(room: Room): Draft {
    return { mode: room.mode, roundSec: room.roundSec, teams: room.teams, rules: { ...room.rules }, match: { ...room.match } };
  }

  /** Does the server row now carry everything we last asked for? */
  private matches(room: Room): boolean {
    const d = this.draft;
    if (!d) return true;
    if (d.mode !== room.mode || d.roundSec !== room.roundSec || d.teams !== room.teams) return false;
    for (const k of Object.keys(d.rules) as (keyof Rules)[]) if (d.rules[k] !== room.rules[k]) return false;
    for (const k of Object.keys(d.match) as (keyof Match)[]) if (d.match[k] !== room.match[k]) return false;
    return true;
  }

  /** Apply a partial change to the current settings and send it (host only). */
  private change(c: { mode?: number; roundSec?: number; teams?: boolean; rules?: Partial<Rules>; match?: Partial<Match> }): void {
    const r = this.room;
    if (!r || !this.host) return;
    const base = this.draft ?? this.fromRoom(r);
    this.draft = {
      mode: c.mode ?? base.mode,
      roundSec: c.roundSec ?? base.roundSec,
      teams: c.teams ?? base.teams,
      rules: { ...base.rules, ...c.rules },
      match: { ...base.match, ...c.match },
    };
    this.pending = true;
    this.pendingAt = performance.now();
    this.act.click();
    // Paint immediately from the draft so a second fast click merges with the first instead
    // of reading the stale server row.
    if (this.room) this.paint(this.room, this.draft, this.host);
    this.act.send(this.draft.mode, this.draft.roundSec, this.draft.teams, this.draft.rules, this.draft.match);
  }

  /** Build a segmented control once per option list; then just move the highlight. */
  private seg(id: string, options: { v: number; label: string }[], value: number, onPick: (v: number) => void): void {
    const el = $(id);
    const key = options.map((o) => `${o.v}:${o.label}`).join('|');
    if (this.segs.get(id) !== key) {
      this.segs.set(id, key);
      el.innerHTML = options.map((o) => `<button data-v="${o.v}">${o.label}</button>`).join('');
      el.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.addEventListener('click', () => onPick(Number(b.dataset.v))));
    }
    el.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.classList.toggle('on', Number(b.dataset.v) === value));
    el.classList.toggle('locked', !this.host);
  }

  private playerRow(room: Room, p: Player, myKey: string, crownURL: string): string {
    const key = p.identity.toHexString();
    const isHostRow = room.hostIdentity.isEqual(p.identity);
    const host = isHostRow ? `<img class="crown" src="${crownURL}" width="18" height="12" alt="host">` : '';
    const you = key === myKey ? '<span class="you-tag">YOU</span>' : '';
    const cpu = p.isBot ? '<span class="cpu-tag">CPU</span>' : !p.connected ? '<span class="lost-tag">LOST</span>' : '';
    const ping = !p.isBot ? `<span class="ping-tag" data-ping="${key}"></span>` : '';
    const color = playerCss(p.colorIdx, room.teams ? p.team : 0);
    const initial = escapeHtml(p.name.replace(/^CPU /, '').charAt(0).toUpperCase() || '?');
    // Host tools: move to the other team, remove from the room (not on your own row).
    let tools = '';
    if (this.host) {
      if (room.teams) tools += `<button class="row-btn" data-act="move" data-id="${key}" title="Move to the other team" aria-label="Move ${escapeHtml(p.name)} to the other team"><svg class="ic"><use href="#i-swap" /></svg></button>`;
      if (key !== myKey) tools += `<button class="row-btn danger" data-act="kick" data-id="${key}" title="Remove from room" aria-label="Remove ${escapeHtml(p.name)}"><svg class="ic"><use href="#i-close" /></svg></button>`;
    }
    const team = room.teams ? ` team-${p.team}` : '';
    return `<li class="pl${team}"><span class="avatar" style="background:${color};color:${color}"><span style="color:#071022">${initial}</span></span><span class="pname">${escapeHtml(p.name)}</span><span class="tag">${cpu}${you}${ping}${host}${tools}</span></li>`;
  }

  /** Update just the ping text; the row markup (and its entry animation) stays untouched. */
  private paintPings(players: Player[]): void {
    for (const el of document.querySelectorAll<HTMLElement>('#lobby-players .ping-tag[data-ping]')) {
      const p = players.find((q) => q.identity.toHexString() === el.dataset.ping);
      const text = p && p.pingMs ? `${p.pingMs} ms` : '';
      if (el.textContent !== text) el.textContent = text;
    }
  }

  /** Paint the controls from a settings snapshot (the server row, or the local draft). */
  private paint(room: Room, d: Draft, isHost: boolean): void {
    $('mode-cards').classList.toggle('locked', !isHost);
    $('mode-cards').querySelectorAll<HTMLButtonElement>('.mode').forEach((b) => b.classList.toggle('on', Number(b.dataset.mode) === d.mode));
    this.seg('seg-teams', [{ v: 0, label: 'Free-for-all' }, { v: 1, label: 'Red vs Blue' }], d.teams ? 1 : 0, (v) => this.change({ teams: v === 1 }));
    const rounds = room.dev ? [C.DEV_ROUND_SEC, ...C.ROUND_LENGTHS_SEC] : C.ROUND_LENGTHS_SEC;
    this.seg('seg-round', rounds.map((v) => ({ v, label: roundLabel(v) })), d.roundSec, (v) => this.change({ roundSec: v }));
    this.seg('seg-hp', C.HP_OPTIONS.map((v) => ({ v, label: `${v}` })), d.rules.maxHp, (v) => this.change({ rules: { maxHp: v } }));
    this.seg('seg-bot', SKILL_LABELS.map((label, v) => ({ v, label })), d.rules.botSkill, (v) => this.change({ rules: { botSkill: v } }));
    document.querySelectorAll<HTMLInputElement>('#room-settings [data-rule]').forEach((el) => {
      el.checked = Boolean(d.rules[el.dataset.rule as keyof Rules]);
      el.disabled = !isHost;
    });
    document.querySelectorAll<HTMLInputElement>('#room-settings [data-match]').forEach((el) => {
      el.checked = Boolean(d.match[el.dataset.match as keyof Match]);
      el.disabled = !isHost;
    });
    $('tog-ff').classList.toggle('hidden', !d.teams);
  }

  render(room: Room, players: Player[], myKey: string, isHost: boolean, crownURL: string): void {
    const id = room.id.toString();
    if (id !== this.roomId) {
      this.roomId = id;
      this.draft = null;
      this.pending = false;
    }
    this.room = room;
    this.host = isHost;
    this.players = players;
    $('lobby-code').textContent = room.code;
    $('lobby-count').textContent = `${players.length}/${C.MAX_PLAYERS}`;

    // Player slots: grouped by team in a team match; then dashed placeholders.
    let rows: string[];
    if (room.teams) {
      rows = [];
      for (const team of [C.TEAM_RED, C.TEAM_BLUE]) {
        const members = players.filter((p) => p.team === team);
        rows.push(`<li class="team-head" style="color:${TEAM_CSS[team]}">${TEAM_NAMES[team]} TEAM · ${members.length}</li>`);
        for (const p of members) rows.push(this.playerRow(room, p, myKey, crownURL));
      }
    } else {
      rows = players.map((p) => this.playerRow(room, p, myKey, crownURL));
    }
    for (let i = players.length; i < C.MAX_PLAYERS; i++) rows.push('<li class="empty">Waiting for player…</li>');
    const html = rows.join('');
    const list = $('lobby-players');
    if (list.dataset.html !== html) {
      list.innerHTML = html;
      list.dataset.html = html;
    }
    this.paintPings(players);

    // Settings (read-only for everyone but the host).
    $('host-note').textContent = isHost ? 'You are the host' : 'Host controls';
    // Once the server row carries the last edit, drop the draft. A send that never lands (a
    // rejected/offline call) is abandoned after 4 s so the controls cannot stay stuck.
    if (this.pending && (this.matches(room) || performance.now() - this.pendingAt > 4000)) {
      this.pending = false;
    }
    if (!this.pending || !this.draft) this.draft = this.fromRoom(room);
    this.paint(room, this.draft, isHost);
  }
}
