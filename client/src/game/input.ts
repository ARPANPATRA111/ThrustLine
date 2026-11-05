// Player input from keyboard + mouse and from the touch twin-sticks, merged into one
// ActorInput per frame. "Pressed" flags are edges: they are true for one simulation step.
import type { ActorInput } from './actor';

export type Action = 'left' | 'right' | 'jet' | 'down' | 'fire' | 'melee' | 'grenade' | 'swap' | 'reload' | 'emote';

/** The actions a player can rebind, in the order the settings panel lists them. */
export const ACTIONS: { id: Action; label: string }[] = [
  { id: 'left', label: 'Move left' },
  { id: 'right', label: 'Move right' },
  { id: 'jet', label: 'Jetpack' },
  { id: 'down', label: 'Drop through' },
  { id: 'fire', label: 'Fire' },
  { id: 'melee', label: 'Knife' },
  { id: 'grenade', label: 'Grenade' },
  { id: 'swap', label: 'Swap weapon' },
  { id: 'reload', label: 'Reload' },
  { id: 'emote', label: 'Emote' },
];

export const DEFAULT_KEYS: Record<Action, string> = {
  left: 'KeyA', right: 'KeyD', jet: 'KeyW', down: 'KeyS', fire: 'KeyE', melee: 'KeyR', grenade: 'KeyG', swap: 'KeyF', reload: 'KeyT', emote: 'KeyQ',
};

/** Short text for a key code ("KeyW" -> "W"). */
export function keyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  const names: Record<string, string> = {
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', ShiftLeft: 'Shift', ShiftRight: 'Shift',
    ControlLeft: 'Ctrl', ControlRight: 'Ctrl', AltLeft: 'Alt', AltRight: 'Alt',
  };
  return names[code] ?? code;
}

// Standard gamepad layout.
const PAD_LT = 6, PAD_RT = 7, PAD_LB = 4, PAD_RB = 5, PAD_A = 0, PAD_B = 1, PAD_X = 2, PAD_Y = 3;
const PAD_DEADZONE = 0.22;

export class Input {
  /** Current key for each action. */
  binds: Record<Action, string> = { ...DEFAULT_KEYS };
  /** While set, the next key press goes to the settings panel instead of the game. */
  private capture: ((code: string) => void) | null = null;
  private padAim: number | null = null;
  private padWas: boolean[] = [];
  /** True once a gamepad has been used; it aims with the right stick. */
  usingPad = false;
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
      if (e.pointerType === 'mouse') {
        this.mouseX = e.clientX;
        this.mouseY = e.clientY;
        this.padAim = null; // touching the mouse hands aiming back to it
      }
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

  /** Hand the next key press to `done`; null means the player cancelled with Escape. */
  captureKey(done: (code: string | null) => void): void {
    this.capture = (code) => {
      this.capture = null;
      done(code === 'Escape' || code === 'Tab' || code === 'F3' ? null : code);
    };
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    const k = e.code;
    if (this.capture) {
      if (down) {
        e.preventDefault();
        this.capture(k);
      }
      return;
    }
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (k === 'Tab') { e.preventDefault(); if (this.enabled) this.onScoreboard(down); return; }
    if (k === 'F3' && down) { e.preventDefault(); this.onDebug(); return; }
    if (k === 'Escape' && down) { if (this.enabled) this.onMenu(); return; }
    const b = this.binds;
    if (k === b.emote && down && !e.repeat) { if (this.enabled) this.onEmote(); return; }
    const digit = /^Digit([1-4])$/.exec(k);
    if (digit && down && !e.repeat) { if (this.enabled) this.onQuickEmote(Number(digit[1]) - 1); return; }
    if (!this.enabled) return;
    if (k === 'Space') e.preventDefault();
    if (down && !this.keys.has(k)) {
      if (k === b.fire) this.edges.fire = true;
      if (k === b.melee) this.edges.melee = true;
      if (k === b.grenade) this.edges.grenade = true;
      if (k === b.swap) this.edges.swap = true;
      if (k === b.reload) this.edges.reload = true;
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
    const b = this.binds;
    let moveX = (k.has(b.right) || k.has('ArrowRight') ? 1 : 0) - (k.has(b.left) || k.has('ArrowLeft') ? 1 : 0);
    let thrust = k.has(b.jet) || k.has('Space') || k.has('ArrowUp');
    let thrustAmount = 1; // keyboard: full power
    let down = k.has(b.down) || k.has('ArrowDown');
    let fire = this.mouseDown || k.has(b.fire);
    let firePressed = this.edges.fire;
    let aim = this.usingTouch ? currentAim : aimFromMouse(this.mouseX, this.mouseY);
    const pad = this.readPad();
    if (pad) {
      if (pad.moveX !== 0) moveX = pad.moveX;
      thrust = thrust || pad.thrust;
      down = down || pad.down;
      fire = fire || pad.fire;
      firePressed = firePressed || pad.firePressed;
      if (this.padAim !== null) aim = this.padAim;
    }
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

  /** Poll the first connected gamepad; one-shot buttons feed the same edges as the keyboard. */
  private readPad(): { moveX: number; thrust: boolean; down: boolean; fire: boolean; firePressed: boolean } | null {
    const pad = navigator.getGamepads?.().find((p) => p && p.connected) ?? null;
    if (!pad) return null;
    const held = pad.buttons.map((button) => button.pressed || button.value > 0.5);
    const pressed = (i: number) => !!held[i] && !this.padWas[i];
    const lx = pad.axes[0] ?? 0;
    const ly = pad.axes[1] ?? 0;
    const rx = pad.axes[2] ?? 0;
    const ry = pad.axes[3] ?? 0;
    if (Math.hypot(rx, ry) > 0.35) this.padAim = Math.atan2(ry, rx);
    if (held.some(Boolean) || Math.hypot(lx, ly) > PAD_DEADZONE || this.padAim !== null) this.usingPad = true;
    if (pressed(PAD_LT)) this.edges.melee = true;
    if (pressed(PAD_RB)) this.edges.grenade = true;
    if (pressed(PAD_X)) this.edges.reload = true;
    if (pressed(PAD_Y)) this.edges.swap = true;
    if (pressed(PAD_B) && this.enabled) this.onEmote();
    const firePressed = pressed(PAD_RT);
    this.padWas = held;
    return {
      moveX: Math.abs(lx) > PAD_DEADZONE ? lx : 0,
      thrust: !!held[PAD_A] || !!held[PAD_LB] || ly < -0.5,
      down: ly > 0.75,
      fire: !!held[PAD_RT],
      firePressed,
    };
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
