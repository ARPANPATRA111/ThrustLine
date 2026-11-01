// Situational awareness, drawn in screen space on top of the world:
//  1. A minimap (top-left) that always shows you and your teammates, and shows an enemy only
//     for a few seconds after they fire. Hiding works until you shoot.
//  2. Edge arrows: when an enemy who is OFF-screen fires, an arrow at the screen edge points
//     toward them and fades out. Enemies already on screen get no arrow (it would cover them).
import { Container, Sprite, Texture } from 'pixi.js';
import { type GameMap, MAP_H, MAP_W, T_ACID, T_ONEWAY, T_SOLID, tileAt } from '@shared/map';

export interface RadarEntry {
  /** World centre position. */
  x: number;
  y: number;
  color: number;
  kind: 'me' | 'ally' | 'enemy';
  /** ms since this player last fired (Infinity if never). */
  firedAgo: number;
}

/** How long an enemy stays on the minimap after firing, and how long its edge arrow lasts. */
const REVEAL_MS = 3000;
const ARROW_MS = 2200;
const POOL = 10;

export class Radar {
  root = new Container();
  private mini = new Container();
  private dots: Sprite[] = [];
  private arrows: Sprite[] = [];
  private mmW = 180;
  private mmH = 75;

  constructor(tex: Record<string, Texture>, map: GameMap) {
    // Bake the minimap image once: 2 px per tile.
    const c = document.createElement('canvas');
    c.width = map.cols * 2;
    c.height = map.rows * 2;
    const g = c.getContext('2d')!;
    g.fillStyle = 'rgba(7,11,24,0.78)';
    g.fillRect(0, 0, c.width, c.height);
    for (let ty = 0; ty < map.rows; ty++) {
      for (let tx = 0; tx < map.cols; tx++) {
        const code = tileAt(map, tx, ty);
        if (code === T_SOLID) g.fillStyle = '#3a4680';
        else if (code === T_ONEWAY) g.fillStyle = '#8d9ad0';
        else if (code === T_ACID) g.fillStyle = '#5fcf3a';
        else continue;
        g.fillRect(tx * 2, ty * 2, 2, code === T_ONEWAY ? 1 : 2);
      }
    }
    g.strokeStyle = 'rgba(34,211,238,0.6)';
    g.lineWidth = 1;
    g.strokeRect(0.5, 0.5, c.width - 1, c.height - 1);
    const bg = new Sprite(Texture.from(c));
    bg.alpha = 0.92;
    this.mini.addChild(bg);
    for (let i = 0; i < POOL; i++) {
      const d = new Sprite(tex.pip);
      d.anchor.set(0.5);
      d.visible = false;
      this.dots.push(d);
      this.mini.addChild(d);
      const a = new Sprite(tex.arrow);
      a.anchor.set(0.5);
      a.visible = false;
      this.arrows.push(a);
      this.root.addChild(a);
    }
    this.root.addChild(this.mini);
  }

  /** Place the minimap (top-left, under the health bars). */
  layout(_screenW: number, screenH: number): void {
    const phone = screenH <= 520;
    this.mmW = phone ? 132 : 180;
    this.mmH = (this.mmW * MAP_H) / MAP_W;
    const bg = this.mini.children[0] as Sprite;
    bg.width = this.mmW;
    bg.height = this.mmH;
    this.mini.position.set(12, phone ? 58 : 72);
  }

  /**
   * Redraw from this frame's entries. `view` is the camera rectangle in world px and
   * `toScreen` converts world → screen px.
   */
  update(entries: RadarEntry[], view: { l: number; t: number; r: number; b: number }, toScreen: (x: number, y: number) => { sx: number; sy: number }, screenW: number, screenH: number): void {
    let d = 0;
    let a = 0;
    const sxk = this.mmW / MAP_W;
    const syk = this.mmH / MAP_H;
    for (const e of entries) {
      const inView = e.x > view.l && e.x < view.r && e.y > view.t && e.y < view.b;
      // Minimap: you and allies always; enemies only while revealed by their own gunfire.
      const reveal = e.kind !== 'enemy' || e.firedAgo < REVEAL_MS;
      if (reveal && d < POOL) {
        const s = this.dots[d++];
        s.visible = true;
        s.position.set(e.x * sxk, e.y * syk);
        s.tint = e.kind === 'me' ? 0xffffff : e.color;
        s.scale.set(e.kind === 'me' ? 1.1 : 0.9);
        s.alpha = e.kind === 'enemy' ? Math.max(0.25, 1 - e.firedAgo / REVEAL_MS) : 1;
      }
      // Edge arrow: an off-screen enemy that just fired.
      if (e.kind === 'enemy' && !inView && e.firedAgo < ARROW_MS && a < POOL) {
        const p = toScreen(e.x, e.y);
        const cx = screenW / 2;
        const cy = screenH / 2;
        const ang = Math.atan2(p.sy - cy, p.sx - cx);
        // Intersect the ray from the screen centre with a rectangle inset from the edges.
        const mx = cx - 46;
        const my = cy - 46;
        const k = Math.min(Math.abs(mx / Math.cos(ang) || Infinity), Math.abs(my / Math.sin(ang) || Infinity));
        const s = this.arrows[a++];
        s.visible = true;
        s.position.set(cx + Math.cos(ang) * k, cy + Math.sin(ang) * k);
        s.rotation = ang;
        s.tint = e.color;
        const fresh = 1 - e.firedAgo / ARROW_MS;
        s.alpha = 0.35 + 0.65 * fresh;
        s.scale.set(1 + 0.25 * fresh);
      }
    }
    for (; d < POOL; d++) this.dots[d].visible = false;
    for (; a < POOL; a++) this.arrows[a].visible = false;
  }
}
