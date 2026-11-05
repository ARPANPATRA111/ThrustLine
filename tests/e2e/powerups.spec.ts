// Shield pickups and airdrops: the shield soaks damage before HP, a crate parachutes in, and the
// railgun fires exactly three shots through everyone on the line before handing back the primary.
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

const contexts: BrowserContext[] = [];
test.afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close();
});
test.skip(!!process.env.BASE_URL?.startsWith('https'), 'local only');
test.setTimeout(150_000);

const FLOOR_Y = 36 * 32;
const SHOOTER_X = 6 * 32 + 16;

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
const row = (p: Page) => p.evaluate(() => {
  const r = (window as any).__tl.game.localRow;
  return { hp: r.hp, shield: r.shield, power: r.power, weapon: r.weapon, alive: r.alive };
});
const teleport = (p: Page, x: number, y: number) => p.evaluate(([tx, ty]) => (window as any).__tl.net.conn.reducers.devTeleport({ x: tx, y: ty }), [x, y]);
const aimAt = async (shooter: Page, name: string) => {
  const v = (await st(shooter)).remotes.find((r: any) => r.name === name);
  await shooter.mouse.move(v.sx, v.sy);
};
const click = async (p: Page) => { await p.mouse.down(); await p.waitForTimeout(80); await p.mouse.up(); };

async function startMatch(browser: Browser, extra = 1): Promise<Page[]> {
  const a = await openClient(browser, '?dev=1', 'Alpha');
  await a.click('#btn-create');
  await a.waitForSelector('#scr-lobby:not(.hidden)');
  await a.click('#seg-round [data-v="300"]');
  const code = (await a.textContent('#lobby-code'))!.trim();
  const pages = [a];
  const names = ['Bravo', 'Charlie'];
  for (let i = 0; i < extra; i++) pages.push(await openClient(browser, `?room=${code}&dev=1`, names[i]));
  await expect(a.locator('#lobby-players li.pl')).toHaveCount(extra + 1);
  await a.evaluate(() => (window as any).__tl.net.conn.reducers.choosePrimary({ weapon: 3 })); // sniper
  await a.click('#btn-start');
  for (const p of pages) await p.waitForSelector('#scr-game:not(.hidden)');
  for (const p of pages) await expect.poll(async () => (await st(p)).me?.alive, { timeout: 8000 }).toBe(true);
  await a.waitForTimeout(1700); // spawn protection
  return pages;
}

test('a shield soaks damage before health', async ({ browser }) => {
  const [a, b] = await startMatch(browser);
  const before = await row(b);
  expect(before.shield).toBe(0);

  // Shield pickup on the upper-left platform.
  await teleport(b, 28 * 32 + 16, 9 * 32);
  await expect.poll(async () => (await row(b)).shield, { timeout: 4000 }).toBe(50);
  await expect(b.locator('#notice')).toContainText('SHIELD UP');

  // A 100-damage sniper shot: 50 goes into the shield, 50 into health, so the target lives.
  await teleport(a, SHOOTER_X, FLOOR_Y);
  await teleport(b, SHOOTER_X + 260, FLOOR_Y);
  await a.waitForTimeout(700);
  await aimAt(a, 'Bravo');
  await click(a);
  await expect.poll(async () => (await row(b)).shield, { timeout: 4000 }).toBe(0);
  const hurt = await row(b);
  expect(hurt.alive, 'a shield survives a one-shot weapon').toBe(true);
  expect(hurt.hp).toBeCloseTo(50, 0);
});

test('an airdrop lands, and its railgun pierces everyone on the line for three shots', async ({ browser }) => {
  const [a, b, c] = await startMatch(browser, 2);

  // Dev rooms announce the first crate 3 s in; it lands 4 s after that.
  await expect.poll(async () => (await st(a)).pickups.some((k: any) => k.kind === 4), { timeout: 9000 }).toBe(true);
  await expect.poll(async () => (await st(a)).pickups.find((k: any) => k.kind === 4)?.ready, { timeout: 8000 }).toBe(true);
  const crate = (await st(a)).pickups.find((k: any) => k.kind === 4);

  await teleport(a, (crate.tx + 0.5) * 32, (crate.ty + 1) * 32);
  await expect.poll(async () => (await row(a)).power, { timeout: 4000 }).toBe(3);
  await expect.poll(async () => (await st(a)).me.weapon).toBe(7);
  await expect.poll(async () => (await st(a)).pickups.some((k: any) => k.kind === 4), { timeout: 4000 }).toBe(false);

  // Line both targets up on the floor, one behind the other.
  await teleport(a, SHOOTER_X, FLOOR_Y);
  await teleport(b, SHOOTER_X + 200, FLOOR_Y);
  await teleport(c, SHOOTER_X + 300, FLOOR_Y);
  await a.waitForTimeout(800);
  const hits0 = (await st(a)).hitsDealt;
  await aimAt(a, 'Bravo');
  await click(a);
  await expect.poll(async () => (await st(a)).hitsDealt, { timeout: 4000 }).toBeGreaterThanOrEqual(hits0 + 2);
  expect((await row(b)).alive, 'first in line dies').toBe(false);
  expect((await row(c)).alive, 'second in line dies too').toBe(false);
  await expect.poll(async () => (await row(a)).power).toBe(2);

  // Two more shots, then the railgun is gone and the primary comes back.
  for (const left of [1, 0]) {
    await a.waitForTimeout(1250);
    await click(a);
    await expect.poll(async () => (await row(a)).power, { timeout: 3000 }).toBe(left);
  }
  await expect.poll(async () => (await st(a)).me.weapon, { timeout: 3000 }).toBe(3);
  await expect.poll(async () => (await row(a)).weapon, { timeout: 3000 }).toBe(3);
});
