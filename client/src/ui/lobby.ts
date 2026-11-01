// Lobby screen: player slots and the host's match settings (mode, round length, health,
// respawn delay, CPU skill and house-rule toggles). Everyone sees the settings; only the
// host can change them. Every change sends the full settings to `updateRoomSettings`.
import * as C from '@shared/config';
import type { Player, Room } from '../module_bindings/types';
import { PLAYER_CSS } from '../render/soldier';
import { escapeHtml } from './hud';

export type Rules = Room['rules'];

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const roundLabel = (s: number) => (s < 60 ? `${s}s` : `${s / 60} min`);
const SKILL_LABELS = ['Easy', 'Normal', 'Hard'];

export class LobbyView {
  private room: Room | null = null;
  private host = false;
  private segs = new Map<string, string>();

  constructor(private send: (mode: number, roundSec: number, rules: Rules) => void, private onClick: () => void) {
    $('mode-cards').querySelectorAll<HTMLButtonElement>('.mode').forEach((b) => {
      b.addEventListener('click', () => this.change({ mode: Number(b.dataset.mode) }));
    });
    document.querySelectorAll<HTMLInputElement>('#room-settings [data-rule]').forEach((el) => {
      el.addEventListener('change', () => this.change({ rules: { [el.dataset.rule!]: el.checked } }));
    });
  }

  /** Apply a partial change to the current settings and send it (host only). */
  private change(c: { mode?: number; roundSec?: number; rules?: Partial<Rules> }): void {
    const r = this.room;
    if (!r || !this.host) return;
    this.onClick();
    this.send(c.mode ?? r.mode, c.roundSec ?? r.roundSec, { ...r.rules, ...c.rules });
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

  render(room: Room, players: Player[], myKey: string, isHost: boolean, crownURL: string): void {
    this.room = room;
    this.host = isHost;
    $('lobby-code').textContent = room.code;
    $('lobby-count').textContent = `${players.length}/${C.MAX_PLAYERS}`;

    // Player slots: filled ones first, then dashed placeholders up to 6.
    const rows = players.map((p) => {
      const host = room.hostIdentity.isEqual(p.identity) ? `<img class="crown" src="${crownURL}" width="18" height="12" alt="host">` : '';
      const you = p.identity.toHexString() === myKey ? '<span class="you-tag">YOU</span>' : '';
      const cpu = p.isBot ? '<span class="cpu-tag">CPU</span>' : '';
      const ping = !p.isBot && p.pingMs ? `<span class="ping-tag">${p.pingMs} ms</span>` : '';
      const initial = escapeHtml(p.name.replace(/^CPU /, '').charAt(0).toUpperCase() || '?');
      return `<li class="pl"><span class="avatar" style="background:${PLAYER_CSS[p.colorIdx]};color:${PLAYER_CSS[p.colorIdx]}"><span style="color:#071022">${initial}</span></span>${escapeHtml(p.name)}<span class="tag">${cpu}${you}${ping}${host}</span></li>`;
    });
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
    const rounds = room.dev ? [C.DEV_ROUND_SEC, ...C.ROUND_LENGTHS_SEC] : C.ROUND_LENGTHS_SEC;
    this.seg('seg-round', rounds.map((v) => ({ v, label: roundLabel(v) })), room.roundSec, (v) => this.change({ roundSec: v }));
    this.seg('seg-hp', C.HP_OPTIONS.map((v) => ({ v, label: `${v}` })), room.rules.maxHp, (v) => this.change({ rules: { maxHp: v } }));
    this.seg('seg-respawn', C.RESPAWN_OPTIONS.map((v) => ({ v, label: `${v}s` })), room.rules.respawnSec, (v) => this.change({ rules: { respawnSec: v } }));
    this.seg('seg-bot', SKILL_LABELS.map((label, v) => ({ v, label })), room.rules.botSkill, (v) => this.change({ rules: { botSkill: v } }));
    document.querySelectorAll<HTMLInputElement>('#room-settings [data-rule]').forEach((el) => {
      el.checked = Boolean(room.rules[el.dataset.rule as keyof Rules]);
      el.disabled = !isHost;
    });
  }
}
