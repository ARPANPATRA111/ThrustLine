// Original Hinglish sticker art, drawn in code so the repository carries no third-party
// meme images. Each sticker is a 256 px canvas: a burst, a cartoon face and a slang caption.
// The same canvases feed the DOM emote picker (as data URLs) and the in-world Pixi sprites.
import { Texture } from 'pixi.js';

const SIZE = 256;
const INK = '#17111f';

interface StickerDef {
  label: string;
  color: string;
  skin: string;
  hair: string;
  /** Which face/accessory scene to draw. */
  scene: 'cool' | 'shock' | 'thumbs' | 'chill' | 'shh' | 'rage' | 'confused' | 'bye';
}

export const STICKERS: StickerDef[] = [
  { label: 'BHAI', color: '#ff9f1c', skin: '#f2b880', hair: '#2b1a12', scene: 'cool' },
  { label: 'OYE', color: '#38bdf8', skin: '#e8a87c', hair: '#1d120c', scene: 'shock' },
  { label: 'JHAKAAS', color: '#a855f7', skin: '#f6c99f', hair: '#241007', scene: 'thumbs' },
  { label: 'BINDAAS', color: '#22c55e', skin: '#d99663', hair: '#180d07', scene: 'chill' },
  { label: 'CHUP', color: '#ef4444', skin: '#f0b27a', hair: '#1b0f09', scene: 'shh' },
  { label: 'DHAMAKA', color: '#f97316', skin: '#e8a06a', hair: '#160a05', scene: 'rage' },
  { label: 'KYA RE', color: '#facc15', skin: '#d89b6a', hair: '#1a0e08', scene: 'confused' },
  { label: 'TATA', color: '#14b8a6', skin: '#f3bd91', hair: '#201009', scene: 'bye' },
];

const canvases: (HTMLCanvasElement | null)[] = STICKERS.map(() => null);
const urls: (string | null)[] = STICKERS.map(() => null);
let textures: Texture[] | null = null;

function rrect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.lineTo(x + w - r, y);
  g.quadraticCurveTo(x + w, y, x + w, y + r);
  g.lineTo(x + w, y + h - r);
  g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  g.lineTo(x + r, y + h);
  g.quadraticCurveTo(x, y + h, x, y + h - r);
  g.lineTo(x, y + r);
  g.quadraticCurveTo(x, y, x + r, y);
  g.closePath();
}

function burst(g: CanvasRenderingContext2D, color: string, seed: number): void {
  const cx = 128;
  const cy = 108;
  const points = 14;
  g.save();
  g.translate(cx, cy);
  g.rotate((seed * 0.17) % (Math.PI * 2));
  g.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const outer = i % 2 === 0;
    const a = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
    const r = outer ? 118 : 86;
    const px = Math.cos(a) * r;
    const py = Math.sin(a) * r * 0.86;
    if (i === 0) g.moveTo(px, py);
    else g.lineTo(px, py);
  }
  g.closePath();
  g.lineWidth = 15;
  g.strokeStyle = '#fffdf5';
  g.lineJoin = 'round';
  g.stroke();
  g.fillStyle = color;
  g.fill();
  g.lineWidth = 4;
  g.strokeStyle = 'rgba(23, 17, 31, 0.45)';
  g.stroke();
  g.restore();
}

function head(g: CanvasRenderingContext2D, def: StickerDef): void {
  const cx = 128;
  const cy = 108;
  // Neck and shoulders, tucked behind the chin.
  g.beginPath();
  g.roundRect?.(106, 154, 44, 34, 12);
  if (!g.roundRect) rrect(g, 106, 154, 44, 34, 12);
  g.fillStyle = def.skin;
  g.fill();
  g.lineWidth = 4;
  g.strokeStyle = INK;
  g.stroke();

  // White sticker edge, dark keyline, then skin.
  g.beginPath();
  g.arc(cx, cy, 67, 0, Math.PI * 2);
  g.fillStyle = '#fffdf5';
  g.fill();
  g.beginPath();
  g.arc(cx, cy, 60, 0, Math.PI * 2);
  g.fillStyle = INK;
  g.fill();
  g.beginPath();
  g.arc(cx, cy, 55, 0, Math.PI * 2);
  g.fillStyle = def.skin;
  g.fill();

  // Hair cap and sideburns.
  g.beginPath();
  g.arc(cx, cy - 6, 55, Math.PI * 1.08, Math.PI * 1.92);
  g.lineTo(cx + 49, cy - 12);
  g.quadraticCurveTo(cx, cy - 50, cx - 49, cy - 12);
  g.closePath();
  g.fillStyle = def.hair;
  g.fill();
  g.lineWidth = 3;
  g.strokeStyle = INK;
  g.stroke();
  g.fillStyle = def.hair;
  rrect(g, 72, 80, 13, 34, 6);
  g.fill();
  rrect(g, 171, 80, 13, 34, 6);
  g.fill();

  // Ears.
  for (const x of [70, 186]) {
    g.beginPath();
    g.ellipse(x, cy + 6, 10, 15, 0, 0, Math.PI * 2);
    g.fillStyle = def.skin;
    g.fill();
    g.lineWidth = 3;
    g.strokeStyle = INK;
    g.stroke();
  }
}

function eye(g: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, pupil = 1): void {
  g.beginPath();
  g.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  g.fillStyle = '#fffdf5';
  g.fill();
  g.lineWidth = 3;
  g.strokeStyle = INK;
  g.stroke();
  g.beginPath();
  g.arc(x + pupil, y + 1, Math.max(3, rx * 0.42), 0, Math.PI * 2);
  g.fillStyle = INK;
  g.fill();
}

function brow(g: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number): void {
  g.beginPath();
  g.moveTo(x1, y1);
  g.lineTo(x2, y2);
  g.lineWidth = 7;
  g.lineCap = 'round';
  g.strokeStyle = INK;
  g.stroke();
}

function mouth(g: CanvasRenderingContext2D, kind: 'smile' | 'open' | 'flat' | 'shh' | 'rage' | 'smirk' | 'wavy'): void {
  g.lineCap = 'round';
  g.lineJoin = 'round';
  if (kind === 'smile' || kind === 'smirk') {
    g.beginPath();
    g.arc(128, 132, 22, 0.18, kind === 'smirk' ? Math.PI * 0.72 : Math.PI - 0.18);
    g.lineWidth = 5;
    g.strokeStyle = INK;
    g.stroke();
    return;
  }
  if (kind === 'flat') {
    g.beginPath();
    g.moveTo(112, 144);
    g.lineTo(144, 144);
    g.lineWidth = 5;
    g.strokeStyle = INK;
    g.stroke();
    return;
  }
  if (kind === 'wavy') {
    g.beginPath();
    g.moveTo(108, 143);
    g.quadraticCurveTo(118, 134, 128, 143);
    g.quadraticCurveTo(138, 152, 148, 142);
    g.lineWidth = 5;
    g.strokeStyle = INK;
    g.stroke();
    return;
  }
  if (kind === 'shh') {
    g.beginPath();
    g.ellipse(128, 144, 10, 7, 0, 0, Math.PI * 2);
    g.fillStyle = INK;
    g.fill();
    return;
  }
  // Open / rage: a shouting mouth with a tongue.
  g.beginPath();
  g.ellipse(128, 146, kind === 'rage' ? 24 : 18, kind === 'rage' ? 18 : 14, 0, 0, Math.PI * 2);
  g.fillStyle = '#5b1020';
  g.fill();
  g.lineWidth = 4;
  g.strokeStyle = INK;
  g.stroke();
  g.beginPath();
  g.ellipse(128, 154, 12, 7, 0, 0, Math.PI * 2);
  g.fillStyle = '#ff7c8e';
  g.fill();
}

function sparkle(g: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
  g.save();
  g.translate(x, y);
  g.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const rr = i % 2 === 0 ? r : r * 0.38;
    g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  g.closePath();
  g.lineWidth = 5;
  g.strokeStyle = '#fffdf5';
  g.stroke();
  g.fillStyle = color;
  g.fill();
  g.restore();
}

function sceneCool(g: CanvasRenderingContext2D): void {
  // Sunglasses.
  g.fillStyle = INK;
  rrect(g, 84, 94, 38, 24, 8);
  g.fill();
  rrect(g, 134, 94, 38, 24, 8);
  g.fill();
  g.fillRect(120, 101, 16, 6);
  g.fillStyle = 'rgba(255,255,255,0.35)';
  g.fillRect(90, 99, 9, 4);
  g.fillRect(140, 99, 9, 4);
  mouth(g, 'smirk');
}

function sceneShock(g: CanvasRenderingContext2D): void {
  eye(g, 106, 104, 15, 19, -2);
  eye(g, 150, 104, 15, 19, 2);
  brow(g, 92, 80, 118, 73);
  brow(g, 138, 73, 164, 80);
  mouth(g, 'open');
  sparkle(g, 54, 64, 13, '#fff07a');
  sparkle(g, 204, 150, 11, '#fff07a');
}

function sceneThumbs(g: CanvasRenderingContext2D): void {
  eye(g, 106, 104, 12, 15, 0);
  eye(g, 150, 104, 12, 15, 0);
  brow(g, 92, 82, 117, 79);
  brow(g, 139, 79, 164, 82);
  mouth(g, 'smile');
  // Upward thumb at the right of the face.
  g.save();
  g.translate(196, 138);
  g.rotate(-0.28);
  g.beginPath();
  g.roundRect?.(-14, -4, 30, 38, 10);
  if (!g.roundRect) rrect(g, -14, -4, 30, 38, 10);
  g.fillStyle = '#f6c99f';
  g.lineWidth = 8;
  g.strokeStyle = '#fffdf5';
  g.stroke();
  g.fill();
  g.lineWidth = 3;
  g.strokeStyle = INK;
  g.stroke();
  g.beginPath();
  g.roundRect?.(-9, -34, 18, 34, 9);
  if (!g.roundRect) rrect(g, -9, -34, 18, 34, 9);
  g.fillStyle = '#f6c99f';
  g.lineWidth = 8;
  g.strokeStyle = '#fffdf5';
  g.stroke();
  g.fill();
  g.lineWidth = 3;
  g.strokeStyle = INK;
  g.stroke();
  g.restore();
}

function sceneChill(g: CanvasRenderingContext2D): void {
  // Round shades and a relaxed smile.
  for (const x of [106, 150]) {
    g.beginPath();
    g.arc(x, 104, 17, 0, Math.PI * 2);
    g.fillStyle = INK;
    g.fill();
    g.lineWidth = 4;
    g.strokeStyle = '#fffdf5';
    g.stroke();
  }
  g.beginPath();
  g.moveTo(123, 104);
  g.lineTo(133, 104);
  g.lineWidth = 5;
  g.strokeStyle = INK;
  g.stroke();
  mouth(g, 'smile');
  sparkle(g, 205, 62, 10, '#b6ff9e');
}

function sceneShh(g: CanvasRenderingContext2D): void {
  eye(g, 106, 100, 12, 15, 0);
  eye(g, 150, 100, 12, 15, 0);
  brow(g, 92, 81, 119, 84);
  brow(g, 137, 84, 164, 81);
  mouth(g, 'shh');
  // Finger raised over the lips.
  g.save();
  g.translate(128, 134);
  g.rotate(0.06);
  g.beginPath();
  g.roundRect?.(-10, -12, 20, 52, 10);
  if (!g.roundRect) rrect(g, -10, -12, 20, 52, 10);
  g.fillStyle = '#f0b27a';
  g.lineWidth = 8;
  g.strokeStyle = '#fffdf5';
  g.stroke();
  g.fill();
  g.lineWidth = 3;
  g.strokeStyle = INK;
  g.stroke();
  g.beginPath();
  g.ellipse(0, 36, 7, 5, 0, 0, Math.PI * 2);
  g.fillStyle = '#ffd9c2';
  g.fill();
  g.restore();
}

function sceneRage(g: CanvasRenderingContext2D): void {
  eye(g, 106, 104, 13, 15, 0);
  eye(g, 150, 104, 13, 15, 0);
  brow(g, 88, 76, 120, 90);
  brow(g, 136, 90, 168, 76);
  mouth(g, 'rage');
  // Steam puffs.
  for (const [x, y, r] of [[66, 58, 10], [188, 60, 9], [203, 92, 7]] as const) {
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fillStyle = '#fffdf5';
    g.fill();
    g.lineWidth = 3;
    g.strokeStyle = INK;
    g.stroke();
  }
}

function sceneConfused(g: CanvasRenderingContext2D): void {
  eye(g, 106, 105, 11, 14, 0);
  eye(g, 150, 100, 14, 17, 1);
  brow(g, 92, 88, 118, 88);
  brow(g, 136, 74, 164, 84);
  mouth(g, 'wavy');
  g.font = '900 46px Impact, "Arial Black", sans-serif';
  g.textAlign = 'center';
  g.lineWidth = 7;
  g.strokeStyle = '#fffdf5';
  g.strokeText('?', 56, 74);
  g.fillStyle = INK;
  g.fillText('?', 56, 74);
  g.font = '900 34px Impact, "Arial Black", sans-serif';
  g.strokeText('?', 204, 92);
  g.fillText('?', 204, 92);
}

function sceneBye(g: CanvasRenderingContext2D): void {
  eye(g, 106, 104, 12, 15, 0);
  eye(g, 150, 104, 12, 15, 0);
  brow(g, 92, 82, 118, 80);
  brow(g, 138, 80, 164, 82);
  mouth(g, 'smile');
  // Waving hand on the right, with motion arcs.
  g.save();
  g.translate(200, 118);
  g.rotate(-0.35);
  g.beginPath();
  g.roundRect?.(-15, 0, 30, 34, 10);
  if (!g.roundRect) rrect(g, -15, 0, 30, 34, 10);
  g.fillStyle = '#f3bd91';
  g.lineWidth = 8;
  g.strokeStyle = '#fffdf5';
  g.stroke();
  g.fill();
  g.lineWidth = 3;
  g.strokeStyle = INK;
  g.stroke();
  for (let i = 0; i < 4; i++) {
    g.beginPath();
    g.roundRect?.(-18 + i * 10, -24, 8, 30, 4);
    if (!g.roundRect) rrect(g, -18 + i * 10, -24, 8, 30, 4);
    g.fillStyle = '#f3bd91';
    g.lineWidth = 6;
    g.strokeStyle = '#fffdf5';
    g.stroke();
    g.fill();
    g.lineWidth = 2.5;
    g.strokeStyle = INK;
    g.stroke();
  }
  g.restore();
  g.beginPath();
  g.arc(190, 118, 52, -0.9, -0.3);
  g.lineWidth = 5;
  g.strokeStyle = '#fffdf5';
  g.lineCap = 'round';
  g.stroke();
  g.beginPath();
  g.arc(188, 120, 64, -0.85, -0.35);
  g.lineWidth = 3;
  g.strokeStyle = 'rgba(255,255,255,0.7)';
  g.stroke();
}

function caption(g: CanvasRenderingContext2D, text: string): void {
  g.save();
  g.font = '900 36px Impact, "Arial Black", "Segoe UI", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  let size = 36;
  while (g.measureText(text).width > 184 && size > 20) {
    size -= 2;
    g.font = `900 ${size}px Impact, "Arial Black", "Segoe UI", sans-serif`;
  }
  g.beginPath();
  g.roundRect?.(20, 188, 216, 50, 24);
  if (!g.roundRect) rrect(g, 20, 188, 216, 50, 24);
  g.fillStyle = 'rgba(23, 17, 31, 0.94)';
  g.fill();
  g.lineWidth = 7;
  g.strokeStyle = '#fffdf5';
  g.stroke();
  g.fillStyle = '#fffdf5';
  g.fillText(text, 128, 215);
  g.restore();
}

function draw(index: number): HTMLCanvasElement {
  const def = STICKERS[index];
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const g = canvas.getContext('2d')!;
  g.clearRect(0, 0, SIZE, SIZE);
  // Soft drop shadow so stickers read over both bright sky and dark walls.
  g.save();
  g.translate(5, 7);
  g.globalAlpha = 0.28;
  g.fillStyle = '#000';
  g.beginPath();
  g.ellipse(128, 122, 112, 104, 0, 0, Math.PI * 2);
  g.fill();
  g.restore();

  burst(g, def.color, index);
  head(g, def);
  if (def.scene === 'cool') sceneCool(g);
  else if (def.scene === 'shock') sceneShock(g);
  else if (def.scene === 'thumbs') sceneThumbs(g);
  else if (def.scene === 'chill') sceneChill(g);
  else if (def.scene === 'shh') sceneShh(g);
  else if (def.scene === 'rage') sceneRage(g);
  else if (def.scene === 'confused') sceneConfused(g);
  else sceneBye(g);
  caption(g, def.label);
  return canvas;
}

export function stickerCanvas(index: number): HTMLCanvasElement {
  const safe = Math.max(0, Math.min(STICKERS.length - 1, index | 0));
  return (canvases[safe] ??= draw(safe));
}

/** PNG data URL for the DOM emote picker. */
export function stickerDataURL(index: number): string {
  const safe = Math.max(0, Math.min(STICKERS.length - 1, index | 0));
  return (urls[safe] ??= stickerCanvas(safe).toDataURL('image/png'));
}

/** Pixi textures for the in-world emote sprites, built once on first use. */
export function stickerTextures(): Texture[] {
  return (textures ??= STICKERS.map((_, i) => Texture.from(stickerCanvas(i))));
}
