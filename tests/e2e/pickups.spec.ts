// Acid hazard, pickups and respawn, with one client in a dev room.
import { test, expect, type BrowserContext } from '@playwright/test';

const contexts: BrowserContext[] = [];
test.afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close();
});

test.skip(!!process.env.BASE_URL?.startsWith('https'), 'local only');

test('acid burns, pickups heal and refill, death respawns', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  contexts.push(ctx);
  const page = await ctx.newPage();
  await page.goto('/?dev=1');
  await page.waitForSelector('#btn-tap:not(.hidden)', { timeout: 60_000 });
  await page.click('#btn-tap');
  await page.waitForSelector('#scr-home:not(.hidden)');
  await page.click('#btn-create');
  await page.waitForSelector('#scr-lobby:not(.hidden)');
  await page.click('#btn-start');
  await page.waitForSelector('#scr-game:not(.hidden)');

  const row = () => page.evaluate(() => {
    const g = (window as any).__tl.game;
    return { hp: g.localRow.hp as number, alive: g.localRow.alive as boolean, grenades: g.localRow.grenades as number, deaths: g.localRow.deaths as number, life: g.localRow.lifeId as number };
  });
  const teleport = (x: number, y: number) => page.evaluate(([tx, ty]) => (window as any).__tl.net.conn.reducers.devTeleport({ x: tx, y: ty }), [x, y]);
  await expect.poll(async () => (await row()).alive).toBe(true);

  // Acid: stand in the pit and lose HP (30 per second).
  await teleport(48 * 32, 38 * 32);
  await expect.poll(async () => (await row()).hp, { timeout: 5000 }).toBeLessThan(75);
  const burnt = (await row()).hp;
  console.log(`hp after standing in acid: ${burnt.toFixed(1)}`);

  // Health pack (H at tile 42,17 on the centre wing): +50 HP, capped at 100.
  await teleport(42 * 32 + 16, 18 * 32);
  await expect.poll(async () => (await row()).hp, { timeout: 3000 }).toBeGreaterThan(burnt + 20);
  console.log(`hp after health pack: ${(await row()).hp.toFixed(1)}`);

  // Grenade crate (G at tile 40,5): throw one frag first, then pick up +1.
  await page.mouse.move(900, 300);
  await page.keyboard.press('KeyG');
  await expect.poll(async () => (await row()).grenades, { timeout: 3000 }).toBe(1);
  await teleport(40 * 32 + 16, 6 * 32);
  await expect.poll(async () => (await row()).grenades, { timeout: 3000 }).toBe(2);
  console.log('grenade crate: +1');

  // Die in acid, then respawn 4 s later with a new life.
  const before = await row();
  await teleport(48 * 32, 38 * 32);
  await expect.poll(async () => (await row()).deaths, { timeout: 8000 }).toBe(before.deaths + 1);
  await expect(page.locator('#scr-respawn')).toBeVisible();
  await expect(page.locator('#killfeed li img[alt="acid"]').first()).toBeVisible();
  await expect.poll(async () => (await row()).alive, { timeout: 8000 }).toBe(true);
  expect((await row()).life).toBeGreaterThan(before.life);
  await expect(page.locator('#scr-respawn')).toBeHidden();
  console.log('acid death and respawn: ok');
});
