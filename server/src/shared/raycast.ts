// Ray casting for hitscan weapons and line-of-sight checks.
// 1) castTiles: DDA ("digital differential analyzer") walk through the tile grid.
// 2) rayVsBox: the slab test for a ray against an axis-aligned box.
import { TILE } from './config';
import { type GameMap, T_SOLID, tileAt } from './map';

/**
 * Walk the grid cell by cell along the ray and return the distance to the first SOLID tile,
 * or `maxDist` if nothing is hit. One-way platforms and acid don't stop bullets.
 *
 * DDA idea: from the start cell, compute how far along the ray we must travel to cross the
 * next vertical grid line (tMaxX) and the next horizontal grid line (tMaxY). Repeatedly step
 * into whichever is closer; tDeltaX/tDeltaY is the ray distance between successive lines.
 * (dx, dy) must be a unit vector.
 */
export function castTiles(map: GameMap, x0: number, y0: number, dx: number, dy: number, maxDist: number): number {
  let tx = Math.floor(x0 / TILE);
  let ty = Math.floor(y0 / TILE);
  if (tileAt(map, tx, ty) === T_SOLID) return 0;

  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;
  const tDeltaX = dx !== 0 ? Math.abs(TILE / dx) : Infinity;
  const tDeltaY = dy !== 0 ? Math.abs(TILE / dy) : Infinity;
  // Distance to the first vertical / horizontal grid line.
  let tMaxX = dx !== 0 ? ((dx > 0 ? (tx + 1) * TILE - x0 : x0 - tx * TILE) / Math.abs(dx)) : Infinity;
  let tMaxY = dy !== 0 ? ((dy > 0 ? (ty + 1) * TILE - y0 : y0 - ty * TILE) / Math.abs(dy)) : Infinity;

  for (;;) {
    let t: number;
    if (tMaxX < tMaxY) {
      t = tMaxX;
      tMaxX += tDeltaX;
      tx += stepX;
    } else {
      t = tMaxY;
      tMaxY += tDeltaY;
      ty += stepY;
    }
    if (t >= maxDist) return maxDist;
    if (tileAt(map, tx, ty) === T_SOLID) return t;
  }
}

/** True if nothing solid lies on the straight line between two points. */
export function lineOfSight(map: GameMap, x0: number, y0: number, x1: number, y1: number): boolean {
  const ddx = x1 - x0;
  const ddy = y1 - y0;
  const len = Math.sqrt(ddx * ddx + ddy * ddy);
  if (len < 1e-6) return true;
  return castTiles(map, x0, y0, ddx / len, ddy / len, len) >= len;
}

/**
 * Slab test: a box is the overlap of an x-slab [minX,maxX] and a y-slab [minY,maxY].
 * For each slab compute the ray distances where it enters and leaves; the ray hits the box
 * if the latest entry is before the earliest exit. Returns the entry distance, or -1 on a miss.
 */
export function rayVsBox(
  x0: number,
  y0: number,
  dx: number,
  dy: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  maxDist: number,
): number {
  let tNear = 0;
  let tFar = maxDist;
  if (Math.abs(dx) < 1e-9) {
    if (x0 < minX || x0 > maxX) return -1;
  } else {
    let t1 = (minX - x0) / dx;
    let t2 = (maxX - x0) / dx;
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
    if (t1 > tNear) tNear = t1;
    if (t2 < tFar) tFar = t2;
    if (tNear > tFar) return -1;
  }
  if (Math.abs(dy) < 1e-9) {
    if (y0 < minY || y0 > maxY) return -1;
  } else {
    let t1 = (minY - y0) / dy;
    let t2 = (maxY - y0) / dy;
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
    if (t1 > tNear) tNear = t1;
    if (t2 < tFar) tFar = t2;
    if (tNear > tFar) return -1;
  }
  return tNear;
}

/** Shortest distance from point (px,py) to the ray starting at (x0,y0) with unit direction (dx,dy). */
export function pointToRayDistance(x0: number, y0: number, dx: number, dy: number, px: number, py: number): number {
  const wx = px - x0;
  const wy = py - y0;
  const along = wx * dx + wy * dy;
  if (along <= 0) return Math.sqrt(wx * wx + wy * wy); // point is behind the shooter
  const cx = wx - along * dx;
  const cy = wy - along * dy;
  return Math.sqrt(cx * cx + cy * cy);
}
