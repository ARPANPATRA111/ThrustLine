// Camera: follows the local player with a 0.12 lerp, leads toward the aim (320 px with the
// sniper), shakes briefly on firing and explosions, and never shows outside the map.
import { CAMERA_LEAD, CAMERA_LEAD_SNIPER, CAMERA_LERP, VIEW_HEIGHT, VIEW_HEIGHT_MIN, VIEW_MAX_WIDTH } from '@shared/config';
import { MAP_H, MAP_W } from '@shared/map';

export class Camera {
  /** Centre of the view in world px. */
  x = MAP_W / 2;
  y = MAP_H / 2;
  /** Size of the view in world px. */
  viewW = 1200;
  viewH = VIEW_HEIGHT;
  /** Screen px per world px. */
  zoom = 1;
  private shakeAmt = 0;
  shakeX = 0;
  shakeY = 0;

  /**
   * View size: about 680 world px tall on laptops, zooming in on short phone screens so soldiers
   * stay big enough to see and hit (420 px tall on a ~390 px phone). Width follows the aspect
   * ratio, capped at 1500.
   */
  resize(screenW: number, screenH: number): void {
    const aspect = screenW / Math.max(1, screenH);
    const viewHeight = Math.min(VIEW_HEIGHT, Math.max(VIEW_HEIGHT_MIN, screenH * 1.08));
    this.viewW = Math.min(viewHeight * aspect, VIEW_MAX_WIDTH);
    this.zoom = screenW / this.viewW;
    this.viewH = screenH / this.zoom;
  }

  follow(tx: number, ty: number, aim: number, sniper: boolean, dt: number, snap = false): void {
    const lead = sniper ? CAMERA_LEAD_SNIPER : CAMERA_LEAD;
    const gx = tx + Math.cos(aim) * lead;
    const gy = ty + Math.sin(aim) * lead * 0.6;
    // Frame-rate independent version of "move 12% of the way each 60 Hz frame".
    const k = snap ? 1 : 1 - Math.pow(1 - CAMERA_LERP, dt * 60);
    this.x += (gx - this.x) * k;
    this.y += (gy - this.y) * k;
    this.clamp();
    // Shake decays fast.
    this.shakeAmt *= Math.pow(0.0005, dt);
    this.shakeX = (Math.random() * 2 - 1) * this.shakeAmt;
    this.shakeY = (Math.random() * 2 - 1) * this.shakeAmt;
  }

  clamp(): void {
    const hw = this.viewW / 2;
    const hh = this.viewH / 2;
    this.x = MAP_W <= this.viewW ? MAP_W / 2 : Math.min(Math.max(this.x, hw), MAP_W - hw);
    this.y = MAP_H <= this.viewH ? MAP_H / 2 : Math.min(Math.max(this.y, hh), MAP_H - hh);
  }

  shake(amount: number): void {
    this.shakeAmt = Math.min(18, Math.max(this.shakeAmt, amount));
  }

  get left(): number { return this.x - this.viewW / 2; }
  get top(): number { return this.y - this.viewH / 2; }
  get right(): number { return this.x + this.viewW / 2; }
  get bottom(): number { return this.y + this.viewH / 2; }

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: this.left + sx / this.zoom, y: this.top + sy / this.zoom };
  }
}
