// Capture the Flag, against the real server:
//   - choosing it puts the room on teams, and each team spawns at its own base;
//   - touching the enemy flag carries it, and reaching your own stand scores;
//   - a carrier who dies drops it, and it can be returned or goes home by itself;
//   - the first team to three captures ends the round;
//   - CPU players can play it without any help.
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

const contexts: BrowserContext[] = [];
test.afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close();
});
test.skip(!!process.env.BASE_URL?.startsWith('https'), 'local only');
test.setTimeout(170_000);

const HOME = 0;
const CARRIED = 1;
const DROPPED = 2;
const RED = 1;
const BLUE = 2;
// RIG-7's flag stands.
const FLOOR = 28 * 32;
const RED_FLAG = (3 + 0.5) * 32;
const BLUE_FLAG = (92 + 0.5) * 32;

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
const me = (p: Page) => p.evaluate(() => {
  const r = (window as any).__tl.game.localRow;
  return { team: r.team, score: r.score, alive: r.alive, deaths: r.deaths };
});
const flag = async (p: Page, team: number) => (await st(p)).flags.find((f: any) => f.team === team);
const teleport = (p: Page, x: number, y: number) => p.evaluate(([tx, ty]) => (window as any).__tl.net.conn.reducers.devTeleport({ x: tx, y: ty }), [x, y]);

/** Two humans on opposite teams in a running flag round. Returns [red player, blue player]. */
async function match(browser: Browser): Promise<[Page, Page]> {
  const a = await openClient(browser, '?dev=1', 'Alpha');
  await a.click('#btn-create');
  await a.waitForSelector('#scr-lobby:not(.hidden)');
  await a.click('#seg-round [data-v="300"]');
  const code = (await a.textContent('#lobby-code'))!.trim();
  const b = await openClient(browser, `?room=${code}&dev=1`, 'Bravo');
  await expect(a.locator('#lobby-players li.pl')).toHaveCount(2);

  await a.click('#seg-objective [data-v="2"]');
  await expect(a.locator('#seg-teams [data-v="1"]'), 'the flag means teams').toHaveClass(/on/);
  await expect(b.locator('#seg-objective [data-v="2"]')).toHaveClass(/on/);
  await a.click('#btn-start');
  for (const p of [a, b]) await p.waitForSelector('#scr-game:not(.hidden)');
  for (const p of [a, b]) await expect.poll(async () => (await st(p)).me?.alive, { timeout: 8000 }).toBe(true);
  await expect.poll(async () => (await st(a)).flags.length).toBe(2);
  const red = (await me(a)).team === RED ? a : b;
  return red === a ? [a, b] : [b, a];
}

test('each team spawns at home, and carrying the flag home scores', async ({ browser }) => {
  const [red, blue] = await match(browser);
  expect((await me(red)).team).toBe(RED);
  expect((await me(blue)).team).toBe(BLUE);
  expect((await st(red)).me.x, 'red starts at the left base').toBeLessThan(13 * 32);
  expect((await st(blue)).me.x, 'blue starts at the right base').toBeGreaterThan(83 * 32);
  await expect(red.locator('#hill-chip')).toContainText('ENEMY FLAG');

  // Touching the enemy flag picks it up, with nothing to press.
  await teleport(red, BLUE_FLAG, FLOOR);
  await expect.poll(async () => (await flag(red, BLUE)).state, { timeout: 3000 }).toBe(CARRIED);
  await expect(red.locator('#hill-chip')).toContainText('YOU HAVE THE FLAG');
  await expect(blue.locator('#hill-chip')).toContainText('YOUR FLAG IS TAKEN');

  // Your own flag does nothing for you: only the stand scores.
  const before = (await me(red)).score;
  await teleport(red, RED_FLAG, FLOOR);
  await expect.poll(async () => (await flag(red, RED)).caps, { timeout: 3000 }).toBe(1);
  expect((await me(red)).score, 'a capture pays').toBe(before + 300);
  await expect.poll(async () => (await flag(red, BLUE)).state).toBe(HOME);
  await expect(red.locator('#team-score .red')).toContainText('1');
});

test('a dropped flag can be returned, and goes home by itself', async ({ browser }) => {
  const [red, blue] = await match(browser);
  const carry = async () => {
    await teleport(red, BLUE_FLAG, FLOOR);
    await expect.poll(async () => (await flag(red, BLUE)).state, { timeout: 3000 }).toBe(CARRIED);
  };
  const dieOnThePlatform = async () => {
    // Carried to the middle of the map and dropped in the acid: straight home.
    await teleport(red, 48 * 32, 38 * 32);
    await expect.poll(async () => (await flag(red, BLUE)).state, { timeout: 8000 }).not.toBe(CARRIED);
  };

  // Lost in the acid, a flag goes straight home.
  await carry();
  await dieOnThePlatform();
  expect((await flag(red, BLUE)).state, 'nothing rests in the acid').toBe(HOME);
  await expect.poll(async () => (await me(red)).alive, { timeout: 10_000 }).toBe(true);

  // Blue shoots the carrier on solid ground: the flag falls where they died.
  await carry();
  const spot = { x: 57 * 32, y: 36 * 32 };
  await teleport(red, spot.x, spot.y);
  await red.waitForTimeout(400);
  await teleport(blue, spot.x + 90, spot.y);
  await blue.waitForTimeout(1800); // spawn protection
  const target = (await st(blue)).remotes.find((r: any) => r.name === 'Alpha');
  await blue.mouse.move(target.sx, target.sy);
  await blue.mouse.down();
  await expect.poll(async () => (await flag(blue, BLUE)).state, { timeout: 12_000 }).toBe(DROPPED);
  await blue.mouse.up();
  const dropped = await flag(blue, BLUE);
  expect(Math.abs(dropped.x - spot.x), 'where they died').toBeLessThan(100);
  expect(dropped.y, 'on the floor').toBe(36 * 32);

  // Blue touches it: back home, and a bonus.
  const score = (await me(blue)).score;
  await teleport(blue, dropped.x, dropped.y);
  await expect.poll(async () => (await flag(blue, BLUE)).state, { timeout: 3000 }).toBe(HOME);
  expect((await me(blue)).score, 'returning pays').toBeGreaterThanOrEqual(score + 50);

  // Left alone, it walks home after five seconds (fifteen outside dev rooms).
  await expect.poll(async () => (await me(red)).alive, { timeout: 10_000 }).toBe(true);
  await carry();
  await teleport(red, spot.x, spot.y);
  await red.waitForTimeout(300);
  await teleport(blue, spot.x + 90, spot.y);
  await blue.waitForTimeout(1800);
  const again = (await st(blue)).remotes.find((r: any) => r.name === 'Alpha');
  await blue.mouse.move(again.sx, again.sy);
  await blue.mouse.down();
  await expect.poll(async () => (await flag(blue, BLUE)).state, { timeout: 12_000 }).toBe(DROPPED);
  await blue.mouse.up();
  await teleport(blue, 70 * 32, 36 * 32); // well clear of it
  const left = Date.now();
  await expect.poll(async () => (await flag(blue, BLUE)).state, { timeout: 8000 }).toBe(HOME);
  console.log(`dropped flag went home after ${Date.now() - left} ms`);
});

test('three captures win the round, and the next round has fresh flags', async ({ browser }) => {
  const [red, blue] = await match(browser);
  for (let i = 1; i <= 3; i++) {
    await teleport(red, BLUE_FLAG, FLOOR);
    await expect.poll(async () => (await flag(red, BLUE)).state, { timeout: 3000 }).toBe(CARRIED);
    await teleport(red, RED_FLAG, FLOOR);
    await expect.poll(async () => (await flag(red, RED)).caps, { timeout: 3000 }).toBe(i);
  }
  for (const p of [red, blue]) await expect(p.locator('#scr-board')).toBeVisible({ timeout: 4000 });
  await expect(red.locator('#winner-name')).toContainText('RED TEAM WINS');
  await expect(red.locator('#winner-name')).toContainText('3');
  await expect(red.locator('#winner-name')).toContainText('VICTORY');
  await expect(blue.locator('#winner-name')).not.toContainText('VICTORY');

  // Playing again in the same room replaces both flags. Their rows can reach a client in any order.
  const host = await red.evaluate(() => (window as any).__tl.game.room.hostIdentity.isEqual((window as any).__tl.net.identity)) ? red : blue;
  await host.click('#btn-again');
  for (const p of [red, blue]) {
    await expect.poll(async () => (await st(p)).room?.state, { timeout: 8000 }).toBe(1);
    await expect.poll(async () => (await st(p)).flags.map((f: any) => f.caps), { timeout: 4000 }).toEqual([0, 0]);
  }
  await expect(red.locator('#hill-chip')).toContainText('ENEMY FLAG');
});

// Every map must be playable by CPU players. Taking a flag is the bar: on the slow test renderer a
// full capture can take minutes, and the capture rule itself is covered by the tests above.
for (const [mapId, mapName] of [[0, 'RIG-7'], [1, 'HELIOS-9'], [2, 'KILN-3'], [3, 'SKYREACH'], [4, 'CRYO-12']] as const) test(`CPU players reach the flag on their own on ${mapName}`, async ({ browser }) => {
  const a = await openClient(browser, '?dev=1', 'Alpha');
  await a.click('#btn-create');
  await a.waitForSelector('#scr-lobby:not(.hidden)');
  await a.click('#seg-round [data-v="300"]');
  await a.click(`#seg-map [data-v="${mapId}"]`);
  await a.click('#seg-objective [data-v="2"]');
  await expect(a.locator('#seg-teams [data-v="1"]')).toHaveClass(/on/);
  for (let i = 0; i < 5; i++) {
    await a.click('#btn-addbot');
    await expect(a.locator('#lobby-players li.pl')).toHaveCount(i + 2, { timeout: 8000 });
  }
  await a.click('#btn-start');
  await a.waitForSelector('#scr-game:not(.hidden)');
  await expect.poll(async () => (await st(a)).flags.length, { timeout: 8000 }).toBe(2);
  // Watching only: this player stays put while the bots play.
  const began = Date.now();
  await expect.poll(async () => (await st(a)).flags.some((q: any) => q.state === CARRIED || q.caps > 0), { timeout: 120_000, intervals: [500] }).toBe(true);
  const f = (await st(a)).flags;
  console.log(mapName, 'captures', f.map((q: any) => `${q.team}:${q.caps}`).join(' '), 'in', Math.round((Date.now() - began) / 1000), 's');
});
