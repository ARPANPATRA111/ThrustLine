// In-game HUD written as plain DOM over the canvas. Every setter compares with the last value
// and touches the DOM only when something changed; animations use transform/opacity only.
import { WEAPON_DRAW, WEAPON_SIZE } from '../render/atlas';
import { PLAYER_CSS } from '../render/soldier';
import type { Player } from '../module_bindings/types';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Leaderboard order: score, then kills, then fewer deaths. */
export function rankPlayers(players: Player[]): Player[] {
  return [...players].sort((a, b) => b.score - a.score || b.kills - a.kills || a.deaths - b.deaths);
}

export class Hud {
  private hpFill = $('hp-fill');
  private hpText = $('hp-text');
  private fuelFill = $('fuel-fill');
  private timer = $('timer');
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
  private debugEl = $('debug');
  private last: Record<string, string | number | boolean> = {};
  private hitTimer = 0;
  private vigTimer = 0;
  private bannerTimer = 0;
  skullURL = '';

  private changed(key: string, v: string | number | boolean): boolean {
    if (this.last[key] === v) return false;
    this.last[key] = v;
    return true;
  }

  reset(): void {
    this.last = {};
    this.feed.innerHTML = '';
  }

  setHP(hp: number): void {
    const v = Math.max(0, Math.ceil(hp));
    if (!this.changed('hp', v)) return;
    this.hpFill.style.transform = `scaleX(${v / 100})`;
    this.hpText.textContent = String(v);
  }

  setFuel(f: number): void {
    const v = Math.round(f);
    if (this.changed('fuel', v)) this.fuelFill.style.transform = `scaleX(${v / 100})`;
  }

  setTimer(text: string, frenzy: boolean): void {
    if (this.changed('timer', text)) this.timer.textContent = text;
    if (this.changed('frenzy', frenzy)) {
      this.timer.classList.toggle('frenzy', frenzy);
      this.tint.classList.toggle('on', frenzy);
    }
  }

  setWeapon(w: number): void {
    if (!this.changed('weapon', w)) return;
    const g = this.icon.getContext('2d')!;
    g.clearRect(0, 0, this.icon.width, this.icon.height);
    const [ww, wh] = WEAPON_SIZE[w];
    const scale = Math.min(80 / ww, 32 / wh, 2.4);
    g.save();
    g.translate(this.icon.width - ww * scale - 4, (this.icon.height - wh * scale) / 2);
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

  setReloading(on: boolean): void {
    if (this.changed('reload', on)) this.reload.classList.toggle('hidden', !on);
  }

  setCrosshair(x: number, y: number): void {
    this.crosshair.style.transform = `translate(${x}px, ${y}px)`;
  }

  /** Mini leaderboard: top 3 plus you. */
  setMiniBoard(ranked: Player[], meKey: string): void {
    const rows: string[] = [];
    const myIdx = ranked.findIndex((p) => p.identity.toHexString() === meKey);
    ranked.forEach((p, i) => {
      if (i < 3 || i === myIdx) {
        const me = i === myIdx ? ' class="me"' : '';
        rows.push(`<li${me}><span>${i + 1}.</span><span class="swatch" style="color:${PLAYER_CSS[p.colorIdx]};background:${PLAYER_CSS[p.colorIdx]}"></span><span>${escapeHtml(p.name)}</span><span class="sc">${p.score}</span></li>`);
      }
    });
    const html = rows.join('');
    if (this.changed('mini', html)) this.mini.innerHTML = html;
  }

  killFeed(killer: string, killerColor: number, how: string, victim: string, victimColor: number): void {
    const li = document.createElement('li');
    const k = killer ? `<span style="color:${PLAYER_CSS[killerColor]}">${escapeHtml(killer)}</span>` : '';
    li.innerHTML = `${k}<span class="how">${escapeHtml(how)}</span><img src="${this.skullURL}" width="14" height="14" alt=""> <span style="color:${PLAYER_CSS[victimColor]}">${escapeHtml(victim)}</span>`;
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

  showBanner(text: string, color = '#e6ecff', seconds = 1.6): void {
    this.banner.textContent = text;
    this.banner.style.color = color;
    this.banner.classList.add('show');
    this.bannerTimer = seconds;
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
  }
}
