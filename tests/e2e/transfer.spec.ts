// Moving servers: progress imported from an old server waits in legacy_profile, and only the browser
// holding its transfer key can claim it, once. `scripts/move-data.mjs` writes the same rows.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

const contexts: BrowserContext[] = [];
test.afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close();
});
test.skip(!!process.env.BASE_URL?.startsWith('https'), 'local only');
test.setTimeout(60_000);

const sql = (query: string) => execFileSync('spacetime', ['sql', 'thrustline-dev', '--server', 'local', '--yes', query], { encoding: 'utf8' });

async function visit(browser: Browser, key: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  contexts.push(ctx);
  await ctx.addInitScript((k) => localStorage.setItem('tl:transfer', k), key);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
  await page.goto('/');
  await page.waitForSelector('#btn-tap:not(.hidden)', { timeout: 60_000 });
  await page.click('#btn-tap');
  await page.waitForSelector('#scr-home:not(.hidden)', { timeout: 30_000 });
  return page;
}

test('a browser claims its progress from the old server, once', async ({ browser }) => {
  const key = randomBytes(16).toString('hex');
  const season = 2026 * 12 + 10;
  sql(`INSERT INTO legacy_profile (key, name, xp, kills, deaths, wins, rounds, best_kills, season, season_score) VALUES ('${key}', 'Veteran', 1000, 50, 20, 9, 30, 12, ${season}, 400)`);
  expect(sql(`SELECT xp FROM legacy_profile WHERE key = '${key}'`)).toContain('1000');

  const owner = await visit(browser, key);
  await expect(owner.locator('#pf-level')).toHaveText('LV 4');
  expect(await owner.getAttribute('#profile-chip', 'title')).toContain('1000 XP');
  expect(sql(`SELECT xp FROM legacy_profile WHERE key = '${key}'`), 'the row is used up').not.toContain('1000');

  // The key stays registered for the next move, and cannot be claimed again by anyone else.
  expect(sql(`SELECT key FROM transfer_key WHERE key = '${key}'`)).toContain(key);
  const copycat = await visit(browser, key);
  await copycat.waitForTimeout(1200);
  await expect(copycat.locator('#profile-chip')).toBeHidden();
});

test('a browser with nothing waiting stays a fresh player, and bad keys are refused', async ({ browser }) => {
  const page = await visit(browser, randomBytes(16).toString('hex'));
  await page.waitForTimeout(800);
  await expect(page.locator('#profile-chip')).toBeHidden();
  await expect(page.evaluate(() => (window as any).__tl.net.conn.reducers.registerTransfer({ key: "x' OR 1=1" }))).rejects.toThrow();
});
