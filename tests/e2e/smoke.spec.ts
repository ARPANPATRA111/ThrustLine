// Multi-client smoke test (brief section 12.3/12.4).
// Opens N browser contexts (separate sessionStorage = separate identities), creates a dev room
// with a 30 s round, joins by code, plays scripted inputs, forces a kill with devTeleport,
// and checks that every client sees movement, the kill and the round-end leaderboard.
// Local:      npx playwright test            (3 players, saves docs/screenshots/*)
// Production: BASE_URL=https://... PLAYERS=2 npx playwright test
import { test, expect, type Browser, type Page, type BrowserContext } from '@playwright/test';

const contexts: BrowserContext[] = [];
test.afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close();
});

const PLAYERS = Number(process.env.PLAYERS ?? 3);
const SHOTS = process.env.SCREENSHOTS !== '0' && !process.env.BASE_URL?.startsWith('https');
const SHOT_DIR = 'docs/screenshots';
const NAMES = ['Alpha', 'Bravo', 'Charlie', 'Delta'];

type DebugState = {
  room: { code: string; state: number } | null;
  me: { x: number; y: number; alive: boolean; sx: number; sy: number } | null;
  remotes: { name: string; alive: boolean; x: number; y: number; sx: number; sy: number }[];
  kills: number;
  renderer: string;
};

async function openClient(browser: Browser, query: string, viewport = { width: 1280, height: 720 }, mobile = false): Promise<Page> {
  const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile });
  contexts.push(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
  await page.goto(`/${query}`);
  await page.waitForSelector('#btn-tap:not(.hidden)', { timeout: 60_000 });
  await page.click('#btn-tap');
  await page.waitForSelector('#scr-home:not(.hidden)', { timeout: 60_000 });
  return page;
}

const state = (p: Page) => p.evaluate(() => (window as any).__tl.game.debugState() as DebugState);

test('rooms, movement, kills and round end across clients', async ({ browser }) => {
  // --- Host creates a dev room ---
  const host = await openClient(browser, '?dev=1');
  if (SHOTS) await host.screenshot({ path: `${SHOT_DIR}/home.png` });
  await host.fill('#in-name', NAMES[0]);
  await host.click('#btn-create');
  await host.waitForSelector('#scr-lobby:not(.hidden)');
  const code = (await host.textContent('#lobby-code'))!.trim();
  expect(code).toMatch(/^[A-Z]{4}$/);
  await host.selectOption('#sel-round', '30');

  // --- Others join by code ---
  const pages = [host];
  for (let i = 1; i < PLAYERS; i++) {
    const p = await openClient(browser, `?room=${code}&dev=1`);
    await expect(p.locator('#in-code')).toHaveValue(code);
    await p.fill('#in-name', NAMES[i]);
    await p.click('#btn-join');
    await p.waitForSelector('#scr-lobby:not(.hidden)');
    pages.push(p);
  }
  await expect(host.locator('#lobby-players li')).toHaveCount(PLAYERS);
  await expect(host.locator('#sel-round')).toHaveValue('30');
  if (SHOTS) await host.screenshot({ path: `${SHOT_DIR}/lobby.png` });

  // --- Start the round ---
  await host.click('#btn-start');
  for (const p of pages) await p.waitForSelector('#scr-game:not(.hidden)', { timeout: 15_000 });
  const s0 = await state(host);
  console.log(`renderer: ${s0.renderer}`);
  expect(['webgl', 'webgpu']).toContain(s0.renderer);

  // --- Scripted movement and fire on every client ---
  const before = await Promise.all(pages.map(state));
  await Promise.all(pages.map(async (p, i) => {
    await p.mouse.move(640 + (i % 2 ? -300 : 300), 300);
    await p.keyboard.down(i % 2 ? 'KeyA' : 'KeyD');
    await p.keyboard.down('KeyW');
    await p.waitForTimeout(500);
    await p.keyboard.up('KeyW');
    await p.mouse.down();
    await p.waitForTimeout(400);
    await p.mouse.up();
    await p.waitForTimeout(500);
    await p.keyboard.up(i % 2 ? 'KeyA' : 'KeyD');
  }));
  await host.waitForTimeout(800);
  const after = await Promise.all(pages.map(state));
  // Every client must see every other client's soldier move.
  for (let i = 0; i < pages.length; i++) {
    expect(after[i].remotes.length).toBe(PLAYERS - 1);
    for (const r of after[i].remotes) {
      const prev = before[i].remotes.find((q) => q.name === r.name)!;
      expect(Math.hypot(r.x - prev.x, r.y - prev.y), `${NAMES[i]} sees ${r.name} move`).toBeGreaterThan(5);
    }
  }

  // --- Face-off: teleport two players onto the ground floor and fire until a kill ---
  const shooter = pages[0];
  const victim = pages[1];
  const floorY = 36 * 32; // top of the ground floor
  await shooter.evaluate((y) => (window as any).__tl.net.conn.reducers.devTeleport({ x: 6 * 32 + 16, y }), floorY);
  await victim.evaluate((y) => (window as any).__tl.net.conn.reducers.devTeleport({ x: 12 * 32 + 16, y }), floorY);
  await shooter.waitForTimeout(2200); // let spawn protection expire and positions settle
  const victimName = NAMES[1];
  let killed = false;
  for (let i = 0; i < 60 && !killed; i++) {
    const s = await state(shooter);
    const v = s.remotes.find((r) => r.name === victimName);
    if (v && s.me) {
      await shooter.mouse.move(v.sx, v.sy);
      await shooter.mouse.down();
      await shooter.waitForTimeout(150);
      await shooter.mouse.up();
    }
    if (i === 3 && SHOTS) await shooter.screenshot({ path: `${SHOT_DIR}/gameplay.png` });
    killed = (await state(shooter)).kills > 0;
  }
  expect(killed, 'a kill registered').toBe(true);
  // The same kill must appear in every client's kill feed.
  await expect(shooter.locator('#killfeed li').first()).toBeVisible();
  // Newest row first (rows expire after 6 s, oldest first).
  const entry = (await shooter.locator('#killfeed li').first().innerText()).trim();
  console.log(`kill feed: ${entry}`);
  for (const p of pages) {
    await expect(p.locator('#killfeed li', { hasText: entry })).not.toHaveCount(0, { timeout: 5000 });
  }

  // --- Round end: leaderboard on every client ---
  for (const p of pages) {
    await p.waitForSelector('#scr-board:not(.hidden)', { timeout: 45_000 });
    await expect(p.locator('#board-title')).toHaveText('ROUND OVER');
    await expect(p.locator('#board-body tr')).toHaveCount(PLAYERS);
  }
  if (SHOTS) await host.screenshot({ path: `${SHOT_DIR}/round-end.png` });

  // --- Mobile screenshot: host plays again, a phone joins mid-round ---
  if (SHOTS) {
    await host.click('#btn-again');
    await host.waitForSelector('#scr-board', { state: 'hidden', timeout: 10_000 });
    const phone = await openClient(browser, `?room=${code}&dev=1`, { width: 844, height: 390 }, true);
    await phone.fill('#in-name', 'Phone');
    await phone.click('#btn-join');
    await phone.waitForSelector('#scr-game:not(.hidden)');
    await phone.waitForSelector('#scr-respawn', { state: 'hidden', timeout: 10_000 });
    // Put one thumb on each stick so the controls are visible in the screenshot.
    await phone.evaluate(() => {
      const el = document.getElementById('touch')!;
      const fire = (type: string, id: number, x: number, y: number) =>
        el.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, bubbles: true }));
      fire('pointerdown', 11, 130, 290);
      fire('pointermove', 11, 165, 270);
      fire('pointerdown', 12, 700, 280);
      fire('pointermove', 12, 730, 260);
    });
    await phone.waitForTimeout(600);
    await phone.screenshot({ path: `${SHOT_DIR}/gameplay-mobile.png` });
  }
});
