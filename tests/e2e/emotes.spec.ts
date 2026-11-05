// Emotes, the fixed 5 s respawn and the death camera.
// Host and guest start an Arms match; the host emotes, dies in the acid, emotes again from the
// death spot, and picks a new primary on the respawn screen.
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

const contexts: BrowserContext[] = [];
test.afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close();
});
test.skip(!!process.env.BASE_URL?.startsWith('https'), 'local only');
test.setTimeout(120_000);

type Emote = { key: string; index: number; x: number; y: number; follow: boolean; sx: number; sy: number };
type DebugState = {
  me: { x: number; y: number; alive: boolean; weapon: number } | null;
  camera: { x: number; y: number; left: number; top: number; right: number; bottom: number };
  deathSpot: { x: number; y: number } | null;
  emotes: Emote[];
};

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

const state = (p: Page) => p.evaluate(() => (window as any).__tl.game.debugState() as DebugState);
const myKey = (p: Page) => p.evaluate(() => (window as any).__tl.net.myKey as string);
const teleport = (p: Page, x: number, y: number) => p.evaluate(([tx, ty]) => (window as any).__tl.net.conn.reducers.devTeleport({ x: tx, y: ty }), [x, y]);

async function emote(page: Page, index: number): Promise<void> {
  if (!(await page.locator('#emote-bar').isVisible())) await page.click('#btn-emote');
  await page.waitForSelector('#emote-bar:not(.hidden)');
  await page.click(`#emote-bar button[data-emote="${index}"]`);
}

test('emotes follow alive players, freeze at the death spot, and the camera holds there', async ({ browser }) => {
  const host = await openClient(browser, '?dev=1', 'Emoter');
  await host.click('#btn-create');
  await host.waitForSelector('#scr-lobby:not(.hidden)');
  const code = (await host.textContent('#lobby-code'))!.trim();
  const guest = await openClient(browser, `?room=${code}&dev=1`, 'Watcher');
  await expect(host.locator('#lobby-players li.pl')).toHaveCount(2);

  // No emote button before the match starts.
  await expect(host.locator('#emote-dock')).toBeHidden();

  await host.click('#btn-start');
  for (const p of [host, guest]) {
    await p.waitForSelector('#scr-game:not(.hidden)');
    await expect(p.locator('#emote-dock')).toBeVisible();
  }

  // Eight sticker buttons, each drawn as an image rather than a text emoji.
  await expect(host.locator('#emote-bar button')).toHaveCount(8);
  await expect(host.locator('#emote-bar button img')).toHaveCount(8);

  // Q toggles the picker for keyboard players.
  await host.keyboard.press('KeyQ');
  await expect(host.locator('#emote-bar')).toBeVisible();
  await host.keyboard.press('KeyQ');
  await expect(host.locator('#emote-bar')).toBeHidden();

  // Emote while alive: both clients draw it, and it follows the host as they move.
  await emote(host, 0);
  const hostKey = await myKey(host);
  await expect.poll(async () => (await state(guest)).emotes.some((e) => e.index === 0), { timeout: 5000 }).toBe(true);
  let s = await state(host);
  const live = s.emotes.find((e) => e.key === hostKey);
  expect(live, 'host sees its own emote at once').toBeTruthy();
  expect(live!.follow).toBe(true);
  await host.keyboard.down('KeyD');
  await host.waitForTimeout(600);
  await host.keyboard.up('KeyD');
  s = await state(host);
  const moved = s.emotes.find((e) => e.key === hostKey);
  expect(moved).toBeTruthy();
  expect(Math.abs(moved!.x - s.me!.x), 'emote follows the head while alive').toBeLessThan(6);

  // Die in the acid (30 HP/s → dead in ~4 s with the default 100 HP).
  await teleport(host, 48 * 32, 38 * 32);
  await host.waitForSelector('#scr-respawn:not(.hidden)', { timeout: 15_000 });
  await expect(host.locator('#respawn-count')).toHaveText(/^\d$/);
  await expect(host.locator('#emote-dock'), 'emotes remain available while dead').toBeVisible();
  await expect(host.locator('#emote-bar'), 'dying does not open the picker by itself').toBeHidden();
  // The player opens it themselves, and it does not cover the bottom pick row.
  await host.click('#btn-emote');
  await expect(host.locator('#emote-bar'), 'the player can open it while dead').toBeVisible();

  // The camera is pinned to the death spot (clamped to the map edge) and does not drift.
  const dead1 = await state(host);
  expect(dead1.me!.alive).toBe(false);
  expect(dead1.deathSpot).toBeTruthy();
  expect(dead1.deathSpot!.x).toBeGreaterThanOrEqual(dead1.camera.left - 1);
  expect(dead1.deathSpot!.x).toBeLessThanOrEqual(dead1.camera.right + 1);
  expect(dead1.deathSpot!.y).toBeGreaterThanOrEqual(dead1.camera.top - 1);
  expect(dead1.deathSpot!.y).toBeLessThanOrEqual(dead1.camera.bottom + 1);
  await host.waitForTimeout(700);
  const dead2 = await state(host);
  expect(dead2.camera.x).toBeCloseTo(dead1.camera.x, 1);
  expect(dead2.camera.y).toBeCloseTo(dead1.camera.y, 1);

  // Pick a primary on the death screen: the selection paints at once.
  await host.click('#primary-pick [data-w="2"]');
  await expect(host.locator('#primary-pick [data-w="2"]')).toHaveClass(/sel/);

  // Emote while dead: it appears where the player died, not at the hidden body.
  await emote(host, 2);
  const deadEmote = (await state(host)).emotes.find((e) => e.key === hostKey);
  expect(deadEmote, 'dead emote is drawn').toBeTruthy();
  expect(deadEmote!.index).toBe(2);
  expect(deadEmote!.follow).toBe(false);
  expect(Math.hypot(deadEmote!.x - dead1.deathSpot!.x, deadEmote!.y - dead1.deathSpot!.y)).toBeLessThan(2);
  // Enemies in the room see it too.
  await expect.poll(async () => (await state(guest)).emotes.some((e) => e.index === 2), { timeout: 5000 }).toBe(true);

  // Fixed 5 s respawn: the overlay clears, the chosen primary is equipped, the camera is released
  // and the death spot is forgotten.
  await host.waitForSelector('#scr-respawn', { state: 'hidden', timeout: 10_000 });
  await expect.poll(async () => (await state(host)).me?.alive, { timeout: 5000 }).toBe(true);
  expect((await state(host)).deathSpot).toBeNull();
  await expect.poll(async () => (await state(host)).me?.weapon, { timeout: 3000 }).toBe(2);
});

test('phone layout: the tray drops from the button and never covers the respawn picks', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });
  contexts.push(ctx);
  const page = await ctx.newPage();
  await page.goto('/?dev=1');
  await page.waitForSelector('#btn-tap:not(.hidden)', { timeout: 60_000 });
  await page.click('#btn-tap');
  await page.waitForSelector('#scr-home:not(.hidden)', { timeout: 60_000 });
  await page.click('#btn-create');
  await page.waitForSelector('#scr-lobby:not(.hidden)');
  await page.click('#btn-start');
  await page.waitForSelector('#scr-game:not(.hidden)');
  await page.waitForFunction(() => (window as any).__tl.game.room?.state === 1 && (window as any).__tl.game.local?.alive);

  // The tray hangs directly below the emote button, right-aligned with it.
  const btn = (await page.locator('#btn-emote').boundingBox())!;
  await page.click('#btn-emote');
  await expect(page.locator('#emote-bar')).toBeVisible();
  const bar = (await page.locator('#emote-bar').boundingBox())!;
  expect(bar.y).toBeGreaterThan(btn.y + btn.height);
  expect(Math.abs(bar.x + bar.width - (btn.x + btn.width))).toBeLessThanOrEqual(2);

  // Two fingers at once: one holds the movement stick while the other taps Emote. The tap must
  // still register, so a player can emote without letting go of the controls.
  await page.click('#btn-emote'); // close the tray first
  await expect(page.locator('#emote-bar')).toBeHidden();
  const cdp = await ctx.newCDPSession(page);
  const eb = (await page.locator('#btn-emote').boundingBox())!;
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [
      { x: 110, y: 300, id: 1 },
      { x: eb.x + eb.width / 2, y: eb.y + eb.height / 2, id: 2 },
    ],
  });
  await expect(page.locator('#emote-bar'), 'a second finger opens the tray while the stick is held').toBeVisible();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.click('#btn-emote');

  // Close it, then die: death must not reopen the tray.
  await expect(page.locator('#emote-bar')).toBeHidden();
  await page.evaluate(() => (window as any).__tl.net.conn.reducers.devTeleport({ x: 48 * 32, y: 38 * 32 }));
  await page.waitForSelector('#scr-respawn:not(.hidden)', { timeout: 15_000 });
  await expect(page.locator('#emote-bar')).toBeHidden();
  const picks = (await page.locator('#primary-pick').boundingBox())!;
  expect(picks.y, 'weapon picks sit in the lower part of the screen').toBeGreaterThan(390 * 0.55);

  // Opening the tray while dead cannot overlap the picks.
  await page.click('#btn-emote');
  const open = (await page.locator('#emote-bar').boundingBox())!;
  const overlap = !(open.x + open.width <= picks.x || picks.x + picks.width <= open.x || open.y + open.height <= picks.y || picks.y + picks.height <= open.y);
  expect(overlap, 'emote tray and respawn picks do not overlap').toBe(false);
});
