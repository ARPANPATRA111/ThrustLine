// One particle pool for sparks, smoke, bubbles and death bursts.
// Uses Pixi v8's ParticleContainer (all particles share the atlas texture) with a fixed pool:
// particles are recycled, never allocated during play. Two containers: normal and additive.
import { Particle, ParticleContainer, type Texture } from 'pixi.js';
import { PARTICLE_CAP_HIGH } from '@shared/config';

export interface EmitOpts {
  tex: Texture;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number; // seconds
  scale0: number;
  scale1: number;
  color: number;
  alpha?: number;
  additive?: boolean;
  gravity?: number;
  drag?: number;
  spin?: number;
  rotation?: number;
  /** Align rotation with velocity (sparks). */
  align?: boolean;
}

const N = PARTICLE_CAP_HIGH;

export class Particles {
  normal = new ParticleContainer({ dynamicProperties: { position: true, rotation: true, color: true, vertex: true, uvs: true } });
  additive = new ParticleContainer({ dynamicProperties: { position: true, rotation: true, color: true, vertex: true, uvs: true } });
  /** Active particle cap, lowered by the quality governor. */
  cap = PARTICLE_CAP_HIGH;
  private items: Particle[] = [];
  private isAdd = new Uint8Array(N);
  private vx = new Float32Array(N);
  private vy = new Float32Array(N);
  private life = new Float32Array(N);
  private maxLife = new Float32Array(N);
  private s0 = new Float32Array(N);
  private s1 = new Float32Array(N);
  private a0 = new Float32Array(N);
  private grav = new Float32Array(N);
  private drag = new Float32Array(N);
  private spin = new Float32Array(N);
  private alignV = new Uint8Array(N);
  private active = 0;
  private next = 0;

  constructor(blank: Texture) {
    this.additive.blendMode = 'add';
    for (let i = 0; i < N; i++) {
      // Each particle lives in one container for its whole life; half normal, half additive.
      const p = new Particle({ texture: blank, anchorX: 0.5, anchorY: 0.5, alpha: 0, scaleX: 0, scaleY: 0 });
      this.items.push(p);
      this.isAdd[i] = i % 2;
      (i % 2 ? this.additive : this.normal).addParticle(p);
    }
  }

  emit(o: EmitOpts): void {
    if (this.active >= this.cap) return;
    // Find a free slot of the right container type, round-robin.
    const want = o.additive ? 1 : 0;
    for (let k = 0; k < N; k++) {
      const i = (this.next + k) % N;
      if (this.life[i] > 0 || this.isAdd[i] !== want) continue;
      this.next = (i + 1) % N;
      const p = this.items[i];
      p.texture = o.tex;
      p.x = o.x;
      p.y = o.y;
      p.tint = o.color;
      p.alpha = o.alpha ?? 1;
      p.rotation = o.rotation ?? 0;
      p.scaleX = p.scaleY = o.scale0;
      this.vx[i] = o.vx;
      this.vy[i] = o.vy;
      this.life[i] = this.maxLife[i] = o.life;
      this.s0[i] = o.scale0;
      this.s1[i] = o.scale1;
      this.a0[i] = o.alpha ?? 1;
      this.grav[i] = o.gravity ?? 0;
      this.drag[i] = o.drag ?? 0;
      this.spin[i] = o.spin ?? 0;
      this.alignV[i] = o.align ? 1 : 0;
      this.active++;
      return;
    }
  }

  update(dt: number, viewL: number, viewT: number, viewR: number, viewB: number): void {
    let active = 0;
    for (let i = 0; i < N; i++) {
      if (this.life[i] <= 0) continue;
      const p = this.items[i];
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        p.alpha = 0;
        p.scaleX = p.scaleY = 0;
        continue;
      }
      active++;
      const k = 1 - this.drag[i] * dt;
      this.vx[i] *= k;
      this.vy[i] = this.vy[i] * k + this.grav[i] * dt;
      p.x += this.vx[i] * dt;
      p.y += this.vy[i] * dt;
      // Cull: particles far off-screen die early.
      if (p.x < viewL - 100 || p.x > viewR + 100 || p.y < viewT - 100 || p.y > viewB + 100) {
        this.life[i] = 0;
        p.alpha = 0;
        p.scaleX = p.scaleY = 0;
        continue;
      }
      const t = 1 - this.life[i] / this.maxLife[i];
      const s = this.s0[i] + (this.s1[i] - this.s0[i]) * t;
      p.scaleX = p.scaleY = s;
      p.alpha = this.a0[i] * (1 - t * t);
      if (this.alignV[i]) p.rotation = Math.atan2(this.vy[i], this.vx[i]);
      else p.rotation += this.spin[i] * dt;
    }
    this.active = active;
    this.normal.update();
    this.additive.update();
  }
}
