// The loadout screen: eight seconds to pick a gun and a grenade before every round. These rooms
// are not dev rooms, because dev rooms shorten the timer to keep the other tests quick.
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

const contexts: BrowserContext[] = [];
test.afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close();
});
test.skip(!!process.env.BASE_URL?.startsWith('https'), 'local only');
test.setTimeout(90_000);

async function openClient(browser: Browser, query: string, name: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  contexts.push(ctx);
  await ctx.addInitScript((n) => {
    if (!localStorage.getItem('tl:settings')) localStorage.setItem('tl:settings', JSON.stringify({ name: n }));
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

test('everyone gets eight seconds to pick, and starts with what they picked', async ({ browser }) => {
  const a = await openClient(browser, '', 'Alpha');
  await a.click('#btn-create');
  await a.waitForSelector('#scr-lobby:not(.hidden)');
  const code = (await a.textContent('#lobby-code'))!.trim();
  const b = await openClient(browser, `?room=${code}`, 'Bravo');
  await expect(a.locator('#lobby-players li.pl')).toHaveCount(2);

  await a.click('#btn-start');
  const opened = Date.now();
  for (const p of [a, b]) await expect(p.locator('#scr-loadout')).toBeVisible();
  await expect(a.locator('#lo-map')).toHaveText('RIG-7');
  await expect(a.locator('#lo-objective')).toHaveText('Deathmatch');
  expect(Number(await a.textContent('#lo-count'))).toBeGreaterThanOrEqual(6);
  expect((await st(a)).me?.alive, 'nobody deploys while choosing').toBeFalsy();

  await a.click('#scr-loadout .pick[data-w="6"]');
  await a.click('#scr-loadout .pick[data-n="1"]');
  await b.click('#scr-loadout .pick[data-w="2"]');
  await b.click('#scr-loadout .pick[data-n="2"]');
  await expect(a.locator('#scr-loadout .pick[data-w="6"]')).toHaveClass(/sel/);
  await expect(b.locator('#scr-loadout .pick[data-n="2"]')).toHaveClass(/sel/);

  for (const p of [a, b]) await expect(p.locator('#scr-loadout')).toBeHidden({ timeout: 11_000 });
  const took = Date.now() - opened;
  console.log(`round began after ${took} ms`);
  expect(took).toBeGreaterThan(6500);
  expect(took).toBeLessThan(10_000);

  for (const p of [a, b]) await expect.poll(async () => (await st(p)).me?.alive, { timeout: 3000 }).toBe(true);
  expect((await st(a)).me).toMatchObject({ weapon: 6, nade: 1 });
  expect((await st(b)).me).toMatchObject({ weapon: 2, nade: 2 });
  await expect(a.locator('#nade-count')).toContainText('IMPACT');
});

test('the last loadout comes along to the next room', async ({ browser }) => {
  const a = await openClient(browser, '', 'Alpha');
  await a.click('#btn-create');
  await a.waitForSelector('#scr-lobby:not(.hidden)');
  await a.click('#btn-start');
  await expect(a.locator('#scr-loadout')).toBeVisible();
  await a.click('#scr-loadout .pick[data-w="3"]');
  await a.click('#scr-loadout .pick[data-n="2"]');
  await expect.poll(() => a.evaluate(() => (window as any).__tl.game.localRow.nade)).toBe(2);

  await a.reload();
  await a.waitForSelector('#btn-tap:not(.hidden)', { timeout: 60_000 });
  await a.click('#btn-tap');
  await a.waitForSelector('#scr-game:not(.hidden), #scr-home:not(.hidden)');
  await a.evaluate(() => (window as any).__tl.net.conn.reducers.leaveRoom({}));
  await a.waitForSelector('#scr-home:not(.hidden)');
  await a.waitForTimeout(5200); // room creation cooldown
  await a.click('#btn-create');
  await a.waitForSelector('#scr-lobby:not(.hidden)');
  await expect.poll(() => a.evaluate(() => {
    const r = (window as any).__tl.game.localRow;
    return [r?.primary, r?.nade];
  })).toEqual([3, 2]);
});

test('modes with nothing to choose skip the screen', async ({ browser }) => {
  const a = await openClient(browser, '', 'Alpha');
  await a.click('#btn-create');
  await a.waitForSelector('#scr-lobby:not(.hidden)');
  await a.click('.mode[data-mode="1"]'); // Blades
  await expect(a.locator('.mode[data-mode="1"]')).toHaveClass(/on/);
  await a.waitForTimeout(300);
  await a.click('#btn-start');
  await expect.poll(async () => (await st(a)).me?.alive, { timeout: 3000 }).toBe(true);
  await expect(a.locator('#scr-loadout')).toBeHidden();
});
