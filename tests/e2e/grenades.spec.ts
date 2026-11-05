// Grenade types, against the real server:
//   - an impact grenade bursts on the first body it reaches, or on the floor;
//   - no grenade does more than 80, and they hurt the thrower too;
//   - the type is locked for a life and can be changed while respawning;
//   - an EMP stops flight for three seconds but not jumping, and the server enforces it.
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

const contexts: BrowserContext[] = [];
test.afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close();
});
test.skip(!!process.env.BASE_URL?.startsWith('https'), 'local only');
test.setTimeout(150_000);

const FRAG = 0;
const IMPACT = 1;
const EMP = 2;
const FLOOR_Y = 36 * 32;
const X = 23 * 32;

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
  return { hp: r.hp, alive: r.alive, nade: r.nade, correction: r.correction, deaths: r.deaths };
});
const pick = (p: Page, kind: number) => p.evaluate((k) => (window as any).__tl.net.conn.reducers.chooseGrenade({ kind: k }), kind);
const teleport = (p: Page, x: number, y: number) => p.evaluate(([tx, ty]) => (window as any).__tl.net.conn.reducers.devTeleport({ x: tx, y: ty }), [x, y]);
const aimAt = async (shooter: Page, name: string) => {
  const v = (await st(shooter)).remotes.find((r: any) => r.name === name);
  await shooter.mouse.move(v.sx, v.sy);
};

async function match(browser: Browser, nadeA: number): Promise<[Page, Page]> {
  const a = await openClient(browser, '?dev=1', 'Alpha');
  await a.click('#btn-create');
  await a.waitForSelector('#scr-lobby:not(.hidden)');
  await a.click('#seg-round [data-v="300"]');
  const code = (await a.textContent('#lobby-code'))!.trim();
  const b = await openClient(browser, `?room=${code}&dev=1`, 'Bravo');
  await expect(a.locator('#lobby-players li.pl')).toHaveCount(2);
  await pick(a, nadeA);
  await a.click('#btn-start');
  for (const p of [a, b]) await p.waitForSelector('#scr-game:not(.hidden)');
  for (const p of [a, b]) await expect.poll(async () => (await st(p)).me?.alive, { timeout: 12_000 }).toBe(true);
  await a.waitForTimeout(1700); // spawn protection
  await teleport(a, X, FLOOR_Y);
  await teleport(b, X + 220, FLOOR_Y);
  await a.waitForTimeout(600);
  return [a, b];
}

test('an impact grenade bursts on a body, hits hard, and never one-shots', async ({ browser }) => {
  const [a, b] = await match(browser, IMPACT);
  const booms = (await st(a)).booms;
  await aimAt(a, 'Bravo');
  const thrown = Date.now();
  await a.keyboard.press('KeyG');
  await expect.poll(async () => (await st(a)).booms, { timeout: 1500 }).toBeGreaterThan(booms);
  const took = Date.now() - thrown;
  await expect.poll(async () => (await row(b)).hp, { timeout: 2000 }).toBeLessThan(100);
  const hp = (await row(b)).hp;
  console.log(`impact burst after ${took} ms; Bravo at ${hp} HP`);
  expect(took, 'well before the fuse').toBeLessThan(1100);
  expect(hp, 'a direct hit is the full 80').toBeCloseTo(20, 0);
  expect((await row(b)).alive).toBe(true);
  expect((await row(a)).hp, 'the thrower was out of the blast').toBe(100);
});

test('an impact grenade bursts on the floor and hurts its thrower', async ({ browser }) => {
  const [a] = await match(browser, IMPACT);
  const me = (await st(a)).me;
  await a.mouse.move(me.sx, me.sy + 120);
  await a.keyboard.press('KeyG');
  await expect.poll(async () => (await row(a)).hp, { timeout: 1500 }).toBeLessThan(100);
  const hp = (await row(a)).hp;
  console.log(`thrower at ${hp} HP after a grenade at their feet`);
  expect(hp).toBeLessThan(60);
  expect(hp, 'not a one-shot').toBeGreaterThanOrEqual(20);
  expect((await row(a)).alive).toBe(true);
});

test('the grenade type is locked for a life and changes while respawning', async ({ browser }) => {
  const [a] = await match(browser, FRAG);
  await expect(pick(a, EMP), 'no swapping while alive').rejects.toThrow();
  expect((await row(a)).nade).toBe(FRAG);

  const deaths = (await row(a)).deaths;
  await teleport(a, 48 * 32, 38 * 32); // the acid
  await expect.poll(async () => (await row(a)).deaths, { timeout: 8000 }).toBe(deaths + 1);
  await expect(a.locator('#scr-respawn')).toBeVisible();
  await a.click('#scr-respawn .pick[data-n="2"]');
  await expect(a.locator('#scr-respawn .pick[data-n="2"]')).toHaveClass(/sel/);
  await expect.poll(async () => (await row(a)).nade, { timeout: 3000 }).toBe(EMP);
  await expect.poll(async () => (await row(a)).alive, { timeout: 8000 }).toBe(true);
  await expect(a.locator('#nade-count')).toContainText('EMP');
  expect((await st(a)).me.nade).toBe(EMP);
});

test('an EMP stops flight for three seconds but not jumping, and the server enforces it', async ({ browser }) => {
  const [a, b] = await match(browser, EMP);
  await aimAt(a, 'Bravo');
  await a.keyboard.press('KeyG');
  await expect.poll(async () => (await st(b)).me.emp, { timeout: 3000 }).toBe(true);
  await expect(b.locator('#fuel-text')).toContainText('OFF');
  expect((await row(b)).hp, 'an EMP does no damage').toBe(100);

  // Holding the jet key: one hop, then gravity.
  const y0 = (await st(b)).me.y;
  await b.keyboard.down('KeyW');
  let top = y0;
  for (let i = 0; i < 14; i++) {
    top = Math.min(top, (await st(b)).me.y);
    await b.waitForTimeout(100);
  }
  await b.keyboard.up('KeyW');
  console.log(`rose ${y0 - top} px while offline`);
  expect(y0 - top, 'the jump still works').toBeGreaterThan(30);
  expect(y0 - top, 'but it is only a jump').toBeLessThan(130);

  // It wears off.
  await expect.poll(async () => (await st(b)).me.emp, { timeout: 4000 }).toBe(false);
  await b.keyboard.down('KeyW');
  await b.waitForTimeout(900);
  await b.keyboard.up('KeyW');
  expect(y0 - (await st(b)).me.y, 'flying again').toBeGreaterThan(200);

  // A modified client ignores the EMP and flies anyway: the server snaps it back.
  await teleport(b, X + 220, FLOOR_Y);
  await b.waitForTimeout(1500);
  await a.waitForTimeout(6000); // the EMP cooldown
  await aimAt(a, 'Bravo');
  await a.keyboard.press('KeyG');
  await expect.poll(async () => (await st(b)).me.emp, { timeout: 3000 }).toBe(true);
  await b.waitForTimeout(500); // past the latency grace
  const before = (await row(b)).correction;
  await b.evaluate(() => {
    const l = (window as any).__tl.game.local;
    (window as any).__cheat = setInterval(() => { l.empUntilMs = 0; }, 5);
  });
  await b.keyboard.press('KeyW');
  await b.keyboard.down('KeyW');
  await b.waitForTimeout(1200);
  await b.keyboard.up('KeyW');
  await b.evaluate(() => clearInterval((window as any).__cheat));
  const server = await a.evaluate(() => {
    const g = (window as any).__tl.game;
    const r = g.debugState().remotes.find((q: any) => q.name === 'Bravo');
    return r.y as number;
  });
  const after = (await row(b)).correction;
  console.log(`cheater corrected ${after - before} times; others see them at y=${server}, floor ${FLOOR_Y}`);
  expect(after, 'moves were rejected').toBeGreaterThan(before);
  expect(FLOOR_Y - server, 'and nobody saw them fly').toBeLessThan(140);
});
