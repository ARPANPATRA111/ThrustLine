// In-game HUD written as plain DOM over the canvas. Every setter compares with the last value
// and touches the DOM only when something changed; animations use transform/opacity only.
import { SHIELD_MAX } from '@shared/config';
import { WEAPON_DRAW, WEAPON_SIZE } from '../render/atlas';
import { playerCss } from '../render/soldier';
import type { Player } from '../module_bindings/types';

export const CAUSE_NAMES: Record<number, string> = { 0: 'pistol', 1: 'AR', 2: 'shotgun', 3: 'sniper', 4: 'knife', 5: 'frag', 6: 'SMG', 7: 'railgun', 10: 'acid', 11: 'impact grenade' };

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Leaderboard order: score, then kills, then fewer deaths. */
export function rankPlayers(players: Player[]): Player[] {
  return [...players].sort((a, b) => b.score - a.score || b.kills - a.kills || a.deaths - b.deaths);
}

/** Ping colour band: under 80 ms good, under 160 ms ok, otherwise bad. */
export function pingClass(ms: number): 'good' | 'ok' | 'bad' {
  return ms < 80 ? 'good' : ms < 160 ? 'ok' : 'bad';
}

export class Hud {
  private hpMeter = document.querySelector<HTMLElement>('.meter.hp')!;
  private hpFill = $('hp-fill');
  private hpText = $('hp-text');
  private shieldFill = $('shield-fill');
  private fuelMeter = document.querySelector<HTMLElement>('.meter.fuel')!;
  private fuelFill = $('fuel-fill');
  private fuelText = $('fuel-text');
  private timer = $('timer');
  private ping = $('net-ping');
  private pingVal = this.ping.querySelector('b')!;
  private fpsVal = $('net-fps').querySelector('b')!;
  private mag = $('ammo-mag');
  private res = $('ammo-res');
  private nades = $('nade-count');
  private reload = $('reload-tag');
  private icon = $<HTMLCanvasElement>('weapon-icon');
  private mini = $('mini-board');
  private feed = $('killfeed');
  private crosshair = $('crosshair');
  private hitmarker = $('hitmarker');
  private vignette = $('vignette');
  private arc = $('dmg-arc');
  private tint = $('frenzy-tint');
  private banner = $('banner');
  private notice = $('notice');
  private hillChip = $('hill-chip');
  private debugEl = $('debug');
  private teamEl = $('team-score');
  private last: Record<string, string | number | boolean> = {};
  private hitTimer = 0;
  private vigTimer = 0;
  private bannerTimer = 0;
  private noticeTimer = 0;
  /** Kill-feed icons by cause (weapon id, or acid), as data URLs from the atlas. */
  causeIcons: Record<number, string> = {};

  private changed(key: string, v: string | number | boolean): boolean {
    if (this.last[key] === v) return false;
    this.last[key] = v;
    return true;
  }

  reset(): void {
    this.last = {};
    this.feed.innerHTML = '';
  }

  setHP(hp: number, maxHp: number): void {
    const v = Math.max(0, Math.ceil(hp));
    if (!this.changed('hp', v * 1000 + maxHp)) return;
    this.hpFill.style.transform = `scaleX(${Math.min(1, v / maxHp)})`;
    this.hpText.textContent = String(v);
    this.hpMeter.classList.toggle('low', v / maxHp < 0.3);
  }

  setShield(v: number): void {
    const s = Math.max(0, Math.ceil(v));
    if (this.changed('shield', s)) this.shieldFill.style.transform = `scaleX(${Math.min(1, s / SHIELD_MAX)})`;
  }

  setFuel(f: number, infinite: boolean): void {
    const v = infinite ? -1 : Math.round(f);
    if (!this.changed('fuel', v)) return;
    this.fuelFill.style.transform = `scaleX(${infinite ? 1 : v / 100})`;
    this.fuelText.textContent = infinite ? '∞' : '';
  }

  /** Seconds left on an EMP (0 = jetpack fine): the fuel bar goes dark and counts down. */
  setEmp(sec: number): void {
    const text = sec > 0 ? `OFF ${sec.toFixed(1)}` : '';
    if (!this.changed('emp', text)) return;
    this.fuelMeter.classList.toggle('offline', sec > 0);
    this.fuelText.textContent = text;
    if (sec <= 0) delete this.last.fuel; // let setFuel repaint its own label
  }

  setTimer(text: string, frenzy: boolean): void {
    if (this.changed('timer', text)) this.timer.textContent = text;
    if (this.changed('frenzy', frenzy)) {
      this.timer.classList.toggle('frenzy', frenzy);
      this.tint.classList.toggle('on', frenzy);
    }
  }

  /** Always-visible network chip: round-trip ping (colour coded) and frames per second. */
  setNet(pingMs: number | null, fps: number): void {
    const p = pingMs === null ? '--' : String(Math.round(pingMs));
    if (this.changed('ping', p)) {
      this.pingVal.textContent = p;
      this.ping.className = `ping ${pingMs === null ? 'ok' : pingClass(pingMs)}`;
    }
    const f = String(Math.round(fps));
    if (this.changed('fps', f)) this.fpsVal.textContent = f;
  }

  setWeapon(w: number): void {
    if (!this.changed('weapon', w)) return;
    const g = this.icon.getContext('2d')!;
    const W = this.icon.width;
    const H = this.icon.height;
    g.clearRect(0, 0, W, H);
    const [ww, wh] = WEAPON_SIZE[w];
    const scale = Math.min((W - 8) / ww, (H - 6) / wh, 3);
    g.save();
    g.translate(W - ww * scale - 4, (H - wh * scale) / 2);
    g.scale(scale, scale);
    WEAPON_DRAW[w](g, ww, wh);
    g.restore();
  }

  setAmmo(mag: string, reserve: string): void {
    if (this.changed('mag', mag)) this.mag.textContent = mag;
    if (this.changed('res', reserve)) this.res.textContent = reserve;
  }

  setNades(text: string): void {
    if (this.changed('nades', text)) this.nades.textContent = text;
  }

  /** Team match: RED score vs BLUE score, with your team highlighted. */
  setTeamScore(scores: [number, number] | null, myTeam: number): void {
    const key = scores ? `${scores[0]}:${scores[1]}:${myTeam}` : '';
    if (!this.changed('teams', key)) return;
    this.teamEl.classList.toggle('hidden', !scores);
    if (scores) this.teamEl.innerHTML = `<span class="red${myTeam === 1 ? ' mine' : ''}">RED ${scores[0]}</span><span class="blue${myTeam === 2 ? ' mine' : ''}">${scores[1]} BLUE</span>`;
  }

  /** King of the Hill status under the timer; `cls` colours it (open, mine, enemy, contested). */
  setHill(text: string | null, cls: string): void {
    const key = text === null ? '' : `${cls}:${text}`;
    if (!this.changed('hill', key)) return;
    this.hillChip.classList.toggle('hidden', text === null);
    document.body.classList.toggle('has-chip', text !== null);
    if (text !== null) {
      this.hillChip.textContent = text;
      this.hillChip.className = `hill-chip ${cls}`;
    }
  }

  setReloading(on: boolean): void {
    if (this.changed('reload', on)) this.reload.classList.toggle('hidden', !on);
  }

  setCrosshair(x: number, y: number): void {
    this.crosshair.style.transform = `translate(${x}px, ${y}px)`;
  }

  /**
   * Mini leaderboard: player count, the current leader, the top four and (when outside it)
   * your own row. The count also makes departures obvious at a glance.
   */
  setMiniBoard(ranked: Player[], meKey: string, teams = false): void {
    const rows: string[] = [];
    const myIdx = ranked.findIndex((p) => p.identity.toHexString() === meKey);
    const leader = ranked[0];
    const count = `${ranked.length} PLAYER${ranked.length === 1 ? '' : 'S'}`;
    rows.push(
      `<li class="mb-head"><span class="mb-count">${count}</span>` +
      (leader
        ? `<span class="mb-lead" title="${escapeHtml(leader.name)} leads with ${leader.score}"><svg class="ic"><use href="#i-crown" /></svg><b>${escapeHtml(leader.name)}</b><span>${leader.score}</span></span>`
        : '') +
      '</li>',
    );
    ranked.forEach((p, i) => {
      if (i < 4 || i === myIdx) {
        const me = i === myIdx ? ' me' : '';
        const lead = i === 0 ? ' lead' : '';
        const ping = p.isBot ? 'CPU' : !p.connected ? 'LOST' : p.pingMs ? `${p.pingMs}ms` : '';
        rows.push(`<li class="mb-row${me}${lead}"><span class="rk">${i + 1}</span><span class="dot" style="background:${playerCss(p.colorIdx, teams ? p.team : 0)}"></span><span class="nm">${escapeHtml(p.name)}</span><span class="sc">${p.score}</span><span class="pg">${ping}</span></li>`);
      }
    });
    const html = rows.join('');
    if (this.changed('mini', html)) this.mini.innerHTML = html;
  }

  killFeed(killer: string, killerCss: string, cause: number, victim: string, victimCss: string, teamkill = false): void {
    const li = document.createElement('li');
    const tk = teamkill ? '<span class="tk">TEAMKILL</span>' : '';
    const k = killer ? `<span class="killer" style="color:${killerCss}">${escapeHtml(killer)}</span>${tk}` : '';
    const icon = this.causeIcons[cause] ? `<img src="${this.causeIcons[cause]}" alt="${CAUSE_NAMES[cause] ?? ''}" title="${CAUSE_NAMES[cause] ?? ''}">` : '';
    li.innerHTML = `${k}${icon}<span class="victim" style="color:${victimCss}">${escapeHtml(victim)}</span>`;
    this.feed.prepend(li);
    while (this.feed.children.length > 4) this.feed.lastElementChild!.remove();
    setTimeout(() => li.remove(), 6000);
  }

  /** Flash the hit marker at a screen position. */
  hit(x: number, y: number, kill: boolean): void {
    this.hitmarker.style.transform = `translate(${x}px, ${y}px) scale(${kill ? 1.5 : 1})`;
    this.hitmarker.classList.toggle('kill', kill);
    this.hitmarker.style.opacity = '1';
    this.hitTimer = kill ? 0.35 : 0.15;
  }

  /** Red edge vignette plus an arc pointing toward the damage source (radians, screen space). */
  hurt(angle: number | null): void {
    this.vignette.style.opacity = '1';
    this.vigTimer = 0.25;
    if (angle !== null) {
      this.arc.style.transform = `rotate(${angle + Math.PI / 2}rad)`;
      this.arc.style.opacity = '1';
    }
  }

  showBanner(text: string, color = '#eef2ff', seconds = 1.6): void {
    this.banner.textContent = text;
    this.banner.style.color = color;
    this.banner.classList.add('show');
    this.bannerTimer = seconds;
  }

  /** A smaller line for routine announcements: it must never sit where players are aiming. */
  showNotice(text: string, color = '#eef2ff', seconds = 2): void {
    this.notice.textContent = text;
    this.notice.style.color = color;
    this.notice.classList.add('show');
    this.noticeTimer = seconds;
  }

  setDebug(text: string | null): void {
    const show = text !== null;
    if (this.changed('dbgShow', show)) this.debugEl.classList.toggle('hidden', !show);
    if (show && this.changed('dbg', text!)) this.debugEl.textContent = text;
  }

  /** Timers for transient elements. */
  update(dt: number): void {
    if (this.hitTimer > 0 && (this.hitTimer -= dt) <= 0) this.hitmarker.style.opacity = '0';
    if (this.vigTimer > 0 && (this.vigTimer -= dt) <= 0) {
      this.vignette.style.opacity = '0';
      this.arc.style.opacity = '0';
    }
    if (this.bannerTimer > 0 && (this.bannerTimer -= dt) <= 0) this.banner.classList.remove('show');
    if (this.noticeTimer > 0 && (this.noticeTimer -= dt) <= 0) this.notice.classList.remove('show');
  }
}
