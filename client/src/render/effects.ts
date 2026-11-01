// Short-lived visual effects with fixed object pools: tracers, muzzle flashes, knife slashes,
// explosion rings and floating damage numbers. Nothing is allocated during play.
import { BitmapText, Container, Sprite, type Texture } from 'pixi.js';
import { TRACER_FADE_MS } from '@shared/config';
import { FONT } from './font';

interface Fx {
  s: Sprite;
  life: number;
  max: number;
  kind: number; // 0 tracer, 1 flash, 2 slash, 3 ring, 4 shock
  grow: number;
}

const POOL = 96;
const NUMBERS = 24;

export class Effects {
  layer = new Container();
  textLayer = new Container();
  private fx: Fx[] = [];
  private nums: { t: BitmapText; life: number; vy: number }[] = [];

  constructor(private tex: Record<string, Texture>) {
    for (let i = 0; i < POOL; i++) {
      const s = new Sprite(tex.tracer);
      s.visible = false;
      s.blendMode = 'add';
      this.layer.addChild(s);
      this.fx.push({ s, life: 0, max: 1, kind: 0, grow: 0 });
    }
    for (let i = 0; i < NUMBERS; i++) {
      const t = new BitmapText({ text: '', style: { fontFamily: FONT, fontSize: 18 } });
      t.anchor.set(0.5);
      t.visible = false;
      this.textLayer.addChild(t);
      this.nums.push({ t, life: 0, vy: 0 });
    }
  }

  private take(): Fx {
    let oldest = this.fx[0];
    for (const f of this.fx) {
      if (f.life <= 0) return f;
      if (f.life < oldest.life) oldest = f;
    }
    return oldest; // pool full: recycle the one closest to expiring
  }

  /** A bullet tracer from (x0, y0) to (x1, y1), fading over 80 ms. */
  tracer(x0: number, y0: number, x1: number, y1: number, color: number, width = 2): void {
    const f = this.take();
    const len = Math.hypot(x1 - x0, y1 - y0);
    f.s.texture = this.tex.tracer;
    f.s.anchor.set(0, 0.5);
    f.s.position.set(x0, y0);
    f.s.rotation = Math.atan2(y1 - y0, x1 - x0);
    f.s.scale.set(len / 8, width / 2);
    f.s.tint = color;
    f.s.alpha = 1;
    f.s.visible = true;
    f.kind = 0;
    f.life = f.max = TRACER_FADE_MS / 1000;
  }

  /** Muzzle flash: visible for 2 frames. */
  flash(x: number, y: number, angle: number, big: boolean): void {
    const f = this.take();
    f.s.texture = Math.random() < 0.5 ? this.tex.flash0 : this.tex.flash1;
    f.s.anchor.set(0, 0.5);
    f.s.position.set(x, y);
    f.s.rotation = angle;
    f.s.scale.set(big ? 1.6 : 1);
    f.s.tint = 0xffffff;
    f.s.alpha = 1;
    f.s.visible = true;
    f.kind = 1;
    f.life = f.max = 2 / 60;
  }

  slash(x: number, y: number, angle: number, color: number): void {
    const f = this.take();
    f.s.texture = this.tex.slash;
    f.s.anchor.set(0.3, 0.5);
    f.s.position.set(x + Math.cos(angle) * 14, y + Math.sin(angle) * 14);
    f.s.rotation = angle;
    f.s.scale.set(1);
    f.s.tint = color;
    f.s.alpha = 1;
    f.s.visible = true;
    f.kind = 2;
    f.grow = 1.5;
    f.life = f.max = 0.16;
  }

  /** Expanding ring (explosions, pickups, spawns). */
  ring(x: number, y: number, radius: number, color: number, life: number, thin = false): void {
    const f = this.take();
    f.s.texture = thin ? this.tex.shock : this.tex.ring;
    f.s.anchor.set(0.5);
    f.s.position.set(x, y);
    f.s.rotation = 0;
    f.s.scale.set(0.1);
    f.s.tint = color;
    f.s.alpha = 1;
    f.s.visible = true;
    f.kind = thin ? 4 : 3;
    f.grow = (radius * 2) / 64;
    f.life = f.max = life;
  }

  damageNumber(x: number, y: number, amount: number, color: number): void {
    let n = this.nums[0];
    for (const m of this.nums) {
      if (m.life <= 0) { n = m; break; }
      if (m.life < n.life) n = m;
    }
    n.t.text = String(Math.max(1, Math.round(amount)));
    n.t.tint = color;
    n.t.position.set(x + (Math.random() - 0.5) * 16, y - 20);
    n.t.visible = true;
    n.t.alpha = 1;
    n.t.scale.set(1.3);
    n.life = 0.8;
    n.vy = -70;
  }

  update(dt: number): void {
    for (const f of this.fx) {
      if (f.life <= 0) continue;
      f.life -= dt;
      if (f.life <= 0) {
        f.s.visible = false;
        continue;
      }
      const t = 1 - f.life / f.max;
      if (f.kind === 0) f.s.alpha = 1 - t;
      else if (f.kind === 2) { f.s.alpha = 1 - t; f.s.scale.set(1 + t * (f.grow - 1)); }
      else if (f.kind >= 3) { f.s.scale.set(0.1 + (f.grow - 0.1) * (1 - (1 - t) * (1 - t))); f.s.alpha = 1 - t; }
    }
    for (const n of this.nums) {
      if (n.life <= 0) continue;
      n.life -= dt;
      if (n.life <= 0) { n.t.visible = false; continue; }
      n.t.y += n.vy * dt;
      n.vy *= 1 - 3 * dt;
      const s = n.t.scale.x;
      if (s > 1) n.t.scale.set(Math.max(1, s - dt * 3));
      n.t.alpha = Math.min(1, n.life * 3);
    }
  }
}
