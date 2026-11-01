// Team matches, friendly fire, kicking, and the post-round return to the lobby.
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

const contexts: BrowserContext[] = [];
test.afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close();
});
test.skip(!!process.env.BASE_URL?.startsWith('https'), 'local only');
test.setTimeout(200_000);

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

const me = (p: Page) => p.evaluate(() => {
  const g = (window as any).__tl.game;
  return { team: g.localRow?.team as number, hp: g.localRow?.hp as number, alive: g.local?.alive as boolean, score: g.localRow?.score as number, hits: g.hitsDealt as number };
});
const teleport = (p: Page, x: number, y: number) => p.evaluate(([tx, ty]) => (window as any).__tl.net.conn.reducers.devTeleport({ x: tx, y: ty }), [x, y]);
const FLOOR = 36 * 32;

/** Host shoots the guest a few times from close range; returns hits the server confirmed. */
async function shootAt(host: Page, guest: Page): Promise<number> {
  const before = (await me(host)).hits;
  await teleport(host, 6 * 32 + 16, FLOOR);
  await teleport(guest, 12 * 32 + 16, FLOOR);
  await host.waitForTimeout(500);
  for (let i = 0; i < 6; i++) {
    const v = (await host.evaluate(() => (window as any).__tl.game.debugState())).remotes[0];
    await host.mouse.move(v.sx, v.sy);
    await host.mouse.down();
    await host.waitForTimeout(120);
    await host.mouse.up();
    await host.waitForTimeout(150);
  }
  await host.waitForTimeout(800);
  return (await me(host)).hits - before;
}

test('teams, friendly fire, kick and return to lobby', async ({ browser }) => {
  const host = await openClient(browser, '?dev=1', 'Leader');
  await host.click('#btn-create');
  await host.waitForSelector('#scr-lobby:not(.hidden)');
  const code = (await host.textContent('#lobby-code'))!.trim();
  const guest = await openClient(browser, `?room=${code}&dev=1`, 'Wing');

  // Switch to Red vs Blue: players are split into two teams.
  await host.click('#seg-teams [data-v="1"]');
  await expect(host.locator('#lobby-players .team-head')).toHaveCount(2);
  await expect.poll(async () => [(await me(host)).team, (await me(guest)).team].sort().join()).toBe('1,2');
  await expect(guest.locator('#btn-switch-team')).toBeVisible();

  // Put both on the same team (guest switches), friendly fire stays ON by default.
  const hostTeam = (await me(host)).team;
  if ((await me(guest)).team !== hostTeam) await guest.click('#btn-switch-team');
  await expect.poll(async () => (await me(guest)).team).toBe(hostTeam);
  await expect(host.locator('input[data-rule="friendlyFire"]')).toBeChecked();
  await host.click('#seg-round [data-v="30"]');
  await host.click('#btn-start');
  for (const p of [host, guest]) await p.waitForSelector('#scr-game:not(.hidden)');
  await expect.poll(async () => (await me(host)).alive && (await me(guest)).alive).toBe(true);
  await host.waitForTimeout(1700); // spawn protection
  const ffHits = await shootAt(host, guest);
  console.log(`friendly fire ON: hits on teammate = ${ffHits}`);
  expect(ffHits).toBeGreaterThan(0);

  // Round over: BOTH players see results, then BOTH return to the lobby automatically.
  for (const p of [host, guest]) await p.waitForSelector('#scr-board:not(.hidden)', { timeout: 40_000 });
  await expect(guest.locator('#lobby-countdown')).toContainText('lobby');
  for (const p of [host, guest]) await p.waitForSelector('#scr-lobby:not(.hidden)', { timeout: 20_000 });
  console.log('both players returned to the lobby');

  // Friendly fire OFF: shots pass through the teammate.
  await host.click('label.tog:has(input[data-rule="friendlyFire"])');
  await expect(guest.locator('input[data-rule="friendlyFire"]')).not.toBeChecked();
  await host.click('#btn-start');
  for (const p of [host, guest]) await p.waitForSelector('#scr-game:not(.hidden)');
  await expect.poll(async () => (await me(host)).alive && (await me(guest)).alive).toBe(true);
  await host.waitForTimeout(1700);
  const noFfHits = await shootAt(host, guest);
  console.log(`friendly fire OFF: hits on teammate = ${noFfHits}, teammate hp = ${(await me(guest)).hp}`);
  expect(noFfHits).toBe(0);
  expect((await me(guest)).hp).toBe(100);

  // Host can send everyone back to the lobby early, then kick the guest.
  await host.waitForSelector('#scr-board:not(.hidden)', { timeout: 40_000 });
  await host.click('#btn-to-lobby');
  for (const p of [host, guest]) await p.waitForSelector('#scr-lobby:not(.hidden)', { timeout: 10_000 });
  await host.locator('#lobby-players li.pl', { hasText: 'Wing' }).locator('button[data-act="kick"]').click();
  await guest.waitForSelector('#scr-home:not(.hidden)', { timeout: 10_000 });
  await expect(guest.locator('.toast')).toContainText('removed');
  await expect(host.locator('#lobby-players li.pl')).toHaveCount(1);
  // The kicked player can't come back into this room.
  await guest.fill('#in-code', code);
  await guest.click('#btn-join');
  await expect(guest.locator('.toast').last()).toContainText('removed you');
  await expect(guest.locator('#scr-home')).toBeVisible();
  console.log('kick works and blocks rejoining');
});
