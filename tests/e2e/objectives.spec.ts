// King of the Hill and sudden death.
//   - Standing alone in the zone scores 10 a second; a second player contests it and stops the points.
//   - The zone moves on a timer.
//   - In sudden death the acid climbs: low ground burns, high ground is safe.
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

const contexts: BrowserContext[] = [];
test.afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close();
});
test.skip(!!process.env.BASE_URL?.startsWith('https'), 'local only');
test.setTimeout(150_000);

async function openClient(browser: Browser, query: string, name: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  contexts.push(ctx);
  await ctx.addInitScript((n) => localStorage.setItem('tl:settings', JSON.stringify({ name: n })), name);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
  await page.goto(`/${query}`);
  await page.waitForSelector('#btn-tap:not(.hidden)', { timeout: 60_000 });
  await page.click('#btn-tap');
  await page.waitForSelector(query.includes('room=') ? '#scr-lobby:not(.hidden)' : '#scr-home:not(.hidden)', { timeout: 60_000 });
  return page;
}

const st = (p: Page) => p.evaluate(() => (window as any).__tl.game.debugState());
const me = (p: Page) => p.evaluate(() => {
  const r = (window as any).__tl.game.localRow;
  return { hp: r.hp, score: r.score, alive: r.alive, deaths: r.deaths };
});
const teleport = (p: Page, x: number, y: number) => p.evaluate(([tx, ty]) => (window as any).__tl.net.conn.reducers.devTeleport({ x: tx, y: ty }), [x, y]);
const intoZone = (p: Page, z: { tx: number; ty: number; tw: number; th: number }, dx = 0) =>
  teleport(p, (z.tx + z.tw / 2) * 32 + dx, (z.ty + z.th) * 32);

async function lobby(browser: Browser): Promise<Page[]> {
  const a = await openClient(browser, '?dev=1', 'Alpha');
  await a.click('#btn-create');
  await a.waitForSelector('#scr-lobby:not(.hidden)');
  const code = (await a.textContent('#lobby-code'))!.trim();
  const b = await openClient(browser, `?room=${code}&dev=1`, 'Bravo');
  await expect(a.locator('#lobby-players li.pl')).toHaveCount(2);
  return [a, b];
}

async function start(a: Page, b: Page): Promise<void> {
  await a.click('#btn-start');
  for (const p of [a, b]) await p.waitForSelector('#scr-game:not(.hidden)');
  for (const p of [a, b]) await expect.poll(async () => (await st(p)).me?.alive, { timeout: 8000 }).toBe(true);
}

test('holding the hill scores, contesting stops it, and the zone moves', async ({ browser }) => {
  const [a, b] = await lobby(browser);
  await a.click('#seg-objective [data-v="1"]');
  await a.click('#seg-round [data-v="300"]');
  await expect(b.locator('#seg-objective [data-v="1"]'), 'guests see the objective').toHaveClass(/on/);
  await start(a, b);

  await expect.poll(async () => (await st(a)).hill, { timeout: 5000 }).toBeTruthy();
  const first = (await st(a)).hill;
  await expect(a.locator('#hill-chip')).toBeVisible();

  // Alone in the zone: +10 a second.
  await intoZone(a, first.zone);
  await expect.poll(async () => (await st(a)).hill.state, { timeout: 4000 }).toBe(2);
  await expect(a.locator('#hill-chip')).toContainText('HOLDING');
  await expect(b.locator('#hill-chip')).toContainText('Alpha HOLDS');
  const s0 = (await me(a)).score;
  await a.waitForTimeout(3200);
  const s1 = (await me(a)).score;
  expect(s1 - s0).toBeGreaterThanOrEqual(20);
  expect(s1 - s0).toBeLessThanOrEqual(40);
  expect((await st(a)).hill.mine).toBe(true);

  // A second player in the zone contests it: nobody scores.
  await intoZone(b, first.zone, 40);
  await expect.poll(async () => (await st(a)).hill.state, { timeout: 4000 }).toBe(1);
  await expect(a.locator('#hill-chip')).toContainText('CONTESTED');
  const s2 = (await me(a)).score;
  await a.waitForTimeout(2200);
  expect((await me(a)).score, 'no points while contested').toBe(s2);

  // Dev rooms move the zone every 10 s, and it never stays put.
  await expect.poll(async () => (await st(a)).hill.idx, { timeout: 14_000 }).not.toBe(first.idx);
});

test('sudden death: the acid climbs, low ground burns and high ground is safe', async ({ browser }) => {
  const [a, b] = await lobby(browser);
  await a.click('#seg-round [data-v="30"]');
  await a.click('label.tog:has(input[data-match="suddenDeath"])');
  await expect(a.locator('input[data-match="suddenDeath"]')).toBeChecked();
  await a.waitForTimeout(400);
  await start(a, b);

  // Before the last 12 s the acid is where it always was.
  expect((await st(a)).acidLine).toBe(Infinity);
  await teleport(a, 6 * 32 + 16, 36 * 32); // floor
  await teleport(b, 47 * 32, 6 * 32); // top gantry
  await expect.poll(async () => (await st(a)).acidLine, { timeout: 30_000 }).not.toBe(Infinity);
  await expect(a.locator('#banner')).toContainText('ACID RISING');
  const start0 = (await st(a)).acidLine;
  expect(start0).toBeLessThanOrEqual(36 * 32);

  // The surface rises past the floor and the player standing there burns.
  await expect.poll(async () => (await me(a)).hp, { timeout: 10_000 }).toBeLessThan(90);
  const later = (await st(a)).acidLine;
  expect(later, 'the surface climbs').toBeLessThan(start0);
  expect((await me(b)).hp, 'the top gantry stays above it').toBe(100);
});
