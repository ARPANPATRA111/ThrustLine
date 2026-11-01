// CPU players: the host adds two bots in the lobby; they join as real clients, move, fight,
// and appear on the leaderboard. Runs locally and against production.
import { test, expect } from '@playwright/test';

test('CPU players join, move and fight', async ({ browser }) => {
  test.setTimeout(150_000);
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
  await page.goto('/?dev=1');
  await page.waitForSelector('#btn-tap:not(.hidden)', { timeout: 60_000 });
  await page.click('#btn-tap');
  await page.waitForSelector('#scr-home:not(.hidden)');
  await page.fill('#in-name', 'Human');
  await page.click('#btn-create');
  await page.waitForSelector('#scr-lobby:not(.hidden)');
  await page.selectOption('#sel-round', '30');
  await page.click('#btn-addbot');
  await expect(page.locator('#lobby-players li')).toHaveCount(2, { timeout: 15_000 });
  await page.click('#btn-addbot');
  await expect(page.locator('#lobby-players li')).toHaveCount(3, { timeout: 15_000 });
  await expect(page.locator('#lobby-players .cpu-tag')).toHaveCount(2);
  await page.click('#btn-start');
  await page.waitForSelector('#scr-game:not(.hidden)');

  const snap = () => page.evaluate(() => {
    const g = (window as any).__tl.game;
    return {
      bots: g.debugState().remotes.map((r: any) => ({ name: r.name, x: r.x, y: r.y })),
      damage: g.allPlayers().reduce((n: number, p: any) => n + (100 - (p.alive ? p.hp : 0)) + p.deaths * 100, 0),
    };
  });
  await page.waitForTimeout(2500);
  const a = await snap();
  await page.waitForTimeout(4000);
  const b = await snap();
  for (const bot of b.bots) {
    const prev = a.bots.find((q: any) => q.name === bot.name);
    expect(Math.hypot(bot.x - prev.x, bot.y - prev.y), `${bot.name} moves`).toBeGreaterThan(20);
  }
  // Within the round someone must take damage (bots shoot each other and the idle human).
  await expect.poll(async () => (await snap()).damage, { timeout: 25_000 }).toBeGreaterThan(0);
  console.log(`damage dealt so far: ${(await snap()).damage.toFixed(0)}`);
  await page.waitForSelector('#scr-board:not(.hidden)', { timeout: 40_000 });
  await expect(page.locator('#board-body tr')).toHaveCount(3);
  console.log(await page.locator('#board-body').innerText());
});
