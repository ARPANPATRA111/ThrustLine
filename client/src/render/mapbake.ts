// Bake RIG-7 into a few big textures at load, so the whole static map costs ~6 sprites per
// frame. Tiles are never drawn per frame. Also builds the parallax backdrops and acid texture.
import { Container, Sprite, Texture, TilingSprite } from 'pixi.js';
import { MAP_CHUNK, TILE } from '@shared/config';
import { type GameMap, MAP_H, MAP_W, T_ACID, T_ONEWAY, T_SOLID, tileAt } from '@shared/map';

/** Cheap deterministic hash so decorative details are the same on every load. */
function hash(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Draw one tile of the map into a 2D context at (px, py). */
function drawTile(g: CanvasRenderingContext2D, map: GameMap, tx: number, ty: number, px: number, py: number): void {
  const code = tileAt(map, tx, ty);
  if (code === T_SOLID) {
    // 4-neighbour mask: which faces are exposed to open space?
    const up = tileAt(map, tx, ty - 1) !== T_SOLID;
    const down = tileAt(map, tx, ty + 1) !== T_SOLID;
    const left = tileAt(map, tx - 1, ty) !== T_SOLID;
    const right = tileAt(map, tx + 1, ty) !== T_SOLID;
    // Brushed-metal body: a gentle vertical gradient per tile.
    const grad = g.createLinearGradient(0, py, 0, py + TILE);
    grad.addColorStop(0, '#2d3866');
    grad.addColorStop(1, '#222b52');
    g.fillStyle = grad;
    g.fillRect(px, py, TILE, TILE);
    // Panel seams and a soft inner highlight.
    g.fillStyle = 'rgba(0,0,0,0.18)';
    g.fillRect(px, py + TILE - 1, TILE, 1);
    g.fillRect(px + TILE - 1, py, 1, TILE);
    g.fillStyle = 'rgba(255,255,255,0.035)';
    g.fillRect(px + 1, py + 1, TILE - 3, 1);
    // Deep interior tiles sometimes carry a lit window strip or a vent.
    const h = hash(tx, ty);
    if (!up && !down && !left && !right) {
      if (h < 0.07) {
        g.fillStyle = h < 0.035 ? 'rgba(34,211,238,0.55)' : 'rgba(255,190,90,0.5)';
        g.fillRect(px + 6, py + 12, TILE - 12, 6);
        g.fillStyle = 'rgba(255,255,255,0.35)';
        g.fillRect(px + 6, py + 12, TILE - 12, 1.5);
      } else if (h < 0.14) {
        g.fillStyle = 'rgba(0,0,0,0.3)';
        for (let i = 0; i < 4; i++) g.fillRect(px + 7, py + 8 + i * 5, TILE - 14, 2);
      }
    }
    if (left) { g.fillStyle = '#19203f'; g.fillRect(px, py, 3, TILE); g.fillStyle = 'rgba(120,140,220,0.25)'; g.fillRect(px + 3, py, 1, TILE); }
    if (right) { g.fillStyle = '#19203f'; g.fillRect(px + TILE - 3, py, 3, TILE); }
    if (down) {
      g.fillStyle = '#121833';
      g.fillRect(px, py + TILE - 5, TILE, 5);
      // Hazard stripes on undersides.
      g.fillStyle = 'rgba(255,200,60,0.18)';
      for (let i = -8; i < TILE; i += 10) { g.beginPath(); g.moveTo(px + i, py + TILE); g.lineTo(px + i + 5, py + TILE - 5); g.lineTo(px + i + 10, py + TILE - 5); g.lineTo(px + i + 5, py + TILE); g.fill(); }
    }
    if (up) {
      // Walkable top: steel lip with a neon edge and a glow that spills onto the wall below.
      g.fillStyle = '#5b6b9a';
      g.fillRect(px, py, TILE, 6);
      const glow = g.createLinearGradient(0, py + 6, 0, py + 16);
      glow.addColorStop(0, 'rgba(34,211,238,0.22)');
      glow.addColorStop(1, 'rgba(34,211,238,0)');
      g.fillStyle = glow;
      g.fillRect(px, py + 6, TILE, 10);
      g.fillStyle = '#7ff0ff';
      g.fillRect(px, py, TILE, 2);
      g.fillStyle = '#0b1020';
      g.beginPath();
      g.arc(px + 7, py + 11, 1.6, 0, Math.PI * 2);
      g.arc(px + TILE - 7, py + 11, 1.6, 0, Math.PI * 2);
      g.fill();
    }
  } else if (code === T_ONEWAY) {
    // See-through mesh catwalk: a bright top rail, a lattice you can see (and shoot) through,
    // and a thin lower rail. Visibly different from solid walls.
    g.fillStyle = '#8d9ad0';
    g.fillRect(px, py, TILE, 4);
    g.fillStyle = '#ffd54a';
    g.fillRect(px, py, TILE, 1.5);
    g.strokeStyle = 'rgba(141,154,208,0.55)';
    g.lineWidth = 1.2;
    g.beginPath();
    for (let i = 0; i < TILE; i += 8) {
      g.moveTo(px + i, py + 4);
      g.lineTo(px + i + 8, py + 13);
      g.moveTo(px + i + 8, py + 4);
      g.lineTo(px + i, py + 13);
    }
    g.stroke();
    g.fillStyle = 'rgba(141,154,208,0.7)';
    g.fillRect(px, py + 13, TILE, 2);
    // Support struts every few tiles.
    if (tx % 4 === 0) { g.fillStyle = 'rgba(91,107,154,0.35)'; g.fillRect(px + 14, py + 15, 4, 10); }
  } else if (code !== T_ACID && tileAt(map, tx, ty - 1) === T_ONEWAY && tx % 6 === 0) {
    // Background girder under platforms.
    g.strokeStyle = 'rgba(91,107,154,0.16)';
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

/**
 * Three backdrop textures: far skyline, mid pipes/girders, near fog band.
 * Everything is generated once at load and tiles horizontally (offsets wrap at W). The art is
 * deliberately layered: a deep sky with a moon and lit towers, a mid band of pipes/trusses and
 * hanging lamps, then a soft acid-glow fog with a foreground railing. Kept in code so there is
 * no image download and the palette can follow the map.
 */
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
  /** Draw at x, and again shifted by -W when the shape crosses the right edge (seamless tile). */
  const wrapped = (x: number, w: number, draw: (ox: number) => void) => {
    draw(x);
    if (x + w > W) draw(x - W);
    if (x < 0) draw(x + W);
  };
  /** A soft radial bloom, used for the moon, lamps and acid haze. */
  const glow = (g: CanvasRenderingContext2D, x: number, y: number, r: number, inner: string, outer: string) => {
    const rad = g.createRadialGradient(x, y, 0, x, y, r);
    rad.addColorStop(0, inner);
    rad.addColorStop(1, outer);
    g.fillStyle = rad;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  };

  const far = mk((g) => {
    // Sky: near-black overhead, indigo toward the horizon.
    const sky = g.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#05070f');
    sky.addColorStop(0.55, '#0a1024');
    sky.addColorStop(1, '#202748');
    g.fillStyle = sky;
    g.fillRect(0, 0, W, H);

    // Faint nebulae, duplicated so the wrap is invisible.
    for (const [x, y, r, a] of [[180, 120, 190, 0.1], [700, 80, 230, 0.08], [960, 220, 160, 0.07]] as const) {
      wrapped(x, r, (ox) => glow(g, ox, y, r, `rgba(70,110,255,${a})`, 'rgba(70,110,255,0)'));
    }

    // Stars with a few brighter ones (deterministic positions/alpha).
    for (let i = 0; i < 110; i++) {
      const x = rnd() * W;
      const y = rnd() * H * 0.62;
      const s = rnd() < 0.12 ? 2.2 : 1.1;
      g.fillStyle = `rgba(226,235,255,${0.15 + rnd() * 0.65})`;
      g.fillRect(x, y, s, s);
      if (s > 2) {
        g.fillStyle = 'rgba(170,210,255,0.25)';
        g.fillRect(x - 2, y + 0.5, 6, 0.8);
        g.fillRect(x + 0.5, y - 2, 0.8, 6);
      }
    }

    // Moon with a soft halo and a shadowed limb (single object, so no wrap needed).
    glow(g, 812, 118, 96, 'rgba(170,200,255,0.20)', 'rgba(170,200,255,0)');
    const moon = g.createRadialGradient(796, 102, 6, 812, 118, 46);
    moon.addColorStop(0, '#e8efff');
    moon.addColorStop(0.65, '#b9c8ea');
    moon.addColorStop(1, '#7986b4');
    g.fillStyle = moon;
    g.beginPath();
    g.arc(812, 118, 42, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = 'rgba(7,10,22,0.35)';
    g.beginPath();
    g.arc(826, 108, 38, 0, Math.PI * 2);
    g.fill();

    // Two distant rig layers (dark, then slightly lighter with lit windows).
    const skyline = (base: number, color: string, minH: number, maxH: number, step: number, lit: number) => {
      for (let x = -40; x < W + 40; x += step + rnd() * 34) {
        const w = 26 + rnd() * 46;
        const h = minH + rnd() * (maxH - minH);
        const top = base - h;
        wrapped(x, w, (ox) => {
          g.fillStyle = color;
          g.fillRect(ox, top, w, h);
          // Roof structure and antenna.
          g.fillRect(ox - 4, top, w + 8, 5);
          g.fillRect(ox + w * 0.5 - 1.5, top - 26 - rnd() * 34, 3, 30);
          // Lit windows: a sparse grid.
          g.fillStyle = `rgba(255,205,120,${lit})`;
          for (let wy = top + 12; wy < base - 8; wy += 14) {
            for (let wx = ox + 6; wx < ox + w - 6; wx += 11) if (rnd() < 0.22) g.fillRect(wx, wy, 3, 4);
          }
          // Red aircraft beacon.
          g.fillStyle = 'rgba(255,82,92,0.9)';
          g.fillRect(ox + w * 0.5 - 2, top - 30 - rnd() * 32, 4, 4);
        });
      }
    };
    skyline(H - 30, '#0e1328', 90, 210, 78, 0.28);
    skyline(H - 10, '#161c36', 40, 130, 96, 0.45);

    // Horizon haze.
    const haze = g.createLinearGradient(0, H - 90, 0, H);
    haze.addColorStop(0, 'rgba(90,120,220,0)');
    haze.addColorStop(1, 'rgba(120,160,255,0.12)');
    g.fillStyle = haze;
    g.fillRect(0, H - 90, W, 90);
  });

  const mid = mk((g) => {
    g.lineCap = 'round';
    // Horizontal girders.
    for (let i = 0; i < 4; i++) {
      const y = 96 + i * 104;
      g.fillStyle = i % 2 ? 'rgba(34,42,70,0.62)' : 'rgba(42,52,84,0.7)';
      g.fillRect(0, y, W, i % 2 ? 7 : 10);
      g.fillStyle = 'rgba(90,110,170,0.18)';
      g.fillRect(0, y, W, 2);
      // Rivet line.
      g.fillStyle = 'rgba(10,14,28,0.5)';
      for (let x = 0; x < W; x += 24) g.fillRect(x, y + 4, 3, 2);
    }

    // Vertical columns with crossed bracing. Columns at fixed boundaries tile exactly.
    for (let x = 0; x <= W; x += 256) {
      g.fillStyle = 'rgba(30,38,66,0.8)';
      g.fillRect(x - 7, 60, 14, H - 60);
      g.fillStyle = 'rgba(90,110,170,0.16)';
      g.fillRect(x - 7, 60, 3, H - 60);
      g.strokeStyle = 'rgba(52,66,108,0.55)';
      g.lineWidth = 5;
      for (let y = 104; y < H - 40; y += 128) {
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x + 256, y + 128);
        g.moveTo(x + 256, y);
        g.lineTo(x, y + 128);
        g.stroke();
      }
    }

    // Pipes with flange rings, plus a warning-striped service pipe.
    const pipe = (y: number, thick: number, color: string) => {
      g.strokeStyle = color;
      g.lineWidth = thick;
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(W, y);
      g.stroke();
      g.fillStyle = 'rgba(12,17,34,0.55)';
      for (let x = 30; x < W; x += 96) g.fillRect(x, y - thick / 2 - 2, 7, thick + 4);
      g.fillStyle = 'rgba(140,170,230,0.18)';
      g.fillRect(0, y - thick / 2, W, 1.5);
    };
    pipe(150, 12, 'rgba(38,48,80,0.75)');
    pipe(330, 18, 'rgba(34,44,74,0.8)');
    pipe(438, 9, 'rgba(44,56,92,0.7)');

    // A cable span with hanging work lamps; ends sit on the columns so the tile is seamless.
    for (let x = 0; x < W; x += 256) {
      const sag = 42;
      g.strokeStyle = 'rgba(18,24,44,0.85)';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(x, 168);
      g.quadraticCurveTo(x + 128, 168 + sag * 2, x + 256, 168);
      g.stroke();
      for (const t of [0.28, 0.5, 0.72]) {
        const lx = x + 256 * t;
        const ly = 168 + sag * 2 * (2 * t * (1 - t));
        g.strokeStyle = 'rgba(18,24,44,0.85)';
        g.beginPath();
        g.moveTo(lx, ly);
        g.lineTo(lx, ly + 16);
        g.stroke();
        glow(g, lx, ly + 22, 34, 'rgba(255,196,110,0.28)', 'rgba(255,196,110,0)');
        g.fillStyle = '#ffd28a';
        g.beginPath();
        g.arc(lx, ly + 18, 3.2, 0, Math.PI * 2);
        g.fill();
      }
    }

    // Warning chevrons on the lowest service pipe.
    g.fillStyle = 'rgba(255,196,90,0.35)';
    for (let x = 0; x < W; x += 48) {
      g.beginPath();
      g.moveTo(x, 449);
      g.lineTo(x + 11, 449);
      g.lineTo(x + 18, 455);
      g.lineTo(x + 11, 461);
      g.lineTo(x, 461);
      g.lineTo(x + 7, 455);
      g.closePath();
      g.fill();
    }

    // Sparse hanging cables, drawn full-width so they tile.
    g.strokeStyle = 'rgba(14,20,38,0.6)';
    g.lineWidth = 1.5;
    for (const y of [58, 76, 94]) {
      g.beginPath();
      g.moveTo(0, y);
      g.bezierCurveTo(W * 0.3, y + 16, W * 0.7, y - 12, W, y);
      g.stroke();
    }
  });

  const near = mk((g) => {
    // Fog: cyan at the top, acid green near the floor.
    const fog = g.createLinearGradient(0, 0, 0, H);
    fog.addColorStop(0, 'rgba(90,120,220,0)');
    fog.addColorStop(0.68, 'rgba(90,150,220,0.05)');
    fog.addColorStop(0.9, 'rgba(90,220,190,0.10)');
    fog.addColorStop(1, 'rgba(124,255,79,0.18)');
    g.fillStyle = fog;
    g.fillRect(0, 0, W, H);

    // Drifting dust motes for depth.
    for (let i = 0; i < 46; i++) {
      const x = rnd() * W;
      const y = H * 0.45 + rnd() * H * 0.5;
      const r = 0.6 + rnd() * 1.5;
      g.fillStyle = `rgba(180,240,230,${0.05 + rnd() * 0.1})`;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    }

    // Foreground railing: dark posts with a lit top rail, seamless at the tile boundary.
    g.fillStyle = 'rgba(5,9,20,0.55)';
    g.fillRect(0, H - 74, W, 74);
    g.fillStyle = 'rgba(120,150,220,0.10)';
    g.fillRect(0, H - 74, W, 2);
    for (let x = 0; x <= W; x += 64) {
      g.fillStyle = 'rgba(5,9,20,0.7)';
      g.fillRect(x - 2, H - 74, 4, 56);
      g.fillStyle = 'rgba(140,170,230,0.10)';
      g.fillRect(x - 2, H - 74, 1.5, 56);
    }
    g.fillStyle = 'rgba(5,9,20,0.75)';
    g.fillRect(0, H - 20, W, 20);
  });

  return [far, mid, near];
}
