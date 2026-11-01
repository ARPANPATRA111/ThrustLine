// RIG-7: the single v1 map, stored as ASCII art and parsed once at load.
// # solid   = one-way platform   ~ acid   . empty
// S spawn   H health pack        A ammo crate   G grenade crate
import { TILE } from './config';

export const RIG7_ROWS: readonly string[] = [
  '################################################################################################',
  '#..............................................................................................#',
  '#..............................................................................................#',
  '#..............................................................................................#',
  '#..............................................................................................#',
  '#.......................................G..............G.......................................#',
  '#...................................========================...................................#',
  '#..............................................................................................#',
  '#...................S......................................................S...................#',
  '#.............=================..................................=================.............#',
  '#..............................................................................................#',
  '#..............................................................................................#',
  '#..............................................................................................#',
  '#..............................................................................................#',
  '#....========......................................................................========....#',
  '#..............................................................................................#',
  '#..............................................................................................#',
  '#.............................####........H..........H........####.............................#',
  '#.............................####......======####======......####.............................#',
  '#...S.........................................####.........................................S...#',
  '#=========....................................####....................................=========#',
  '#.............................................####.............................................#',
  '#.............................................####.............................................#',
  '#..................==========.................####.................==========..................#',
  '#.............................................####.............................................#',
  '#..............................................................................................#',
  '#..............................................................................................#',
  '#......S................................................................................S......#',
  '#############......................................................................#############',
  '#..............==========..............................................==========..............#',
  '#...........................................A......A...........................................#',
  '#........................................==============........................................#',
  '#..............................................................................................#',
  '#...................##....................................................##...................#',
  '#...................##..........##............................##..........##...................#',
  '#...S....A..........##..........##............................##..........##..........A....S...#',
  '########################################~~~~~~~~~~~~~~~~########################################',
  '########################################~~~~~~~~~~~~~~~~########################################',
  '################################################################################################',
  '################################################################################################',
];

export const MAP_COLS = 96;
export const MAP_ROWS = 40;
export const MAP_W = MAP_COLS * TILE;
export const MAP_H = MAP_ROWS * TILE;

// Tile codes stored in the grid. Markers (S/H/A/G) become EMPTY tiles.
export const T_EMPTY = 0;
export const T_SOLID = 1;
export const T_ONEWAY = 2;
export const T_ACID = 3;

export const PICKUP_HEALTH = 0;
export const PICKUP_AMMO = 1;
export const PICKUP_GRENADE = 2;

export interface TilePos {
  tx: number;
  ty: number;
}
export interface PickupMarker extends TilePos {
  kind: number;
}

export interface GameMap {
  cols: number;
  rows: number;
  /** Row-major tile codes: tiles[ty * cols + tx]. */
  tiles: Uint8Array;
  spawns: TilePos[];
  pickups: PickupMarker[];
}

/** Parse ASCII rows into a GameMap. Throws if any row has the wrong width or an unknown char. */
export function parseMap(rows: readonly string[], cols = MAP_COLS): GameMap {
  const tiles = new Uint8Array(cols * rows.length);
  const spawns: TilePos[] = [];
  const pickups: PickupMarker[] = [];
  rows.forEach((row, ty) => {
    if (row.length !== cols) {
      throw new Error(`Map row ${ty} has ${row.length} chars, expected ${cols}`);
    }
    for (let tx = 0; tx < cols; tx++) {
      const ch = row[tx];
      let code = T_EMPTY;
      switch (ch) {
        case '#': code = T_SOLID; break;
        case '=': code = T_ONEWAY; break;
        case '~': code = T_ACID; break;
        case '.': break;
        case 'S': spawns.push({ tx, ty }); break;
        case 'H': pickups.push({ tx, ty, kind: PICKUP_HEALTH }); break;
        case 'A': pickups.push({ tx, ty, kind: PICKUP_AMMO }); break;
        case 'G': pickups.push({ tx, ty, kind: PICKUP_GRENADE }); break;
        default: throw new Error(`Unknown map char '${ch}' at ${tx},${ty}`);
      }
      tiles[ty * cols + tx] = code;
    }
  });
  return { cols, rows: rows.length, tiles, spawns, pickups };
}

/** The parsed RIG-7 map, shared by server and client. */
export const RIG7: GameMap = parseMap(RIG7_ROWS);

/** Tile code at tile coordinates. Everything outside the map counts as solid. */
export function tileAt(map: GameMap, tx: number, ty: number): number {
  if (tx < 0 || ty < 0 || tx >= map.cols || ty >= map.rows) return T_SOLID;
  return map.tiles[ty * map.cols + tx];
}

export function isSolidTile(map: GameMap, tx: number, ty: number): boolean {
  return tileAt(map, tx, ty) === T_SOLID;
}

/** Tile code at a world-space point. */
export function tileAtPoint(map: GameMap, x: number, y: number): number {
  return tileAt(map, Math.floor(x / TILE), Math.floor(y / TILE));
}

/**
 * Does the box [left,right) x [top,bottom) touch any tile of the given code?
 * Edges are exclusive, so a box resting exactly on a tile's top edge does not overlap it.
 */
export function boxTouchesTile(
  map: GameMap,
  left: number,
  top: number,
  right: number,
  bottom: number,
  code: number,
): boolean {
  const tx0 = Math.floor(left / TILE);
  const tx1 = Math.floor((right - 1e-6) / TILE);
  const ty0 = Math.floor(top / TILE);
  const ty1 = Math.floor((bottom - 1e-6) / TILE);
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      if (tileAt(map, tx, ty) === code) return true;
    }
  }
  return false;
}

/** World position (feet centre) of a spawn tile: the player stands on the tile below. */
export function spawnWorldPos(s: TilePos): { x: number; y: number } {
  return { x: (s.tx + 0.5) * TILE, y: (s.ty + 1) * TILE };
}
