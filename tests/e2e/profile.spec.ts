// Persistent profiles: identity survives closing the tab, a finished round pays XP, season points
// need a human opponent, extra tabs stay guests, and locked stickers are refused by the server.
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

const contexts: BrowserContext[] = [];
test.afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close();
});
test.skip(!!process.env.BASE_URL?.startsWith('https'), 'local only');
test.setTimeout(240_000);

async function ready(page: Page, query: string): Promise<void> {
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
  await page.goto(`/${query}`);
  await page.waitForSelector('#btn-tap:not(.hidden)', { timeout: 60_000 });
  await page.click('#btn-tap');
  await page.waitForSelector(query.includes('room=') ? '#scr-lobby:not(.hidden)' : '#scr-home:not(.hidden)', { timeout: 60_000 });
}

async function openClient(browser: Browser, query: string, name: string): Promise<{ page: Page; ctx: BrowserContext }> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  contexts.push(ctx);
  await ctx.addInitScript((n) => localStorage.setItem('tl:settings', JSON.stringify({ name: n })), name);
  const page = await ctx.newPage();
  await ready(page, query);
  return { page, ctx };
}

const myKey = (p: Page) => p.evaluate(() => (window as any).__tl.net.myKey as string);

test('the saved identity survives closing the tab, and a second tab plays as a guest', async ({ browser }) => {
  const { page: first, ctx } = await openClient(browser, '', 'Keeper');
  const key = await myKey(first);

  // A second tab while the first is open: its own identity, so both can play side by side.
  const second = await ctx.newPage();
  await ready(second, '');
  expect(await myKey(second), 'a second tab is a separate player').not.toBe(key);
  await second.close();

  // Close the tab that owns the identity and open a fresh one: same pilot.
  await first.close();
  const third = await ctx.newPage();
  await ready(third, '');
  expect(await myKey(third), 'the identity outlives the tab').toBe(key);
});

test('reopening the tab mid-match puts the player straight back in', async ({ browser }) => {
  const { page: host } = await openClient(browser, '?dev=1', 'Anchor');
  await host.click('#btn-create');
  await host.waitForSelector('#scr-lobby:not(.hidden)');
  await host.click('#seg-round [data-v="300"]');
  const code = (await host.textContent('#lobby-code'))!.trim();
  const { page: guest, ctx } = await openClient(browser, `?room=${code}&dev=1`, 'Wanderer');
  await expect(host.locator('#lobby-players li.pl')).toHaveCount(2);
  await host.click('#btn-start');
  await guest.waitForSelector('#scr-game:not(.hidden)');
  await guest.close();

  const back = await ctx.newPage();
  await back.goto('/?dev=1'); // no room code: the tab that knew it is gone
  await back.waitForSelector('#btn-tap:not(.hidden)', { timeout: 60_000 });
  await back.click('#btn-tap');
  await back.waitForSelector('#scr-game:not(.hidden)', { timeout: 15_000 });
  await expect.poll(() => host.evaluate(() => (window as any).__tl.game.allPlayers().find((p: any) => p.name === 'Wanderer')?.connected), { timeout: 8000 }).toBe(true);
});

test('a finished round pays XP and season points, and locked stickers are refused', async ({ browser }) => {
  // A real room (not dev): two minutes is the shortest round that counts.
  const { page: a } = await openClient(browser, '', 'Season One');
  await a.click('#btn-create');
  await a.waitForSelector('#scr-lobby:not(.hidden)');
  await a.click('#seg-round [data-v="120"]');
  const code = (await a.textContent('#lobby-code'))!.trim();
  const { page: b } = await openClient(browser, `?room=${code}`, 'Season Two');
  await expect(a.locator('#lobby-players li.pl')).toHaveCount(2);
  await a.waitForTimeout(400);
  await a.click('#btn-start');
  for (const p of [a, b]) await p.waitForSelector('#scr-game:not(.hidden)');

  // A brand-new pilot can use the first four stickers, not the rest; the server enforces it.
  const send = (i: number) => a.evaluate((n) => (window as any).__tl.net.conn.reducers.emote({ emote: n }).then(() => 'ok', (e: Error) => e.message), i);
  expect(await send(0)).toBe('ok');
  expect(await send(7)).toContain('level 5');

  await a.waitForSelector('#scr-board:not(.hidden)', { timeout: 135_000 });
  await a.locator('#btn-to-lobby').click();
  await a.waitForSelector('#scr-lobby:not(.hidden)');
  await a.locator('#btn-leave').click();
  await a.waitForSelector('#scr-home:not(.hidden)');

  // XP landed: both are human, so the round also counts for the season.
  await expect(a.locator('#profile-chip')).toBeVisible();
  await expect(a.locator('#pf-level')).toHaveText('LV 1');
  await a.click('#btn-season');
  await expect(a.locator('#season-table')).toBeVisible();
  // The board persists between runs, so it may already hold earlier pilots.
  const rows = a.locator('#season-body tr');
  await expect.poll(() => rows.count(), { timeout: 4000 }).toBeGreaterThanOrEqual(2);
  const total = await rows.count();
  if (total < 20) await expect(a.locator('#season-body tr.me')).toHaveCount(1);

  // A returning player's rows arrive while the page is still loading: nothing may be lost.
  await a.reload();
  await a.waitForSelector('#btn-tap:not(.hidden)', { timeout: 60_000 });
  await a.waitForTimeout(1500);
  await a.click('#btn-tap');
  await a.waitForSelector('#scr-home:not(.hidden)');
  await expect(a.locator('#profile-chip'), 'the level shows on a fresh page').toBeVisible();
  await a.click('#btn-season');
  await expect(rows).toHaveCount(total);
});
