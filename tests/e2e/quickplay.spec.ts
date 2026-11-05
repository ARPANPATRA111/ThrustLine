// Quick Play and reconnect grace.
//   - Two strangers press Quick Play and land in the same running room, topped up with CPUs.
//   - Rounds loop without a lobby.
//   - A dropped player keeps their stats and returns to the same match after a reload.
//   - A player who never comes back loses the slot when the grace period ends.
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

const contexts: BrowserContext[] = [];
test.afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close();
});
test.skip(!!process.env.BASE_URL?.startsWith('https'), 'local only');
test.setTimeout(150_000);

async function openClient(browser: Browser, query: string, name: string): Promise<{ page: Page; ctx: BrowserContext }> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  contexts.push(ctx);
  await ctx.addInitScript((n) => localStorage.setItem('tl:settings', JSON.stringify({ name: n })), name);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
  await page.goto(`/${query}`);
  await page.waitForSelector('#btn-tap:not(.hidden)', { timeout: 60_000 });
  await page.click('#btn-tap');
  await page.waitForSelector('#scr-home:not(.hidden), #scr-lobby:not(.hidden)', { timeout: 60_000 });
  return { page, ctx };
}

const roomOf = (p: Page) => p.evaluate(() => {
  const g = (window as any).__tl.game;
  return g.room ? { id: String(g.room.id), code: g.room.code, state: g.room.state, roundNo: g.room.roundNo, quick: g.room.quick } : null;
});
const roster = (p: Page) => p.evaluate(() => (window as any).__tl.game.allPlayers().map((q: any) => ({ name: q.name, bot: q.isBot, connected: q.connected, deaths: q.deaths, score: q.score, alive: q.alive })));
const teleport = (p: Page, x: number, y: number) => p.evaluate(([tx, ty]) => (window as any).__tl.net.conn.reducers.devTeleport({ x: tx, y: ty }), [x, y]);

test('Quick Play puts strangers in one running room and rounds loop', async ({ browser }) => {
  const a = (await openClient(browser, '?dev=1', 'Stranger A')).page;
  await a.click('#btn-quick');
  await a.waitForSelector('#scr-game:not(.hidden)', { timeout: 15_000 });
  const room = (await roomOf(a))!;
  expect(room.quick).toBe(true);
  await expect.poll(async () => (await roomOf(a))!.state, { message: 'no lobby: a round starts by itself', timeout: 4000 }).toBe(1);

  // Alone in the room, the host's client fills it with CPU players.
  await expect.poll(async () => (await roster(a)).length, { timeout: 20_000 }).toBe(4);

  const b = (await openClient(browser, '?dev=1', 'Stranger B')).page;
  await b.click('#btn-quick');
  await b.waitForSelector('#scr-game:not(.hidden)', { timeout: 15_000 });
  expect((await roomOf(b))!.id, 'the second stranger joins the same room').toBe(room.id);
  // The second human takes a CPU player's place.
  await expect.poll(async () => (await roster(a)).filter((p: any) => p.bot).length, { timeout: 15_000 }).toBe(2);

  // The round ends and the next one starts by itself, with no lobby in between.
  await a.waitForSelector('#scr-board:not(.hidden)', { timeout: 45_000 });
  await expect(a.locator('#btn-to-lobby')).toBeHidden();
  await expect(a.locator('#lobby-countdown')).toContainText('Next round');
  await expect.poll(async () => (await roomOf(b))?.roundNo, { timeout: 25_000 }).toBe(room.roundNo + 1);
  await expect(a.locator('#scr-lobby')).toBeHidden();
  expect((await roomOf(a))!.state).toBe(1);
});

test('a dropped player keeps their stats and comes back to the same match', async ({ browser }) => {
  const host = (await openClient(browser, '?dev=1', 'Keeper')).page;
  await host.click('#btn-create');
  await host.waitForSelector('#scr-lobby:not(.hidden)');
  await host.click('#seg-round [data-v="300"]');
  const code = (await host.textContent('#lobby-code'))!.trim();
  const guest = (await openClient(browser, `?room=${code}&dev=1`, 'Flaky')).page;
  await expect(host.locator('#lobby-players li.pl')).toHaveCount(2);
  await host.click('#btn-start');
  for (const p of [host, guest]) await p.waitForSelector('#scr-game:not(.hidden)');
  await expect.poll(async () => (await roster(guest)).every((p: any) => p.alive), { timeout: 8000 }).toBe(true);

  // Die once so there is something to keep.
  await teleport(guest, 48 * 32, 38 * 32);
  await expect.poll(async () => (await roster(host)).find((p: any) => p.name === 'Flaky')?.deaths, { timeout: 12_000 }).toBe(1);
  await expect.poll(async () => (await roster(host)).find((p: any) => p.name === 'Flaky')?.alive, { timeout: 9000 }).toBe(true);

  // Reloading drops the connection: the host sees the player held, out of the world.
  await guest.close({ runBeforeUnload: false }).catch(() => {});
  await expect.poll(async () => (await roster(host)).find((p: any) => p.name === 'Flaky')?.connected, { timeout: 8000 }).toBe(false);
  const held = (await roster(host)).find((p: any) => p.name === 'Flaky');
  expect(held.alive, 'a dropped soldier leaves the world').toBe(false);
  expect(held.deaths).toBe(1);
  await expect(host.locator('#mini-board')).toContainText('LOST');

  // Nobody came back: the grace period ends (15 s in dev rooms) and the slot frees up.
  await expect.poll(async () => (await roster(host)).some((p: any) => p.name === 'Flaky'), { timeout: 20_000 }).toBe(false);
});

test('reloading the page rejoins the match with stats intact', async ({ browser }) => {
  const host = (await openClient(browser, '?dev=1', 'Anchor')).page;
  await host.click('#btn-create');
  await host.waitForSelector('#scr-lobby:not(.hidden)');
  await host.click('#seg-round [data-v="300"]');
  const code = (await host.textContent('#lobby-code'))!.trim();
  const guest = (await openClient(browser, `?room=${code}&dev=1`, 'Reloader')).page;
  await expect(host.locator('#lobby-players li.pl')).toHaveCount(2);
  await host.click('#btn-start');
  for (const p of [host, guest]) await p.waitForSelector('#scr-game:not(.hidden)');
  await expect.poll(async () => (await roster(guest)).every((p: any) => p.alive), { timeout: 8000 }).toBe(true);
  await teleport(guest, 48 * 32, 38 * 32);
  await expect.poll(async () => (await roster(host)).find((p: any) => p.name === 'Reloader')?.deaths, { timeout: 12_000 }).toBe(1);

  await guest.reload();
  await guest.waitForSelector('#btn-tap:not(.hidden)', { timeout: 60_000 });
  await guest.click('#btn-tap');
  await guest.waitForSelector('#scr-game:not(.hidden)', { timeout: 15_000 });
  await expect.poll(async () => {
    const me = (await roster(host)).find((p: any) => p.name === 'Reloader');
    return me && me.connected && me.alive;
  }, { timeout: 12_000 }).toBe(true);
  expect((await roster(host)).find((p: any) => p.name === 'Reloader')?.deaths, 'stats survive the reload').toBe(1);
});
