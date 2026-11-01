// Twin-stick touch controls with Pointer Events (each finger tracked by pointerId).
// Both sticks rest at visible "home" positions in the bottom corners. A thumb that lands
// anywhere in that half of the screen pulls the stick to it (floating stick), and it returns
// home on release.
//   Left stick: horizontal = run, push up = jetpack, pull firmly straight down = drop through.
//   Right stick: direction aims, push past ~55% = fire (automatic weapons keep firing).
// Action buttons sit on an arc around the aim stick and only show when the mode uses them.
import type { Input } from '../game/input';

/** Thumb travel (px) that counts as a full push. */
const RADIUS = 56;

interface Stick {
  id: number;
  ox: number;
  oy: number;
  el: HTMLElement;
  knob: HTMLElement;
}

export interface ButtonSet {
  reload: boolean;
  swap: boolean;
  grenade: boolean;
  melee: boolean;
}

export class TouchControls {
  private move: Stick | null = null;
  private aim: Stick | null = null;
  private elL: HTMLElement;
  private elR: HTMLElement;
  private buttons = new Map<string, HTMLButtonElement>();
  private shown = '';
  lefty = false;

  constructor(private root: HTMLElement, private input: Input) {
    this.elL = root.querySelector<HTMLElement>('#stick-l')!;
    this.elR = root.querySelector<HTMLElement>('#stick-r')!;
    root.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' || (e.target as HTMLElement).closest('.tbtn')) return;
      e.preventDefault();
      this.enableTouchMode();
      const half = e.clientX < window.innerWidth / 2;
      const moveSide = this.lefty ? !half : half;
      if (moveSide && !this.move) this.move = this.begin(e, this.elL);
      else if (!moveSide && !this.aim) this.aim = this.begin(e, this.elR);
      try { root.setPointerCapture(e.pointerId); } catch { /* synthetic or already-released pointer */ }
    });
    root.addEventListener('pointermove', (e) => {
      if (this.move?.id === e.pointerId) this.updateMove(e);
      if (this.aim?.id === e.pointerId) this.updateAim(e);
    });
    const end = (e: PointerEvent) => {
      if (this.move?.id === e.pointerId) {
        this.finish(this.move);
        this.move = null;
        const t = this.input.touch;
        t.moveX = 0;
        t.thrust = t.down = false;
      }
      if (this.aim?.id === e.pointerId) {
        this.finish(this.aim);
        this.aim = null;
        this.input.touch.fire = false;
      }
    };
    root.addEventListener('pointerup', end);
    root.addEventListener('pointercancel', end);

    root.querySelectorAll<HTMLButtonElement>('.tbtn').forEach((b) => {
      this.buttons.set(b.dataset.act!, b);
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.enableTouchMode();
        this.input.press(b.dataset.act as 'melee' | 'grenade' | 'swap' | 'reload');
        b.classList.add('on');
        navigator.vibrate?.(8);
        setTimeout(() => b.classList.remove('on'), 130);
      });
    });
  }

  private enableTouchMode(): void {
    this.input.usingTouch = true;
    document.body.classList.add('touch-mode');
  }

  /** Start a stick where the thumb landed, kept fully on screen. */
  private begin(e: PointerEvent, el: HTMLElement): Stick {
    const half = el.offsetWidth / 2 || 58;
    const x = Math.min(Math.max(e.clientX, half + 8), window.innerWidth - half - 8);
    const y = Math.min(Math.max(e.clientY, half + 8), window.innerHeight - half - 8);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.classList.add('active');
    const knob = el.querySelector<HTMLElement>('.knob')!;
    knob.style.transform = `translate(${e.clientX - x}px, ${e.clientY - y}px)`;
    return { id: e.pointerId, ox: x, oy: y, el, knob };
  }

  /** Release: the stick goes back to its home corner. */
  private finish(s: Stick): void {
    s.el.style.left = '';
    s.el.style.top = '';
    s.el.classList.remove('active', 'firing');
    s.knob.style.transform = 'translate(0px, 0px)';
  }

  /** Clamp the knob to the stick radius and return the normalised offset (-1..1). */
  private offset(s: Stick, e: PointerEvent): { nx: number; ny: number; mag: number } {
    let dx = e.clientX - s.ox;
    let dy = e.clientY - s.oy;
    const len = Math.hypot(dx, dy);
    if (len > RADIUS) { dx = (dx / len) * RADIUS; dy = (dy / len) * RADIUS; }
    s.knob.style.transform = `translate(${dx}px, ${dy}px)`;
    return { nx: dx / RADIUS, ny: dy / RADIUS, mag: Math.min(1, len / RADIUS) };
  }

  private updateMove(e: PointerEvent): void {
    const { nx, ny } = this.offset(this.move!, e);
    const t = this.input.touch;
    t.moveX = Math.abs(nx) > 0.22 ? Math.max(-1, Math.min(1, nx * 1.3)) : 0;
    t.thrust = ny < -0.35;
    // Dropping through a platform needs a firm, mostly vertical pull, so running diagonally
    // downward never drops you by accident.
    t.down = ny > 0.75 && Math.abs(ny) > Math.abs(nx) * 1.8;
  }

  private updateAim(e: PointerEvent): void {
    const { nx, ny, mag } = this.offset(this.aim!, e);
    if (mag > 0.15) this.input.touch.aim = Math.atan2(ny, nx);
    const fire = mag > 0.55;
    this.input.touch.fire = fire;
    this.aim!.el.classList.toggle('firing', fire);
  }

  /** Show only the buttons the current mode and rules use. */
  setButtons(set: ButtonSet): void {
    const key = `${+set.reload}${+set.swap}${+set.grenade}${+set.melee}`;
    if (key === this.shown) return;
    this.shown = key;
    for (const [act, b] of this.buttons) b.classList.toggle('hidden', !set[act as keyof ButtonSet]);
  }

  setLefty(on: boolean): void {
    this.lefty = on;
    document.body.classList.toggle('lefty', on);
  }

  show(on: boolean): void {
    this.root.classList.toggle('hidden', !on);
  }
}
