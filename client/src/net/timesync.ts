// Clock sync with the server, NTP-style.
// For each pong: RTT = now - clientMs; offset = serverMs - (clientMs + RTT/2).
// We keep the median of the last 5 offsets, so a single slow packet can't skew the clock.
import { PING_COUNT_INITIAL, PING_INITIAL_GAP_MS, PING_INTERVAL_MS, PING_MEDIAN_OF } from '@shared/config';

export class TimeSync {
  private offsets: number[] = [];
  private rtts: number[] = [];
  offset = 0;
  rtt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private sendPing: (clientMs: number) => void) {}

  /** Five quick pings 200 ms apart, then one every 2 s. */
  start(): void {
    this.stop();
    let sent = 0;
    const tick = () => {
      this.sendPing(performance.now());
      sent++;
      this.timer = setTimeout(tick, sent < PING_COUNT_INITIAL ? PING_INITIAL_GAP_MS : PING_INTERVAL_MS);
    };
    tick();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  onPong(clientMs: number, serverMicros: bigint): void {
    const now = performance.now();
    const rtt = now - clientMs;
    if (rtt < 0 || rtt > 10000) return;
    const serverMs = Number(serverMicros) / 1000;
    const offset = serverMs - (clientMs + rtt / 2);
    this.offsets.push(offset);
    this.rtts.push(rtt);
    if (this.offsets.length > PING_MEDIAN_OF) this.offsets.shift();
    if (this.rtts.length > PING_MEDIAN_OF) this.rtts.shift();
    this.offset = median(this.offsets);
    this.rtt = median(this.rtts);
  }

  get synced(): boolean {
    return this.offsets.length > 0;
  }

  /** Current server time in milliseconds since the Unix epoch. */
  serverNow(): number {
    return performance.now() + this.offset;
  }
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
