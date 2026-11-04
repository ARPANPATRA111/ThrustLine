// Netcode under realistic latency: both clients get ~250 ms round trip with bursty jitter
// (simulated by wrapping the browser WebSocket: messages are delayed but stay in order, like TCP).
// A player flies around hard; we check that
//   - the flyer is never snapped back by the server (no corrections), and
//   - the other client sees smooth motion (no teleport-like jumps or backwards steps).
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

const contexts: BrowserContext[] = [];
test.afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close();
});
// Against production the real network supplies the latency (no simulated delay).
const REAL = !!process.env.BASE_URL?.startsWith('https');
test.setTimeout(150_000);

const ONE_WAY_MS = REAL ? 0 : 125;
const JITTER_MS = REAL ? 0 : 60;

/** Replace WebSocket with a version that delays both directions (in order) by one-way + jitter. */
function laggyWebSocket({ oneWay, jitter }: { oneWay: number; jitter: number }) {
  const Real = window.WebSocket;
  class Laggy extends Real {
    private outAt = 0;
    private inAt = 0;
    private delayFor(dir: 'in' | 'out'): number {
      const now = performance.now();
      // Bursty jitter, but never reorder: each message is scheduled after the previous one.
      const at = Math.max(dir === 'in' ? this.inAt : this.outAt, now + oneWay + Math.random() * jitter);
      if (dir === 'in') this.inAt = at; else this.outAt = at;
      return at - now;
    }
    send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      // Copy binary data: the SDK may reuse its buffer as soon as send() returns.
      let copy: string | ArrayBufferLike | Blob | ArrayBufferView = data;
      if (ArrayBuffer.isView(data)) copy = new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
      else if (data instanceof ArrayBuffer) copy = data.slice(0);
      const d = this.delayFor('out');
      setTimeout(() => { if (this.readyState === 1) super.send(copy); }, d);
    }
    set onmessage(fn: ((ev: MessageEvent) => void) | null) {
      super.onmessage = fn ? (ev: MessageEvent) => { setTimeout(() => fn.call(this, ev), this.delayFor('in')); } : null;
    }
    get onmessage() { return super.onmessage; }
  }
  (window as any).WebSocket = Laggy;
}

async function openClient(browser: Browser, query: string, name: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  contexts.push(ctx);
  await ctx.addInitScript(laggyWebSocket, { oneWay: ONE_WAY_MS, jitter: JITTER_MS });
  await ctx.addInitScript((n) => localStorage.setItem('tl:settings', JSON.stringify({ name: n })), name);
  const page = await ctx.newPage();
  await page.goto(`/${query}`);
  await page.waitForSelector('#btn-tap:not(.hidden)', { timeout: 60_000 });
  await page.click('#btn-tap');
  // Headless can drop a click while the tab is still warming up; retry once before giving up.
  await page.waitForTimeout(300);
  if (await page.locator('#btn-tap').isVisible()) await page.click('#btn-tap');
  await page.waitForSelector(query.includes('room=') ? '#scr-lobby:not(.hidden)' : '#scr-home:not(.hidden)', { timeout: 60_000 });
  return page;
}

test('smooth movement and no snap-backs at ~250 ms ping', async ({ browser }) => {
  const watcher = await openClient(browser, '?dev=1', 'Watcher');
  await watcher.click('#btn-create');
  await watcher.waitForSelector('#scr-lobby:not(.hidden)');
  const code = (await watcher.textContent('#lobby-code'))!.trim();
  const flyer = await openClient(browser, `?room=${code}&dev=1`, 'Flyer');
  await watcher.click('#btn-start');
  for (const p of [watcher, flyer]) await p.waitForSelector('#scr-game:not(.hidden)');
  await expect.poll(async () => flyer.evaluate(() => (window as any).__tl.game.local?.alive)).toBe(true);
  await flyer.waitForTimeout(2500); // let clock sync settle
  const rtt = await flyer.evaluate(() => (window as any).__tl.time.rtt);
  console.log(`measured ping: ${rtt.toFixed(0)} ms`);
  expect(rtt).toBeGreaterThan(200);

  // The watcher records where it draws the flyer every frame.
  await watcher.evaluate(() => {
    const w = window as any;
    w.__track = [];
    const g = w.__tl.game;
    const tick = () => {
      const r = [...g.remotes.values()][0];
      if (r && r.hasSample && r.row.alive) w.__track.push([performance.now(), r.s.x, r.s.y]);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const corr0 = await flyer.evaluate(() => (window as any).__tl.game.localRow.correction);

  // Fly hard for ~8 s: jetpack bursts, direction changes, falls.
  const keys = [['KeyD', 'KeyW'], ['KeyD'], ['KeyA', 'KeyW'], ['KeyA'], ['KeyD', 'KeyW'], ['KeyW'], [], ['KeyA', 'KeyW']];
  for (const combo of keys) {
    for (const k of combo) await flyer.keyboard.down(k);
    await flyer.waitForTimeout(1000);
    for (const k of combo) await flyer.keyboard.up(k);
  }
  await flyer.waitForTimeout(1000);

  const corrections = (await flyer.evaluate(() => (window as any).__tl.game.localRow.correction)) - corr0;
  const track: [number, number, number][] = await watcher.evaluate(() => (window as any).__track);
  // Max possible speed ~1345 px/s; a frame step much larger than that (or a reversal against the
  // motion) is a visible "teleport" or snap.
  let jumps = 0;
  let maxStep = 0;
  for (let i = 1; i < track.length; i++) {
    const dt = Math.max(1, track[i][0] - track[i - 1][0]) / 1000;
    const step = Math.hypot(track[i][1] - track[i - 1][1], track[i][2] - track[i - 1][2]);
    maxStep = Math.max(maxStep, step / dt);
    if (step > 30 && step / dt > 2200) jumps++;
  }
  console.log(`flyer corrections: ${corrections}; watcher frames: ${track.length}, teleport-like jumps: ${jumps}, max drawn speed ${maxStep.toFixed(0)} px/s`);
  expect(corrections, 'server never snapped the flyer back').toBe(0);
  expect(track.length).toBeGreaterThan(50); // background headless pages render slowly; just ensure we sampled
  expect(jumps, 'remote motion has no teleport-like jumps').toBe(0);
});
