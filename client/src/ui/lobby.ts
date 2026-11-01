// Lobby screen: player slots and the host's match settings (match type, mode, round length,
// health, respawn delay, CPU skill and house-rule toggles). Everyone sees the settings; only
// the host can change them, kick players, or move players between teams.
import * as C from '@shared/config';
import type { Identity } from 'spacetimedb';
import type { Player, Room } from '../module_bindings/types';
import { TEAM_CSS, TEAM_NAMES, playerCss } from '../render/soldier';
import { escapeHtml } from './hud';

export type Rules = Room['rules'];

export interface LobbyActions {
  send(mode: number, roundSec: number, teams: boolean, rules: Rules): void;
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

  constructor(private act: LobbyActions) {
    $('mode-cards').querySelectorAll<HTMLButtonElement>('.mode').forEach((b) => {
      b.addEventListener('click', () => this.change({ mode: Number(b.dataset.mode) }));
    });
    document.querySelectorAll<HTMLInputElement>('#room-settings [data-rule]').forEach((el) => {
      el.addEventListener('change', () => this.change({ rules: { [el.dataset.rule!]: el.checked } }));
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

  /** Apply a partial change to the current settings and send it (host only). */
  private change(c: { mode?: number; roundSec?: number; teams?: boolean; rules?: Partial<Rules> }): void {
    const r = this.room;
    if (!r || !this.host) return;
    this.act.click();
    this.act.send(c.mode ?? r.mode, c.roundSec ?? r.roundSec, c.teams ?? r.teams, { ...r.rules, ...c.rules });
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
    const cpu = p.isBot ? '<span class="cpu-tag">CPU</span>' : '';
    const ping = !p.isBot && p.pingMs ? `<span class="ping-tag">${p.pingMs} ms</span>` : '';
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

  render(room: Room, players: Player[], myKey: string, isHost: boolean, crownURL: string): void {
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

    // Settings (read-only for everyone but the host).
    $('host-note').textContent = isHost ? 'You are the host' : 'Host controls';
    $('mode-cards').classList.toggle('locked', !isHost);
    $('mode-cards').querySelectorAll<HTMLButtonElement>('.mode').forEach((b) => b.classList.toggle('on', Number(b.dataset.mode) === room.mode));
    this.seg('seg-teams', [{ v: 0, label: 'Free-for-all' }, { v: 1, label: 'Red vs Blue' }], room.teams ? 1 : 0, (v) => this.change({ teams: v === 1 }));
    const rounds = room.dev ? [C.DEV_ROUND_SEC, ...C.ROUND_LENGTHS_SEC] : C.ROUND_LENGTHS_SEC;
    this.seg('seg-round', rounds.map((v) => ({ v, label: roundLabel(v) })), room.roundSec, (v) => this.change({ roundSec: v }));
    this.seg('seg-hp', C.HP_OPTIONS.map((v) => ({ v, label: `${v}` })), room.rules.maxHp, (v) => this.change({ rules: { maxHp: v } }));
    this.seg('seg-respawn', C.RESPAWN_OPTIONS.map((v) => ({ v, label: `${v}s` })), room.rules.respawnSec, (v) => this.change({ rules: { respawnSec: v } }));
    this.seg('seg-bot', SKILL_LABELS.map((label, v) => ({ v, label })), room.rules.botSkill, (v) => this.change({ rules: { botSkill: v } }));
    document.querySelectorAll<HTMLInputElement>('#room-settings [data-rule]').forEach((el) => {
      el.checked = Boolean(room.rules[el.dataset.rule as keyof Rules]);
      el.disabled = !isHost;
    });
    $('tog-ff').classList.toggle('hidden', !room.teams);
  }
}
