// Player settings and death feedback: rebinding keys, gamepad, comfort options, the kill recap and
// looking around while waiting to respawn.
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

const contexts: BrowserContext[] = [];
test.afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close();
});
test.skip(!!process.env.BASE_URL?.startsWith('https'), 'local only');
test.setTimeout(120_000);

async function openClient(browser: Browser, query: string, name: string, viewport = { width: 1280, height: 720 }): Promise<Page> {
  const ctx = await browser.newContext({ viewport });
  contexts.push(ctx);
  await ctx.addInitScript((n) => {
    const saved = JSON.parse(localStorage.getItem('tl:settings') ?? '{}');
    localStorage.setItem('tl:settings', JSON.stringify({ ...saved, name: n }));
  }, name);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
  await page.goto(`/${query}`);
  await page.waitForSelector('#btn-tap:not(.hidden)', { timeout: 60_000 });
  await page.click('#btn-tap');
  await page.waitForSelector(query.includes('room=') ? '#scr-lobby:not(.hidden)' : '#scr-home:not(.hidden)', { timeout: 60_000 });
  return page;
}

const st = (p: Page) => p.evaluate(() => (window as any).__tl.game.debugState());
const teleport = (p: Page, x: number, y: number) => p.evaluate(([tx, ty]) => (window as any).__tl.net.conn.reducers.devTeleport({ x: tx, y: ty }), [x, y]);

async function soloMatch(page: Page): Promise<void> {
  await page.click('#btn-create');
  await page.waitForSelector('#scr-lobby:not(.hidden)');
  await page.click('#seg-round [data-v="300"]');
  await page.click('#btn-start');
  await page.waitForSelector('#scr-game:not(.hidden)');
  await expect.poll(async () => (await st(page)).me?.alive, { timeout: 8000 }).toBe(true);
  await page.waitForTimeout(400);
}

test('a rebound key works in the match, updates the hints and survives a reload', async ({ browser }) => {
  const page = await openClient(browser, '?dev=1', 'Rebinder');
  await page.click('#btn-settings');
  await page.click('#key-binds button[data-act="right"]');
  await expect(page.locator('#key-binds button[data-act="right"] kbd')).toHaveText('Press a key');
  await page.keyboard.press('KeyL');
  await expect(page.locator('#key-binds button[data-act="right"] kbd')).toHaveText('L');

  // Taking a key another action uses swaps them, so nothing ends up unbound.
  await page.click('#key-binds button[data-act="left"]');
  await page.keyboard.press('KeyF');
  await expect(page.locator('#key-binds button[data-act="left"] kbd')).toHaveText('F');
  await expect(page.locator('#key-binds button[data-act="swap"] kbd')).toHaveText('A');

  await page.click('#btn-settings-close');
  await soloMatch(page);
  await expect(page.locator('#key-hints')).toContainText('FL');

  await teleport(page, 6 * 32 + 16, 36 * 32);
  await page.waitForTimeout(500);
  const x0 = (await st(page)).me.x;
  await page.keyboard.down('KeyD'); // the old key does nothing now
  await page.waitForTimeout(300);
  await page.keyboard.up('KeyD');
  expect((await st(page)).me.x).toBeCloseTo(x0, 0);
  await page.keyboard.down('KeyL');
  await page.waitForTimeout(400);
  await page.keyboard.up('KeyL');
  expect((await st(page)).me.x).toBeGreaterThan(x0 + 40);

  await page.reload();
  await page.waitForSelector('#btn-tap:not(.hidden)', { timeout: 60_000 });
  await page.click('#btn-tap');
  await page.waitForSelector('#scr-game:not(.hidden)');
  await expect(page.locator('#key-binds button[data-act="right"] kbd')).toHaveText('L');
});

test('a gamepad moves, aims and fires', async ({ browser }) => {
  const page = await openClient(browser, '?dev=1', 'Padder');
  await soloMatch(page);
  await teleport(page, 6 * 32 + 16, 36 * 32);
  await page.waitForTimeout(500);
  const x0 = (await st(page)).me.x;

  // Stand in for the browser's gamepad API: left stick right, right stick pointing up.
  await page.evaluate(() => {
    const pad = { connected: true, axes: [1, 0, 0, -1], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) };
    (window as any).__pad = pad;
    navigator.getGamepads = () => [pad as unknown as Gamepad];
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => { (window as any).__pad.axes[0] = 0; });
  expect((await st(page)).me.x, 'left stick moves').toBeGreaterThan(x0 + 40);
  const aim = await page.evaluate(() => (window as any).__tl.game.local.aim);
  expect(aim).toBeCloseTo(-Math.PI / 2, 1);

  // The right trigger fires.
  await page.evaluate(() => { (window as any).__shots = 0; const fx = (window as any).__tl.game.local.fx; const s = fx.shot; fx.shot = (...a: unknown[]) => { (window as any).__shots++; s(...a); }; });
  await page.evaluate(() => { (window as any).__pad.buttons[7] = { pressed: true, value: 1 }; });
  await expect.poll(() => page.evaluate(() => (window as any).__shots), { timeout: 3000 }).toBeGreaterThan(0);
});

test('comfort settings apply and the palette changes team colours', async ({ browser }) => {
  const page = await openClient(browser, '?dev=1', 'Comfy');
  await page.click('#btn-settings');
  await page.locator('#set-shake').fill('0');
  await page.locator('#set-particles').fill('0.5');
  await page.click('label.tog:has(#set-colorblind)');
  await expect(page.locator('body')).toHaveClass(/cb/);
  const v = await page.evaluate(() => {
    const g = (window as any).__tl.game;
    return { shake: g.camera.shakeScale, cap: g.particles.cap };
  });
  expect(v.shake).toBe(0);
  expect(v.cap).toBeLessThan(300);
  await page.click('#btn-settings-close');
  await page.reload();
  await page.waitForSelector('#btn-tap:not(.hidden)', { timeout: 60_000 });
  await expect(page.locator('body'), 'the palette is remembered').toHaveClass(/cb/);
});

test('the death screen recaps the kill and lets the player look around', async ({ browser }) => {
  const a = await openClient(browser, '?dev=1', 'Hunter');
  await a.click('#btn-create');
  await a.waitForSelector('#scr-lobby:not(.hidden)');
  await a.click('#seg-round [data-v="300"]');
  const code = (await a.textContent('#lobby-code'))!.trim();
  const b = await openClient(browser, `?room=${code}&dev=1`, 'Prey');
  await expect(a.locator('#lobby-players li.pl')).toHaveCount(2);
  await a.evaluate(() => (window as any).__tl.net.conn.reducers.choosePrimary({ weapon: 3 }));
  await a.click('#btn-start');
  for (const p of [a, b]) await p.waitForSelector('#scr-game:not(.hidden)');
  for (const p of [a, b]) await expect.poll(async () => (await st(p)).me?.alive, { timeout: 8000 }).toBe(true);
  await a.waitForTimeout(1700);

  await teleport(a, 6 * 32 + 16, 36 * 32);
  await teleport(b, 6 * 32 + 16 + 260, 36 * 32);
  await a.waitForTimeout(700);
  const v = (await st(a)).remotes[0];
  await a.mouse.move(v.sx, v.sy);
  await a.mouse.down();
  await a.waitForTimeout(80);
  await a.mouse.up();

  await b.waitForSelector('#scr-respawn:not(.hidden)', { timeout: 6000 });
  await expect(b.locator('#killed-by')).toContainText('Eliminated by Hunter');
  await expect(b.locator('#kill-recap')).toContainText('sniper');
  await expect(b.locator('#kill-recap')).toContainText('100 HP left');

  // The view stays put until the player moves it, then snaps home on respawn.
  const c0 = (await st(b)).camera.x;
  await b.waitForTimeout(400);
  expect((await st(b)).camera.x).toBeCloseTo(c0, 1);
  await b.keyboard.down('KeyD');
  await b.waitForTimeout(700);
  await b.keyboard.up('KeyD');
  expect((await st(b)).camera.x, 'movement pans the dead camera').toBeGreaterThan(c0 + 60);
  await expect.poll(async () => (await st(b)).me?.alive, { timeout: 8000 }).toBe(true);
});
