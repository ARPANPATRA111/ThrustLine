// Twin-stick touch controls with Pointer Events (each finger tracked by pointerId).
// Left 40% of the screen: a movement stick appears where the thumb lands.
//   Horizontal = run; push up past 40% = thrust; push down past 60% = drop through.
// Right 40%: an aim stick. Its direction aims; pushing past 60% fires.
// Buttons above the right stick: swap, reload, grenade, knife. Left-handed mode mirrors.
import type { Input } from '../game/input';

const RADIUS = 60;

interface Stick {
  id: number;
  ox: number;
  oy: number;
  el: HTMLElement;
  knob: HTMLElement;
}

export class TouchControls {
  private move: Stick | null = null;
  private aim: Stick | null = null;
  lefty = false;

  constructor(private root: HTMLElement, private input: Input) {
    const elL = root.querySelector<HTMLElement>('#stick-l')!;
    const elR = root.querySelector<HTMLElement>('#stick-r')!;
    root.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' || (e.target as HTMLElement).closest('.tbtn')) return;
      e.preventDefault();
      this.input.usingTouch = true;
      document.body.classList.add('touch-mode');
      const w = window.innerWidth;
      const leftZone = this.lefty ? e.clientX > w * 0.6 : e.clientX < w * 0.4;
      const rightZone = this.lefty ? e.clientX < w * 0.4 : e.clientX > w * 0.6;
      if (leftZone && !this.move) this.move = this.begin(e, elL);
      else if (rightZone && !this.aim) this.aim = this.begin(e, elR);
      try { root.setPointerCapture(e.pointerId); } catch { /* synthetic or already-released pointer */ }
    });
    root.addEventListener('pointermove', (e) => {
      if (this.move?.id === e.pointerId) this.updateMove(e);
      if (this.aim?.id === e.pointerId) this.updateAim(e);
    });
    const end = (e: PointerEvent) => {
      if (this.move?.id === e.pointerId) { this.finish(this.move); this.move = null; const t = this.input.touch; t.moveX = 0; t.thrust = t.down = false; }
      if (this.aim?.id === e.pointerId) { this.finish(this.aim); this.aim = null; this.input.touch.fire = false; }
    };
    root.addEventListener('pointerup', end);
    root.addEventListener('pointercancel', end);

    root.querySelectorAll<HTMLButtonElement>('.tbtn').forEach((b) => {
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.input.usingTouch = true;
        this.input.press(b.dataset.act as 'melee' | 'grenade' | 'swap' | 'reload');
        b.classList.add('on');
        setTimeout(() => b.classList.remove('on'), 120);
      });
    });
  }

  private begin(e: PointerEvent, el: HTMLElement): Stick {
    el.classList.remove('hidden');
    el.style.left = `${e.clientX}px`;
    el.style.top = `${e.clientY}px`;
    const knob = el.querySelector<HTMLElement>('.knob')!;
    knob.style.transform = 'translate(0px, 0px)';
    return { id: e.pointerId, ox: e.clientX, oy: e.clientY, el, knob };
  }

  private finish(s: Stick): void {
    s.el.classList.add('hidden');
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
    t.moveX = Math.abs(nx) > 0.2 ? nx : 0;
    t.thrust = ny < -0.4;
    t.down = ny > 0.6;
  }

  private updateAim(e: PointerEvent): void {
    const { nx, ny, mag } = this.offset(this.aim!, e);
    if (mag > 0.15) this.input.touch.aim = Math.atan2(ny, nx);
    this.input.touch.fire = mag > 0.6;
  }

  setLefty(on: boolean): void {
    this.lefty = on;
    document.body.classList.toggle('lefty', on);
  }

  show(on: boolean): void {
    this.root.classList.toggle('hidden', !on);
  }
}
