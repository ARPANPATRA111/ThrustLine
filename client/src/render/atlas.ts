// Every sprite in the game is drawn here, in code, at load time. Each part is drawn with the
// Canvas 2D API into its own region of ONE atlas canvas (packed with a simple shelf packer),
// which becomes one GPU texture. All sprites then share a texture and batch together.
// The atlas is drawn at 2x resolution so it stays crisp on high-DPI screens.
import { CanvasSource, Rectangle, Texture } from 'pixi.js';

const RES = 2;
const ATLAS_SIZE = 1024; // logical px (2048 physical)
const PAD = 2;
const OUTLINE = '#0b1020';

type Draw = (g: CanvasRenderingContext2D, w: number, h: number) => void;
interface Part {
  name: string;
  w: number;
  h: number;
  draw: Draw;
}

// ---------- drawing helpers ----------
function rr(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}
function fillStroke(g: CanvasRenderingContext2D, fill: string, lw = 2) {
  g.fillStyle = fill;
  g.fill();
  g.lineWidth = lw;
  g.strokeStyle = OUTLINE;
  g.stroke();
}
function radial(g: CanvasRenderingContext2D, w: number, h: number, stops: [number, string][]) {
  const grad = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.min(w, h) / 2);
  for (const [o, c] of stops) grad.addColorStop(o, c);
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
}

// ---------- weapon silhouettes (also reused for HUD icons) ----------
export const WEAPON_DRAW: Draw[] = [
  // Pistol
  (g) => { rr(g, 2, 1, 15, 5, 1.5); fillStroke(g, '#cfd8ff'); rr(g, 4, 4, 4, 6, 1); fillStroke(g, '#8e9ac8'); },
  // AR
  (g) => { rr(g, 1, 2, 31, 5, 1.5); fillStroke(g, '#cfd8ff'); rr(g, 10, 5, 4, 6, 1); fillStroke(g, '#8e9ac8'); rr(g, 17, 5, 4, 5, 1); fillStroke(g, '#8e9ac8'); rr(g, 0, 2, 6, 6, 1); fillStroke(g, '#8e9ac8'); },
  // Shotgun
  (g) => { rr(g, 1, 2, 30, 6, 2); fillStroke(g, '#cfd8ff'); rr(g, 12, 6, 12, 3, 1); fillStroke(g, '#ffb35c'); rr(g, 0, 3, 7, 6, 1.5); fillStroke(g, '#8e9ac8'); },
  // Sniper
  (g) => { rr(g, 1, 3, 44, 4, 1.5); fillStroke(g, '#cfd8ff'); rr(g, 14, 0, 12, 3, 1); fillStroke(g, '#22d3ee'); rr(g, 0, 3, 8, 5, 1.5); fillStroke(g, '#8e9ac8'); },
  // Knife
  (g) => { g.beginPath(); g.moveTo(6, 1); g.lineTo(17, 3); g.lineTo(6, 5); g.closePath(); fillStroke(g, '#e6ecff', 1.5); rr(g, 0, 1.5, 6, 3, 1); fillStroke(g, '#8e9ac8', 1.5); },
  // Frag
  (g, w, h) => { g.beginPath(); g.ellipse(w / 2, h / 2 + 1, 4, 5, 0, 0, Math.PI * 2); fillStroke(g, '#7cff4f'); rr(g, w / 2 - 2, 0, 4, 3, 1); fillStroke(g, '#8e9ac8', 1.5); },
];
export const WEAPON_SIZE: [number, number][] = [[18, 11], [33, 12], [32, 10], [46, 9], [18, 6], [10, 13]];

const PARTS: Part[] = [
  // ---------- Soldier (white parts get tinted per player) ----------
  { name: 'torso', w: 20, h: 26, draw: (g) => { rr(g, 1, 1, 18, 24, 8); fillStroke(g, '#ffffff'); g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(3, 15, 14, 3); } },
  { name: 'helmet', w: 22, h: 20, draw: (g) => { rr(g, 1, 1, 20, 18, 8); fillStroke(g, '#ffffff'); } },
  { name: 'visor', w: 12, h: 7, draw: (g) => { rr(g, 1, 1, 10, 5, 2.5); fillStroke(g, '#bff6ff', 1.5); g.fillStyle = 'rgba(255,255,255,0.9)'; g.fillRect(3, 2, 3, 1.5); } },
  { name: 'leg', w: 9, h: 17, draw: (g) => { rr(g, 1, 1, 7, 15, 3); fillStroke(g, '#3a4570'); rr(g, 1, 11, 7, 5, 2); fillStroke(g, '#1f2745', 1.5); } },
  { name: 'arm', w: 14, h: 7, draw: (g) => { rr(g, 1, 1, 12, 5, 2.5); fillStroke(g, '#ffffff', 1.5); } },
  { name: 'jetpack', w: 13, h: 22, draw: (g) => { rr(g, 1, 1, 11, 17, 3); fillStroke(g, '#56628f'); rr(g, 3, 16, 7, 5, 1.5); fillStroke(g, '#2a3350', 1.5); g.fillStyle = '#ffb35c'; g.fillRect(4, 4, 5, 2); } },

  // ---------- Effects (white so they can be tinted) ----------
  { name: 'flash0', w: 26, h: 16, draw: (g, w, h) => { g.fillStyle = '#fff6c8'; g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w * 0.45, 1); g.lineTo(w * 0.55, h * 0.35); g.lineTo(w, h / 2); g.lineTo(w * 0.55, h * 0.65); g.lineTo(w * 0.45, h - 1); g.closePath(); g.fill(); } },
  { name: 'flash1', w: 26, h: 16, draw: (g, w, h) => { g.fillStyle = '#ffffff'; g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w * 0.3, 3); g.lineTo(w * 0.7, h * 0.4); g.lineTo(w, h / 2); g.lineTo(w * 0.7, h * 0.6); g.lineTo(w * 0.3, h - 3); g.closePath(); g.fill(); } },
  { name: 'tracer', w: 8, h: 4, draw: (g, w, h) => { const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.5, '#ffffff'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, w, h); } },
  { name: 'spark', w: 8, h: 3, draw: (g) => { rr(g, 0, 0, 8, 3, 1.5); g.fillStyle = '#ffffff'; g.fill(); } },
  { name: 'dot', w: 32, h: 32, draw: (g, w, h) => radial(g, w, h, [[0, 'rgba(255,255,255,1)'], [0.35, 'rgba(255,255,255,0.6)'], [1, 'rgba(255,255,255,0)']]) },
  { name: 'smoke', w: 32, h: 32, draw: (g, w, h) => radial(g, w, h, [[0, 'rgba(255,255,255,0.7)'], [0.6, 'rgba(255,255,255,0.35)'], [1, 'rgba(255,255,255,0)']]) },
  { name: 'ring', w: 64, h: 64, draw: (g, w) => { g.beginPath(); g.arc(w / 2, w / 2, w / 2 - 5, 0, Math.PI * 2); g.lineWidth = 7; g.strokeStyle = '#ffffff'; g.stroke(); } },
  { name: 'shock', w: 64, h: 64, draw: (g, w) => { g.beginPath(); g.arc(w / 2, w / 2, w / 2 - 2, 0, Math.PI * 2); g.lineWidth = 2; g.strokeStyle = '#ffffff'; g.stroke(); } },
  { name: 'flame0', w: 12, h: 22, draw: flame(0) },
  { name: 'flame1', w: 12, h: 22, draw: flame(1) },
  { name: 'flame2', w: 12, h: 22, draw: flame(2) },
  { name: 'bubble', w: 56, h: 72, draw: (g, w, h) => { g.beginPath(); g.ellipse(w / 2, h / 2, w / 2 - 2, h / 2 - 2, 0, 0, Math.PI * 2); g.fillStyle = 'rgba(255,255,255,0.12)'; g.fill(); g.lineWidth = 2; g.strokeStyle = 'rgba(255,255,255,0.8)'; g.stroke(); } },
  { name: 'crown', w: 18, h: 12, draw: crown },
  { name: 'slash', w: 48, h: 48, draw: (g, w) => { g.beginPath(); g.arc(w / 2 - 8, w / 2, w / 2 - 4, -1.1, 1.1); g.lineWidth = 5; g.strokeStyle = '#ffffff'; g.lineCap = 'round'; g.stroke(); } },
  { name: 'square', w: 4, h: 4, draw: (g) => { g.fillStyle = '#ffffff'; g.fillRect(0, 0, 4, 4); } },
  { name: 'bubbleAcid', w: 8, h: 8, draw: (g) => { g.beginPath(); g.arc(4, 4, 3, 0, Math.PI * 2); g.lineWidth = 1.5; g.strokeStyle = '#ffffff'; g.stroke(); } },

  // ---------- Pickups with baked glow halos ----------
  { name: 'pk0', w: 48, h: 48, draw: pickup('#ff4d6d', (g) => { g.fillStyle = '#ffffff'; g.fillRect(20, 13, 8, 22); g.fillRect(13, 20, 22, 8); }) },
  { name: 'pk1', w: 48, h: 48, draw: pickup('#fbbf24', (g) => { rr(g, 13, 16, 22, 16, 2); fillStroke(g, '#c8892a'); g.fillStyle = '#ffe9a8'; g.fillRect(15, 22, 18, 3); }) },
  { name: 'pk2', w: 48, h: 48, draw: pickup('#7cff4f', (g) => { g.beginPath(); g.ellipse(24, 26, 7, 9, 0, 0, Math.PI * 2); fillStroke(g, '#5fcf3a'); rr(g, 21, 14, 6, 4, 1); fillStroke(g, '#8e9ac8', 1.5); }) },

  // ---------- UI icons ----------
  { name: 'skull', w: 16, h: 16, draw: (g) => { g.beginPath(); g.arc(8, 7, 6, 0, Math.PI * 2); g.fillStyle = '#e6ecff'; g.fill(); g.fillRect(5, 11, 6, 4); g.fillStyle = OUTLINE; g.fillRect(4.5, 5, 3, 3); g.fillRect(8.5, 5, 3, 3); } },
  { name: 'crownIcon', w: 18, h: 12, draw: crown },
];
WEAPON_DRAW.forEach((draw, i) => PARTS.push({ name: `w${i}`, w: WEAPON_SIZE[i][0], h: WEAPON_SIZE[i][1], draw }));

function flame(variant: number): Draw {
  return (g, w, h) => {
    const len = h * (0.7 + variant * 0.15);
    const grad = g.createLinearGradient(0, 0, 0, len);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.35, '#ffd54a');
    grad.addColorStop(1, 'rgba(255,90,40,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(1, 0);
    g.quadraticCurveTo(w / 2 + (variant - 1) * 2, len * 1.1, w - 1, 0);
    g.closePath();
    g.fill();
  };
}
function crown(g: CanvasRenderingContext2D) {
  g.beginPath();
  g.moveTo(1, 11); g.lineTo(1, 3); g.lineTo(5, 7); g.lineTo(9, 1); g.lineTo(13, 7); g.lineTo(17, 3); g.lineTo(17, 11); g.closePath();
  g.fillStyle = '#ffd54a';
  g.fill();
  g.lineWidth = 1.5;
  g.strokeStyle = OUTLINE;
  g.stroke();
}
function pickup(glow: string, icon: (g: CanvasRenderingContext2D) => void): Draw {
  return (g, w, h) => {
    radial(g, w, h, [[0, glow + 'aa'], [0.5, glow + '44'], [1, glow + '00']]);
    icon(g);
  };
}

export interface Atlas {
  tex: Record<string, Texture>;
  /** PNG data URL of one part, for DOM icons (kill feed, HUD). */
  iconURL(name: string, scale?: number): string;
}

/** Draw and pack every part, upload once, and return named textures. */
export function buildAtlas(): Atlas {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_SIZE * RES;
  canvas.height = ATLAS_SIZE * RES;
  const g = canvas.getContext('2d')!;

  // Shelf packer: place parts left to right; start a new shelf when the row is full.
  const sorted = [...PARTS].sort((a, b) => b.h - a.h);
  const frames: Record<string, Rectangle> = {};
  let x = 0, y = 0, shelfH = 0;
  for (const p of sorted) {
    if (x + p.w + PAD > ATLAS_SIZE) { x = 0; y += shelfH + PAD; shelfH = 0; }
    if (y + p.h > ATLAS_SIZE) throw new Error('Atlas overflow');
    g.save();
    g.scale(RES, RES);
    g.translate(x, y);
    g.beginPath();
    g.rect(0, 0, p.w, p.h);
    g.clip();
    p.draw(g, p.w, p.h);
    g.restore();
    frames[p.name] = new Rectangle(x, y, p.w, p.h);
    x += p.w + PAD;
    shelfH = Math.max(shelfH, p.h);
  }

  const source = new CanvasSource({ resource: canvas, resolution: RES, scaleMode: 'linear' });
  const tex: Record<string, Texture> = {};
  for (const name in frames) tex[name] = new Texture({ source, frame: frames[name] });

  const urlCache = new Map<string, string>();
  return {
    tex,
    iconURL(name, scale = 2) {
      const key = `${name}@${scale}`;
      const cached = urlCache.get(key);
      if (cached) return cached;
      const p = PARTS.find((q) => q.name === name)!;
      const c = document.createElement('canvas');
      c.width = p.w * scale;
      c.height = p.h * scale;
      const cg = c.getContext('2d')!;
      cg.scale(scale, scale);
      p.draw(cg, p.w, p.h);
      const url = c.toDataURL();
      urlCache.set(key, url);
      return url;
    },
  };
}
