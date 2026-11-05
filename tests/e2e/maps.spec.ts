// Map choice and rotation: the host picks an arena, the server validates against that arena's
// tiles, and rotation walks through the maps round by round.
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

const contexts: BrowserContext[] = [];
test.afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close();
});
test.skip(!!process.env.BASE_URL?.startsWith('https'), 'local only');
test.setTimeout(150_000);

async function openClient(browser: Browser, query: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  contexts.push(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
  await page.goto(`/${query}`);
  await page.waitForSelector('#btn-tap:not(.hidden)', { timeout: 60_000 });
  await page.click('#btn-tap');
  await page.waitForSelector(query.includes('room=') ? '#scr-lobby:not(.hidden)' : '#scr-home:not(.hidden)', { timeout: 60_000 });
  return page;
}

const st = (p: Page) => p.evaluate(() => (window as any).__tl.game.debugState());
const teleport = (p: Page, x: number, y: number) => p.evaluate(([tx, ty]) => (window as any).__tl.net.conn.reducers.devTeleport({ x: tx, y: ty }).then(() => 'ok', (e: Error) => e.message), [x, y]);

test('the host picks HELIOS-9 and the server plays by its tiles', async ({ browser }) => {
  const a = await openClient(browser, '?dev=1');
  await a.click('#btn-create');
  await a.waitForSelector('#scr-lobby:not(.hidden)');
  const code = (await a.textContent('#lobby-code'))!.trim();
  const b = await openClient(browser, `?room=${code}&dev=1`);
  await a.click('#seg-map [data-v="1"]');
  await expect(b.locator('#seg-map [data-v="1"]'), 'guests see the map').toHaveClass(/on/);
  await expect.poll(async () => (await st(b)).mapId, { timeout: 4000 }).toBe(1);

  await a.click('#btn-start');
  for (const p of [a, b]) await p.waitForSelector('#scr-game:not(.hidden)');
  await expect.poll(async () => (await st(a)).me?.alive, { timeout: 8000 }).toBe(true);
  await expect(a.locator('#notice')).toContainText('HELIOS-9');

  // Tile (21, 15) is inside the HELIOS tower but open air on RIG-7.
  expect(await teleport(a, 21 * 32 + 16, 16 * 32)).toContain('Invalid position');
  // The pickups are HELIOS's own: a shield waits on one of its floors.
  const shield = (await st(a)).pickups.find((k: any) => k.kind === 3);
  expect(await teleport(a, (shield.tx + 0.5) * 32, (shield.ty + 1) * 32)).toBe('ok');
  await expect.poll(() => a.evaluate(() => (window as any).__tl.game.localRow.shield), { timeout: 4000 }).toBe(50);

  // Standing on a HELIOS platform holds the player up: the client simulates the same tiles.
  expect(await teleport(a, 40 * 32 + 16, 16 * 32)).toBe('ok');
  await a.waitForTimeout(700);
  expect((await st(a)).me.y).toBeCloseTo(16 * 32, 0);
});

test('rotation plays a different map each round', async ({ browser }) => {
  const a = await openClient(browser, '?dev=1');
  await a.click('#btn-create');
  await a.waitForSelector('#scr-lobby:not(.hidden)');
  await a.click('#seg-round [data-v="30"]');
  await a.click(`#seg-map [data-v="255"]`);
  await a.waitForTimeout(300);
  await a.click('#btn-start');
  await a.waitForSelector('#scr-game:not(.hidden)');
  await expect.poll(async () => (await st(a)).room?.state, { timeout: 5000 }).toBe(1);
  const first = (await st(a)).mapId;

  await a.waitForSelector('#scr-board:not(.hidden)', { timeout: 45_000 });
  await a.click('#btn-again');
  await expect.poll(async () => (await st(a)).room?.state, { timeout: 5000 }).toBe(1);
  expect((await st(a)).mapId, 'the next round moves on').not.toBe(first);
});
