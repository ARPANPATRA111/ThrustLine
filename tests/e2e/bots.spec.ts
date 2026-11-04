// CPU players: the host adds two bots in the lobby; they join as real clients, move, fight,
// and appear on the leaderboard. Runs locally and against production.
import { test, expect, type BrowserContext } from '@playwright/test';

const contexts: BrowserContext[] = [];
test.afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close();
});

test('CPU players join, move and fight', async ({ browser }) => {
  test.setTimeout(150_000);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  contexts.push(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
  await page.goto('/?dev=1');
  await page.waitForSelector('#btn-tap:not(.hidden)', { timeout: 60_000 });
  await page.click('#btn-tap');
  await page.waitForSelector('#scr-home:not(.hidden)');
  await page.fill('#in-name', 'Human');
  await page.click('#btn-create');
  await page.waitForSelector('#scr-lobby:not(.hidden)');
  await page.click('#seg-round [data-v="30"]');
  await page.click('#btn-addbot');
  await expect(page.locator('#lobby-players li.pl')).toHaveCount(2, { timeout: 15_000 });
  await page.click('#btn-addbot');
  await expect(page.locator('#lobby-players li.pl')).toHaveCount(3, { timeout: 15_000 });
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
  // The mini leaderboard shows the room count and every row (four are visible on phones).
  await expect(page.locator('#mini-board .mb-count')).toHaveText('3 PLAYERS');
  await expect(page.locator('#mini-board .mb-row')).toHaveCount(3);
  await expect(page.locator('#mini-board .mb-lead')).toBeVisible();

  // Audio was unlocked by the first tap; a 30 s round is entirely Frenzy, so the Frenzy loop plays.
  const audio = await page.evaluate(() => ({ state: (window as any).__tl.audio.ctx.state, music: (window as any).__tl.audio.musicKind }));
  console.log(`audio: ${JSON.stringify(audio)}`);
  expect(audio.state).toBe('running');
  expect(audio.music).toBe('musicFrenzy');
  await expect(page.locator('#timer')).toContainText('FRENZY');

  // F3 toggles the debug overlay with FPS and the renderer name.
  await page.keyboard.press('F3');
  await expect(page.locator('#debug')).toBeVisible();
  await expect(page.locator('#debug')).toContainText(/FPS \d+/);
  await expect(page.locator('#debug')).toContainText(/Renderer (webgl|webgpu)/);
  console.log((await page.locator('#debug').innerText()).replace(/\n/g, ' | '));
  await page.keyboard.press('F3');

  // Bots can take a moment to receive their spawn row under load: poll for the same 20 px move.
  const start = await snap();
  const moved = new Set<string>();
  await expect.poll(async () => {
    const now = await snap();
    for (const bot of now.bots) {
      const prev = start.bots.find((q: any) => q.name === bot.name);
      if (prev && Math.hypot(bot.x - prev.x, bot.y - prev.y) > 20) moved.add(bot.name);
    }
    return moved.size;
  }, { timeout: 15_000, intervals: [1000] }).toBe(start.bots.length);
  // Within the round someone must take damage (bots shoot each other and the idle human).
  await expect.poll(async () => (await snap()).damage, { timeout: 25_000 }).toBeGreaterThan(0);
  console.log(`damage dealt so far: ${(await snap()).damage.toFixed(0)}`);
  await page.waitForSelector('#scr-board:not(.hidden)', { timeout: 40_000 });
  await expect(page.locator('#board-body tr')).toHaveCount(3);
  console.log(await page.locator('#board-body').innerText());
});
