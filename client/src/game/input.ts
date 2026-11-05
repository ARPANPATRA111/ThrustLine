// Player input from keyboard + mouse and from the touch twin-sticks, merged into one
// ActorInput per frame. "Pressed" flags are edges: they are true for one simulation step.
import type { ActorInput } from './actor';

export class Input {
  private keys = new Set<string>();
  private mouseDown = false;
  private edges = { fire: false, melee: false, grenade: false, swap: false, reload: false };
  /** Mouse position in CSS pixels. */
  mouseX = 0;
  mouseY = 0;
  usingTouch = false;
  enabled = false;
  onScoreboard: (show: boolean) => void = () => {};
  onMenu: () => void = () => {};
  onDebug: () => void = () => {};
  /** Q: open/close the emote picker (also reachable by touch). */
  onEmote: () => void = () => {};
  /** Number keys send a sticker straight away, without opening the picker. */
  onQuickEmote: (slot: number) => void = () => {};

  // Written by the touch controls.
  touch = { moveX: 0, thrust: false, thrustAmount: 1, down: false, aim: null as number | null, fire: false };

  constructor() {
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('blur', () => { this.keys.clear(); this.mouseDown = false; });
    window.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'mouse') { this.mouseX = e.clientX; this.mouseY = e.clientY; }
    });
    // Mouse buttons are read at window level so the HUD layers never swallow clicks;
    // clicks on buttons, inputs and overlays are ignored.
    window.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse' || !this.enabled) return;
      if ((e.target as HTMLElement).closest('button, input, select, .overlay, .mini-board')) return;
      this.usingTouch = false;
      if (e.button === 0) { this.mouseDown = true; this.edges.fire = true; }
      if (e.button === 2) this.edges.melee = true;
    });
    window.addEventListener('pointerup', (e) => { if (e.pointerType === 'mouse' && e.button === 0) this.mouseDown = false; });
    window.addEventListener('contextmenu', (e) => { if (this.enabled) e.preventDefault(); });
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    const k = e.code;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (k === 'Tab') { e.preventDefault(); if (this.enabled) this.onScoreboard(down); return; }
    if (k === 'F3' && down) { e.preventDefault(); this.onDebug(); return; }
    if (k === 'Escape' && down) { if (this.enabled) this.onMenu(); return; }
    if (k === 'KeyQ' && down && !e.repeat) { if (this.enabled) this.onEmote(); return; }
    const digit = /^Digit([1-4])$/.exec(k);
    if (digit && down && !e.repeat) { if (this.enabled) this.onQuickEmote(Number(digit[1]) - 1); return; }
    if (!this.enabled) return;
    if (k === 'Space') e.preventDefault();
    if (down && !this.keys.has(k)) {
      if (k === 'KeyE') this.edges.fire = true;
      if (k === 'KeyR') this.edges.melee = true;
      if (k === 'KeyG') this.edges.grenade = true;
      if (k === 'KeyF') this.edges.swap = true;
      if (k === 'KeyT') this.edges.reload = true;
    }
    if (down) this.keys.add(k);
    else this.keys.delete(k);
  }

  /** Touch buttons call this for one-shot actions. */
  press(action: 'melee' | 'grenade' | 'swap' | 'reload'): void {
    this.edges[action] = true;
  }

  /**
   * Fill `out` for this frame. `aimFromMouse` converts the mouse position to an aim angle.
   * Edge flags are cleared afterwards so each press triggers exactly once.
   */
  read(out: ActorInput, aimFromMouse: (sx: number, sy: number) => number, currentAim: number): void {
    const k = this.keys;
    let moveX = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    let thrust = k.has('KeyW') || k.has('Space') || k.has('ArrowUp');
    let thrustAmount = 1; // keyboard: full power
    let down = k.has('KeyS') || k.has('ArrowDown');
    let fire = this.mouseDown || k.has('KeyE');
    let firePressed = this.edges.fire;
    let aim = this.usingTouch ? currentAim : aimFromMouse(this.mouseX, this.mouseY);
    if (this.usingTouch) {
      const t = this.touch;
      if (t.moveX !== 0) moveX = t.moveX;
      if (t.thrust && !thrust) thrustAmount = t.thrustAmount; // touch: analog power
      thrust = thrust || t.thrust;
      down = down || t.down;
      if (t.aim !== null) aim = t.aim;
      // On touch, holding the aim stick out keeps firing, including semi-auto weapons.
      fire = fire || t.fire;
      firePressed = firePressed || t.fire;
    }
    out.moveX = moveX;
    out.thrust = thrust;
    out.thrustAmount = thrustAmount;
    out.down = down;
    out.aim = aim;
    out.fire = fire;
    out.firePressed = firePressed;
    out.melee = this.edges.melee;
    out.grenade = this.edges.grenade;
    out.swap = this.edges.swap;
    out.reload = this.edges.reload;
  }

  clearEdges(): void {
    this.edges.fire = this.edges.melee = this.edges.grenade = this.edges.swap = this.edges.reload = false;
  }

  reset(): void {
    this.keys.clear();
    this.mouseDown = false;
    this.clearEdges();
    this.touch.moveX = 0;
    this.touch.thrust = this.touch.down = this.touch.fire = false;
    this.touch.aim = null;
  }
}
