// Bake RIG-7 into a few big textures at load, so the whole static map costs ~6 sprites per
// frame. Tiles are never drawn per frame. Also builds the parallax backdrops and acid texture.
import { Container, Sprite, Texture, TilingSprite } from 'pixi.js';
import { MAP_CHUNK, TILE } from '@shared/config';
import { type GameMap, MAP_H, MAP_W, T_ACID, T_ONEWAY, T_SOLID, tileAt } from '@shared/map';

const C_SOLID = '#2a3350';
const C_SOLID_DARK = '#1e2642';
const C_LIP = '#5b6b9a';
const C_GRATE = '#6b7aa8';

/** Draw one tile of the map into a 2D context at (px, py). */
function drawTile(g: CanvasRenderingContext2D, map: GameMap, tx: number, ty: number, px: number, py: number): void {
  const code = tileAt(map, tx, ty);
  if (code === T_SOLID) {
    // 4-neighbour mask: which faces are exposed to open space?
    const up = tileAt(map, tx, ty - 1) !== T_SOLID;
    const down = tileAt(map, tx, ty + 1) !== T_SOLID;
    const left = tileAt(map, tx - 1, ty) !== T_SOLID;
    const right = tileAt(map, tx + 1, ty) !== T_SOLID;
    g.fillStyle = C_SOLID;
    g.fillRect(px, py, TILE, TILE);
    // Subtle panel seams.
    g.fillStyle = 'rgba(0,0,0,0.12)';
    g.fillRect(px, py + TILE - 1, TILE, 1);
    g.fillRect(px + TILE - 1, py, 1, TILE);
    if (left) { g.fillStyle = C_SOLID_DARK; g.fillRect(px, py, 3, TILE); }
    if (right) { g.fillStyle = C_SOLID_DARK; g.fillRect(px + TILE - 3, py, 3, TILE); }
    if (down) { g.fillStyle = '#151b33'; g.fillRect(px, py + TILE - 4, TILE, 4); }
    if (up) {
      // Bright top lip with rivets.
      g.fillStyle = C_LIP;
      g.fillRect(px, py, TILE, 5);
      g.fillStyle = '#8796c8';
      g.fillRect(px, py, TILE, 1.5);
      g.fillStyle = '#0b1020';
      g.beginPath();
      g.arc(px + 7, py + 11, 1.6, 0, Math.PI * 2);
      g.arc(px + TILE - 7, py + 11, 1.6, 0, Math.PI * 2);
      g.fill();
    }
  } else if (code === T_ONEWAY) {
    // Grate: solid top bar with slats underneath.
    g.fillStyle = C_GRATE;
    g.fillRect(px, py, TILE, 6);
    g.fillStyle = '#9aa8d8';
    g.fillRect(px, py, TILE, 1.5);
    g.fillStyle = 'rgba(107,122,168,0.55)';
    for (let i = 2; i < TILE; i += 6) g.fillRect(px + i, py + 6, 2, 7);
    g.fillStyle = 'rgba(107,122,168,0.35)';
    g.fillRect(px, py + 12, TILE, 2);
  } else if (code !== T_ACID && tileAt(map, tx, ty - 1) === T_ONEWAY && tx % 6 === 0) {
    // Background girder under platforms.
    g.strokeStyle = 'rgba(91,107,154,0.18)';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(px + 4, py);
    g.lineTo(px + TILE - 4, py + TILE);
    g.moveTo(px + TILE - 4, py);
    g.lineTo(px + 4, py + TILE);
    g.stroke();
  }
}

/** Bake the map into MAP_CHUNK-sized textures and return a container of sprites. */
export function bakeMap(map: GameMap): Container {
  const layer = new Container();
  const tilesPerChunk = MAP_CHUNK / TILE;
  for (let cy = 0; cy * MAP_CHUNK < MAP_H; cy++) {
    for (let cx = 0; cx * MAP_CHUNK < MAP_W; cx++) {
      const w = Math.min(MAP_CHUNK, MAP_W - cx * MAP_CHUNK);
      const h = Math.min(MAP_CHUNK, MAP_H - cy * MAP_CHUNK);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const g = canvas.getContext('2d')!;
      for (let ty = 0; ty < h / TILE; ty++) {
        for (let tx = 0; tx < w / TILE; tx++) {
          drawTile(g, map, cx * tilesPerChunk + tx, cy * tilesPerChunk + ty, tx * TILE, ty * TILE);
        }
      }
      const s = new Sprite(Texture.from(canvas));
      s.position.set(cx * MAP_CHUNK, cy * MAP_CHUNK);
      layer.addChild(s);
    }
  }
  return layer;
}

/** Bounding rectangle of all acid tiles (the pit). */
export function acidRect(map: GameMap): { x: number; y: number; w: number; h: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let ty = 0; ty < map.rows; ty++) {
    for (let tx = 0; tx < map.cols; tx++) {
      if (tileAt(map, tx, ty) === T_ACID) {
        x0 = Math.min(x0, tx); y0 = Math.min(y0, ty); x1 = Math.max(x1, tx); y1 = Math.max(y1, ty);
      }
    }
  }
  return { x: x0 * TILE, y: y0 * TILE, w: (x1 - x0 + 1) * TILE, h: (y1 - y0 + 1) * TILE };
}

/** Scrolling acid surface texture. */
export function makeAcid(rect: { x: number; y: number; w: number; h: number }): TilingSprite {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, 64);
  grad.addColorStop(0, '#9dff74');
  grad.addColorStop(0.15, '#7cff4f');
  grad.addColorStop(1, '#2d7a1a');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  g.strokeStyle = 'rgba(220,255,200,0.55)';
  g.lineWidth = 2;
  g.beginPath();
  for (let x = 0; x <= 64; x += 2) g.lineTo(x, 4 + Math.sin((x / 64) * Math.PI * 2) * 2);
  g.stroke();
  g.fillStyle = 'rgba(255,255,255,0.12)';
  for (let i = 0; i < 6; i++) g.fillRect((i * 23) % 64, 16 + ((i * 17) % 40), 6, 2);
  const ts = new TilingSprite({ texture: Texture.from(c), width: rect.w, height: rect.h });
  ts.position.set(rect.x, rect.y);
  return ts;
}

/** Three backdrop textures: far skyline, mid pipes/girders, near fog band. */
export function makeParallaxTextures(): Texture[] {
  const W = 1024, H = 512;
  const mk = (draw: (g: CanvasRenderingContext2D) => void) => {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    draw(c.getContext('2d')!);
    return Texture.from(c);
  };
  // Deterministic pseudo-random so the backdrop looks the same every load.
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

  const far = mk((g) => {
    const sky = g.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#0b1020');
    sky.addColorStop(1, '#1b2340');
    g.fillStyle = sky;
    g.fillRect(0, 0, W, H);
    for (let i = 0; i < 40; i++) { g.fillStyle = `rgba(230,236,255,${0.2 + rnd() * 0.5})`; g.fillRect(rnd() * W, rnd() * H * 0.5, 1.5, 1.5); }
    // Distant rig silhouettes.
    g.fillStyle = '#141a33';
    for (let x = 0; x < W; x += 90 + rnd() * 60) {
      const w = 30 + rnd() * 40;
      const h = 120 + rnd() * 200;
      g.fillRect(x, H - h, w, h);
      g.fillRect(x - 12, H - h, w + 24, 8);
      g.fillRect(x + w / 2 - 2, H - h - 40, 4, 40);
      g.fillStyle = 'rgba(255,90,90,0.8)';
      g.fillRect(x + w / 2 - 2, H - h - 44, 4, 4);
      g.fillStyle = '#141a33';
    }
  });
  const mid = mk((g) => {
    g.strokeStyle = 'rgba(42,51,80,0.75)';
    g.lineWidth = 10;
    for (let i = 0; i < 4; i++) {
      const y = 120 + i * 90 + rnd() * 30;
      g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
    }
    g.lineWidth = 4;
    g.strokeStyle = 'rgba(42,51,80,0.6)';
    for (let x = 0; x < W; x += 128) {
      g.beginPath(); g.moveTo(x, 100); g.lineTo(x, H); g.stroke();
      g.beginPath(); g.moveTo(x, 100); g.lineTo(x + 128, H); g.stroke();
    }
  });
  const near = mk((g) => {
    const fog = g.createLinearGradient(0, 0, 0, H);
    fog.addColorStop(0, 'rgba(120,140,255,0)');
    fog.addColorStop(0.7, 'rgba(120,140,255,0.06)');
    fog.addColorStop(1, 'rgba(124,255,79,0.12)');
    g.fillStyle = fog;
    g.fillRect(0, 0, W, H);
  });
  return [far, mid, near];
}
