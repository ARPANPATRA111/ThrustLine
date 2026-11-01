// Snapshot interpolation for remote players.
// Every pstate update is stored in a ring buffer stamped with the server time it was accepted.
// Each frame we draw the player at (serverNow - 100 ms), interpolating between the two
// snapshots around that time. This hides network jitter and bursty mobile delivery.
import { EXTRAPOLATE_MAX_MS, INTERP_DELAY_MS, SNAPSHOT_BUFFER } from '@shared/config';

const MIN_RENDER_DELAY_MS = 60;
const MAX_RENDER_DELAY_MS = 700;

export interface Sample {
  x: number;
  y: number;
  vx: number;
  vy: number;
  aim: number;
  flags: number;
  weapon: number;
}

export class SnapshotBuffer {
  // Parallel typed arrays: no per-snapshot allocations.
  private t = new Float64Array(SNAPSHOT_BUFFER);
  private x = new Float32Array(SNAPSHOT_BUFFER);
  private y = new Float32Array(SNAPSHOT_BUFFER);
  private vx = new Float32Array(SNAPSHOT_BUFFER);
  private vy = new Float32Array(SNAPSHOT_BUFFER);
  private aim = new Float32Array(SNAPSHOT_BUFFER);
  private flags = new Uint8Array(SNAPSHOT_BUFFER);
  private weapon = new Uint8Array(SNAPSHOT_BUFFER);
  private head = -1; // index of newest
  private count = 0;

  clear(): void {
    this.head = -1;
    this.count = 0;
  }

  get size(): number {
    return this.count;
  }

  push(tMs: number, s: Sample): void {
    if (this.count > 0 && tMs <= this.t[this.head]) return; // ignore duplicates / reordering
    this.head = (this.head + 1) % SNAPSHOT_BUFFER;
    const i = this.head;
    this.t[i] = tMs;
    this.x[i] = s.x;
    this.y[i] = s.y;
    this.vx[i] = s.vx;
    this.vy[i] = s.vy;
    this.aim[i] = s.aim;
    this.flags[i] = s.flags;
    this.weapon[i] = s.weapon;
    if (this.count < SNAPSHOT_BUFFER) this.count++;
  }

  /** Write the interpolated state at `renderMs` into `out`. Returns false if the buffer is empty. */
  sample(renderMs: number, out: Sample): boolean {
    if (this.count === 0) return false;
    const newest = this.head;
    if (renderMs >= this.t[newest]) {
      // Nothing newer: extrapolate along the last velocity for up to 100 ms, then hold.
      const dt = Math.min(renderMs - this.t[newest], EXTRAPOLATE_MAX_MS) / 1000;
      this.copy(newest, out);
      out.x += this.vx[newest] * dt;
      out.y += this.vy[newest] * dt;
      return true;
    }
    // Walk back from the newest to find the pair [a, b] with t[a] <= renderMs < t[b].
    let b = newest;
    for (let n = 1; n < this.count; n++) {
      const a = (b - 1 + SNAPSHOT_BUFFER) % SNAPSHOT_BUFFER;
      if (this.t[a] <= renderMs) {
        const f = (renderMs - this.t[a]) / (this.t[b] - this.t[a]);
        out.x = this.x[a] + (this.x[b] - this.x[a]) * f;
        out.y = this.y[a] + (this.y[b] - this.y[a]) * f;
        out.vx = this.vx[b];
        out.vy = this.vy[b];
        out.aim = lerpAngle(this.aim[a], this.aim[b], f);
        out.flags = f < 0.5 ? this.flags[a] : this.flags[b];
        out.weapon = f < 0.5 ? this.weapon[a] : this.weapon[b];
        return true;
      }
      b = a;
    }
    this.copy(b, out); // older than everything we have: show the oldest
    return true;
  }

  private copy(i: number, out: Sample): void {
    out.x = this.x[i];
    out.y = this.y[i];
    out.vx = this.vx[i];
    out.vy = this.vy[i];
    out.aim = this.aim[i];
    out.flags = this.flags[i];
    out.weapon = this.weapon[i];
  }
}

/**
 * Adaptive render delay for one remote player.
 * Each update carries the time it was simulated (the sender's estimate of server time). When it
 * arrives we measure how late it is: lag = serverNow - sentMs (upstream + downstream latency).
 * We draw the player `mean lag + 2 × jitter + margin` in the past, so there is (almost) always a
 * newer snapshot to interpolate toward instead of guessing ahead and snapping back. A fixed
 * 100 ms delay only works on a LAN: at 250 ms ping updates are already ~120 ms old on arrival.
 */
export class LagEstimator {
  private mean = -1;
  private dev = 20;
  /** Current render delay in ms (moves smoothly toward the target). */
  delay = INTERP_DELAY_MS;

  sample(lagMs: number): void {
    if (!Number.isFinite(lagMs) || lagMs < -500 || lagMs > 3000) return;
    if (this.mean < 0) this.mean = lagMs;
    const err = lagMs - this.mean;
    this.mean += err * 0.1;
    this.dev += (Math.abs(err) - this.dev) * 0.1;
  }

  /** Ease the delay toward its target (no sudden jumps in the drawn timeline). */
  update(dt: number): number {
    if (this.mean >= 0) {
      const target = Math.min(MAX_RENDER_DELAY_MS, Math.max(MIN_RENDER_DELAY_MS, this.mean + 2 * this.dev + 35));
      // Grow quickly (to stop extrapolating), shrink slowly (to stay smooth).
      const rate = target > this.delay ? 3 : 0.6;
      this.delay += (target - this.delay) * Math.min(1, dt * rate);
    }
    return this.delay;
  }
}

/** Interpolate angles the short way round. */
export function lerpAngle(a: number, b: number, f: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * f;
}
