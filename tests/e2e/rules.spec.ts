// House rules, set by the host in the lobby UI and enforced in play:
// infinite jetpack, infinite ammo, 200 HP, acid off, pickups off, Snipers mode.
// Also: invite links give clashing callsigns a unique suffix, ping is shown in the HUD,
// and the grenade button throws in Boom mode.
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

const contexts: BrowserContext[] = [];
test.afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close();
});
test.skip(!!process.env.BASE_URL?.startsWith('https'), 'local only');
test.setTimeout(180_000);

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

const g = (p: Page) => p.evaluate(() => {
  const game = (window as any).__tl.game;
  return {
    weapon: game.local?.weapon as number, fuel: game.local?.body.fuel as number, alive: game.local?.alive as boolean,
    hp: game.localRow?.hp as number, mag: game.localRow?.mag as number, mode: game.mode as number,
    hits: game.hitsDealt as number, booms: game.booms as number,
    pickupsVisible: [...game.pickups.values()].some((v: any) => v.sprite.visible),
  };
});
const teleport = (p: Page, x: number, y: number) => p.evaluate(([tx, ty]) => (window as any).__tl.net.conn.reducers.devTeleport({ x: tx, y: ty }), [x, y]);
const FLOOR = 36 * 32;

test('host rules are applied and enforced', async ({ browser }) => {
  const host = await openClient(browser, '?dev=1', 'Twin');
  await host.click('#btn-create');
  await host.waitForSelector('#scr-lobby:not(.hidden)');
  const code = (await host.textContent('#lobby-code'))!.trim();

  // A friend opens the invite link with the same callsign: the server makes it unique.
  const guest = await openClient(browser, `?room=${code}&dev=1`, 'Twin');
  await expect(host.locator('#lobby-players li.pl')).toHaveCount(2);
  await expect(host.locator('#lobby-players')).toContainText('Twin 2');

  // Host edits the match settings through the lobby UI.
  await host.click('#mode-cards [data-mode="3"]');
  await host.click('#seg-round [data-v="30"]');
  await host.click('#seg-hp [data-v="200"]');
  for (const rule of ['infiniteFuel', 'infiniteAmmo']) await host.click(`label.tog:has(input[data-rule="${rule}"])`);
  for (const rule of ['acid', 'pickups']) await host.click(`label.tog:has(input[data-rule="${rule}"])`);
  // The guest sees the same settings, read-only.
  await expect(guest.locator('#mode-cards [data-mode="3"]')).toHaveClass(/on/);
  await expect(guest.locator('#seg-hp [data-v="200"]')).toHaveClass(/on/);
  await expect(guest.locator('input[data-rule="infiniteAmmo"]')).toBeChecked();
  await expect(guest.locator('input[data-rule="acid"]')).not.toBeChecked();
  await expect(guest.locator('input[data-rule="infiniteFuel"]')).toBeDisabled();
  await expect(guest.locator('#btn-start')).toBeHidden();

  await host.click('#btn-start');
  for (const p of [host, guest]) await p.waitForSelector('#scr-game:not(.hidden)');
  await expect.poll(async () => (await g(host)).alive).toBe(true);
  let s = await g(host);
  expect(s.mode).toBe(3);
  expect(s.weapon, 'Snipers mode spawns with the rifle').toBe(3);
  expect(s.hp).toBe(200);
  await expect(host.locator('#hp-text')).toHaveText('200');
  expect(s.pickupsVisible, 'pickups hidden when off').toBe(false);

  // Snipers: swap goes rifle <-> knife only.
  await host.keyboard.press('KeyQ');
  await expect.poll(async () => (await g(host)).weapon).toBe(4);
  await host.keyboard.press('KeyQ');
  await expect.poll(async () => (await g(host)).weapon).toBe(3);

  // Infinite jetpack: fly for 3 s, fuel stays full.
  await host.keyboard.down('KeyW');
  await host.waitForTimeout(3000);
  await host.keyboard.up('KeyW');
  expect((await g(host)).fuel).toBe(100);
  await expect(host.locator('#fuel-text')).toHaveText('∞');

  // Acid off: standing in the pit does no damage.
  await teleport(host, 48 * 32, 38 * 32);
  await host.waitForTimeout(1500);
  expect((await g(host)).hp).toBe(200);

  // Infinite ammo: more sniper hits than one magazine (4), and the magazine never drops.
  await host.waitForTimeout(500);
  await teleport(host, 6 * 32 + 16, FLOOR);
  for (let i = 0; i < 7; i++) {
    await expect.poll(async () => (await g(guest)).alive, { timeout: 15_000 }).toBe(true);
    await teleport(guest, 14 * 32 + 16, FLOOR);
    await host.waitForTimeout(400);
    const v = (await host.evaluate(() => (window as any).__tl.game.debugState())).remotes[0];
    await host.mouse.move(v.sx, v.sy);
    await host.mouse.down();
    await host.waitForTimeout(80);
    await host.mouse.up();
    await host.waitForTimeout(950);
  }
  s = await g(host);
  console.log(`sniper hits with infinite ammo: ${s.hits}, server magazine: ${s.mag}`);
  expect(s.hits).toBeGreaterThan(4);
  expect(s.mag).toBe(4);
  await expect(host.locator('#ammo-mag')).toHaveText('∞');

  // Ping is shown in the HUD.
  await expect(host.locator('#net-ping b')).toHaveText(/^\d+$/);

  // Round over → host opens lobby settings, switches to Boom; the grenade BUTTON throws.
  await host.waitForSelector('#scr-board:not(.hidden)', { timeout: 40_000 });
  await host.click('#btn-end-lobby');
  await host.waitForSelector('#scr-lobby:not(.hidden)');
  await host.click('#mode-cards [data-mode="2"]');
  await expect(host.locator('#mode-cards [data-mode="2"]')).toHaveClass(/on/);
  await host.click('#btn-start');
  await host.waitForSelector('#scr-game:not(.hidden)');
  await expect.poll(async () => (await g(host)).alive).toBe(true);
  expect((await g(host)).weapon).toBe(5);
  const booms = (await g(host)).booms;
  await host.evaluate(() => (window as any).__tl.game.controls.press('grenade')); // what the NADE touch button does
  await expect.poll(async () => (await g(host)).booms, { timeout: 5000 }).toBeGreaterThan(booms);
  console.log('Boom mode: grenade button throws');
});
