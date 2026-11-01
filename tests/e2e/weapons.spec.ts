// Weapons and modes (definition of done: "All four guns, the knife and frags work in Arms;
// Blades and Boom restrict loadouts correctly"). Two clients in a dev room, four 30 s rounds:
//   1. Arms with the shotgun: shotgun, pistol (Q swap), knife (F) and frag (G) all hit/explode.
//   2. Arms with the sniper: sniper hits.
//   3. Blades: only the knife; Q does nothing; G throws nothing; knife hits.
//   4. Boom: frags only; firing throws a grenade that explodes.
// (The AR is covered by smoke.spec.ts.)
import { test, expect, type Browser, type Page, type BrowserContext } from '@playwright/test';

const contexts: BrowserContext[] = [];
test.afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close();
});

test.skip(!!process.env.BASE_URL?.startsWith('https'), 'local only');
test.setTimeout(300_000);

const FLOOR_Y = 36 * 32;
const SHOOTER_X = 6 * 32 + 16;

async function openClient(browser: Browser, query: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  contexts.push(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
  await page.goto(`/${query}`);
  await page.waitForSelector('#btn-tap:not(.hidden)', { timeout: 60_000 });
  await page.click('#btn-tap');
  await page.waitForSelector(query.includes('room=') ? '#scr-lobby:not(.hidden)' : '#scr-home:not(.hidden)', { timeout: 60_000 });
  return page;
}

const st = (p: Page) => p.evaluate(() => (window as any).__tl.game.debugState());
const reducer = (p: Page, name: string, args: object) =>
  p.evaluate(([n, a]) => (window as any).__tl.net.conn.reducers[n as string](a), [name, args] as const);

const rules = (p: Page) => p.evaluate(() => (window as any).__tl.game.room.rules);

async function waitAlive(p: Page): Promise<void> {
  await expect.poll(async () => (await st(p)).me?.alive, { timeout: 15_000 }).toBe(true);
}

/** Put the shooter and victim on the ground floor `gap` px apart (both alive). */
async function faceOff(shooter: Page, victim: Page, gap: number): Promise<void> {
  await waitAlive(shooter);
  await waitAlive(victim);
  await reducer(shooter, 'devTeleport', { x: SHOOTER_X, y: FLOOR_Y });
  await reducer(victim, 'devTeleport', { x: SHOOTER_X + gap, y: FLOOR_Y });
  await shooter.waitForTimeout(600);
}

/** Aim at the victim as drawn on the shooter's screen. */
async function aimAtVictim(shooter: Page): Promise<void> {
  const s = await st(shooter);
  const v = s.remotes[0];
  await shooter.mouse.move(v.sx, v.sy);
}

/** Do `action` until the shooter's hit counter goes up (re-staging the face-off if needed). */
async function expectHit(shooter: Page, victim: Page, gap: number, action: () => Promise<void>, label: string): Promise<void> {
  const start = (await st(shooter)).hitsDealt;
  for (let i = 0; i < 8; i++) {
    await faceOff(shooter, victim, gap);
    await aimAtVictim(shooter);
    await action();
    try {
      await expect.poll(async () => (await st(shooter)).hitsDealt, { timeout: 1500 }).toBeGreaterThan(start);
      console.log(`${label}: hit`);
      return;
    } catch {
      const d = await shooter.evaluate(() => {
        const g = (window as any).__tl.game;
        return { w: g.local.weapon, mag: g.local.mag, pmag: g.local.pistolMag, srvMag: g.localRow.mag, alive: g.local.alive, x: g.local.body.x, rem: g.debugState().remotes, t: g.serverNow() - Number(g.localRow.spawnProtectUntilMicros) / 1000 };
      });
      console.log(`${label} retry ${i}: ${JSON.stringify(d)}`);
    }
  }
  throw new Error(`${label}: no hit registered`);
}

async function playRound(host: Page, pages: Page[]): Promise<void> {
  await host.evaluate(() => (window as any).__tl.net.conn.reducers.startRound({}));
  for (const p of pages) await p.waitForSelector('#scr-game:not(.hidden)');
  for (const p of pages) await expect.poll(async () => (await st(p)).room?.state).toBe(1);
}

async function waitRoundEnd(pages: Page[]): Promise<void> {
  for (const p of pages) await p.waitForSelector('#scr-board:not(.hidden)', { timeout: 45_000 });
}

test('every weapon works in Arms; Blades and Boom restrict loadouts', async ({ browser }) => {
  const a = await openClient(browser, '?dev=1');
  await a.fill('#in-name', 'Shooter');
  await a.click('#btn-create');
  await a.waitForSelector('#scr-lobby:not(.hidden)');
  const code = (await a.textContent('#lobby-code'))!.trim();
  await a.click('#seg-round [data-v="30"]');
  const b = await openClient(browser, `?room=${code}&dev=1`);
  await b.waitForSelector('#scr-lobby:not(.hidden)');
  const pages = [a, b];
  const click = async () => { await a.mouse.down(); await a.waitForTimeout(80); await a.mouse.up(); };

  // ---- Round 1: Arms, shotgun primary ----
  await reducer(a, 'choosePrimary', { weapon: 2 });
  await playRound(a, pages);
  await waitAlive(a);
  expect((await st(a)).me.weapon).toBe(2);
  await a.waitForTimeout(1600); // spawn protection
  await expectHit(a, b, 150, click, 'shotgun');
  await a.keyboard.press('KeyQ');
  await expect.poll(async () => (await st(a)).me.weapon).toBe(0);
  await expectHit(a, b, 192, click, 'pistol');
  await expectHit(a, b, 40, async () => { await a.keyboard.press('KeyF'); }, 'knife');
  const booms0 = (await st(a)).booms;
  await faceOff(a, b, 120);
  await aimAtVictim(a);
  await a.keyboard.press('KeyG');
  await expect.poll(async () => (await st(a)).booms, { timeout: 5000 }).toBeGreaterThan(booms0);
  console.log('frag: exploded');
  await waitRoundEnd(pages);

  // ---- Round 2: Arms, sniper primary ----
  await reducer(a, 'choosePrimary', { weapon: 3 });
  await playRound(a, pages);
  await waitAlive(a);
  expect((await st(a)).me.weapon).toBe(3);
  await a.waitForTimeout(1600);
  await expectHit(a, b, 250, click, 'sniper');
  await waitRoundEnd(pages);

  // ---- Round 3: Blades ----
  await reducer(a, 'updateRoomSettings', { mode: 1, roundSec: 30, rules: await rules(a) });
  await playRound(a, pages);
  await waitAlive(a);
  expect((await st(a)).mode).toBe(1);
  expect((await st(a)).me.weapon).toBe(4);
  await a.keyboard.press('KeyQ');
  await a.waitForTimeout(200);
  expect((await st(a)).me.weapon, 'Blades has no other weapon').toBe(4);
  await a.waitForTimeout(1400);
  const boomsBlades = (await st(a)).booms;
  await a.keyboard.press('KeyG');
  await expectHit(a, b, 40, click, 'blades knife');
  await a.waitForTimeout(2800);
  expect((await st(a)).booms, 'no grenades in Blades').toBe(boomsBlades);
  await waitRoundEnd(pages);

  // ---- Round 4: Boom ----
  await reducer(a, 'updateRoomSettings', { mode: 2, roundSec: 30, rules: await rules(a) });
  await playRound(a, pages);
  await waitAlive(a);
  expect((await st(a)).mode).toBe(2);
  expect((await st(a)).me.weapon).toBe(5);
  const booms1 = (await st(a)).booms;
  await faceOff(a, b, 140);
  await aimAtVictim(a);
  await click();
  await expect.poll(async () => (await st(a)).booms, { timeout: 5000 }).toBeGreaterThan(booms1);
  console.log('boom mode frag: exploded');
  await a.keyboard.press('KeyQ');
  await expect.poll(async () => (await st(a)).me.weapon).toBe(4); // knife backup
  await waitRoundEnd(pages);
});
