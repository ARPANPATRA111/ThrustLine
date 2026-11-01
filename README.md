# THRUSTLINE

A side-view jetpack free-for-all for 1–6 players, playable in the browser on phones and laptops.
Riggers, jetpack contractors, fight over **RIG-7**, an abandoned sky refinery above an acid sea.

**Play:** https://thrustline-drab.vercel.app · **Database:** SpacetimeDB Maincloud, `thrustline-zhtm`

Open the link, type a nickname, create a room and share its 4-letter code (or the link). No accounts:
closing the tab removes you. Playing alone? Press **+ Add CPU** in the lobby to add computer opponents.

![Gameplay](docs/screenshots/gameplay.png)

## How to play

Most score when the timer runs out wins.

| Event | Score |
| --- | --- |
| Kill | +100 |
| Kill a **bounty** target (a player on a 3-kill streak, glowing gold with a crown) | +50 extra |
| Die to acid or your own grenade | −50 |

Leaderboard order: score, then kills, then fewer deaths. HP is 100 with no regeneration; you respawn
4 s after dying with 1.5 s of spawn protection (a bubble; it ends early if you attack).

### Controls

| Action | Keyboard & mouse | Touch (landscape) |
| --- | --- | --- |
| Move | A / D | Left stick (appears where your thumb lands, left 40 % of screen) |
| Thrust (tap = hop, hold = fly) | W or Space | Push the left stick up |
| Drop through a platform | S | Push the left stick down |
| Aim | Mouse | Right stick direction |
| Fire | Left click (hold for AR) | Push the right stick past 60 % |
| Knife | Right click or F | KNIFE button |
| Grenade | G | NADE button |
| Swap weapon | Q | SWAP button |
| Reload | R | RELOAD button |
| Scoreboard | Hold Tab | Tap the mini leaderboard |
| Menu / debug overlay | Esc / F3 | ≡ button / Settings |

### Modes (host chooses in the lobby)

| Mode | Loadout | Pickups |
| --- | --- | --- |
| **Arms** (default) | Pistol, one primary (AR, shotgun or sniper, picked on the respawn screen), knife, 2 frags | Health, ammo, grenade |
| **Blades** | Knife only, +15 % run speed | Health |
| **Boom** | Unlimited frags (1 s cooldown, max 2 live), knife backup | Health |

Round length: 3, 5 or 8 minutes (rooms opened with `?dev=1` also offer 30 s). The host's **Play again**
resets stats and starts a new round in the same room.

### Weapons

| Weapon | Damage | Rate | Mag / reserve | Notes |
| --- | --- | --- | --- | --- |
| Pistol | 18 | 4/s | 12 / ∞ | Always carried |
| AR | 11 | 10/s | 30 / 120 | Automatic; spread grows while moving |
| Shotgun | 7 × 9 | 1.1/s | 6 / 24 | Falls off past 180 px; recoil throws you back (blast-jumping) |
| Sniper | 85 | 0.8/s | 4 / 16 | Pinpoint while still; camera leads 320 px |
| Knife | 55 | 2/s | — | Short lunge |
| Frag | up to 90 | — | 2 per life | 2.5 s fuse, bounces, knockback, half damage to yourself |

## What makes it THRUSTLINE (customisation)

- **Jetpack fuel:** 100 fuel, ~2.6 s of flight, refills after 0.4 s on the ground. Tap for a hop, hold to fly.
- **Blast-jumping:** shotgun recoil (520) and grenade knockback (650) push you; chain them with the jetpack to move fast.
- **Bounty:** a 3-kill streak makes you glow gold and worth +50 to whoever stops you.
- **Frenzy:** the last 60 s: damage ×1.5, fuel refills twice as fast, red edge tint, FRENZY banner, faster music.
- **Modes:** Arms, Blades and Boom change the whole loadout.
- **Acid hazard:** the pit in the middle burns 30 HP/s while you're in it. You can fly out.
- **Smart spawns:** never within 200 px of where you died, preferring points far from living enemies.
- **CPU players:** computer opponents that join as real clients and obey the same server rules.

Every number lives in [server/src/shared/config.ts](server/src/shared/config.ts) and [server/src/shared/weapons.ts](server/src/shared/weapons.ts).

## Run locally

Requirements: Node 20+, the [SpacetimeDB CLI](https://spacetimedb.com/install) (2.14+).

```bash
npm install
spacetime start                      # local database server on :3000 (leave running)
npm run publish:local                # publish the module as "thrustline-dev"
npm run gen                          # regenerate client bindings (only after schema changes)
npm run dev                          # Vite on http://localhost:5173
```

Open several tabs: each tab is a separate player (the identity token lives in `sessionStorage`).

Checks:

```bash
npm run typecheck                    # strict TypeScript, server + client
npm test                             # Vitest unit tests for the shared simulation
npx playwright install chromium      # once
npm run e2e                          # multi-client browser tests against the local dev server
BASE_URL=https://thrustline-drab.vercel.app PLAYERS=2 npx playwright test smoke bots   # production
```

## Deploy

```bash
spacetime login                      # once (browser)
vercel login                         # once
npm run deploy                       # typecheck, tests, generate, publish to Maincloud, build, vercel --prod
```

`npm run deploy` publishes the module to the database named in `client/.env.production` and deploys
the client from the repo root (see `vercel.json`). If a schema change is incompatible, run
`npm run publish:cloud -- --delete-data` once (all match data is disposable).

### Offline LAN fallback

No internet? One laptop hosts everything on the same Wi-Fi (or a phone hotspot, laptop as host):

```bash
spacetime start
npm run publish:local
cd client
VITE_STDB_URI=ws://<laptop-ip>:3000 VITE_STDB_DB=thrustline-dev npx vite build
npx vite preview --host              # players open http://<laptop-ip>:4173
```

That page isn't a secure context, so WebGPU is unavailable and PixiJS uses WebGL.

## Architecture

Each browser simulates its own soldier with the shared physics at a fixed 60 Hz and sends one `sync`
reducer call every 50 ms (200 ms when idle) with its position and any shots, knife swings or throws.
The SpacetimeDB module is the referee: it validates movement (no teleports, no walls), validates hit
claims with tolerances that favour the shooter, and owns everything that decides the match (HP, kills,
score, ammo, pickups, grenades, spawns, the clock). There is no server tick: respawns, round end,
grenade fuses and pickup timers are one-shot scheduled reducers. Clients subscribe only to their room;
other players are drawn 100 ms in the past and interpolated, and transient effects (shots, hits, kills,
explosions) arrive through event tables. Grenades follow a deterministic simulation that server and
clients run on the same stored inputs, so they explode exactly where they are drawn.

```text
server/src/index.ts        tables, reducers, scheduled jobs, event tables (the referee)
server/src/shared/         physics, map, raycasts, grenades, spawns, validation, config (server AND client)
client/src/net/            connection, subscriptions, clock sync, interpolation buffers
client/src/game/           fixed-step loop, local player (Actor), camera, input, CPU bots
client/src/render/         generated atlas, baked map, soldier animation, particles, effects
client/src/audio/          synthesised sounds and music, mixer
client/src/ui/             HUD, touch controls, settings
tests/e2e/                 Playwright multi-client tests
docs/                      ALGORITHMS.md, LAB_MAPPING.md, screenshots/
```

More detail: [docs/ALGORITHMS.md](docs/ALGORITHMS.md) · Lab requirements: [docs/LAB_MAPPING.md](docs/LAB_MAPPING.md) · Deviations: [DECISIONS.md](DECISIONS.md)

## Stack

| Layer | Choice | Why |
| --- | --- | --- |
| Language | TypeScript (strict) | One language for client, server and the shared simulation |
| Client build | Vite | Fast dev server; static `dist/` that Vercel hosts directly |
| Rendering | PixiJS v8 (WebGPU → WebGL) | Batched sprites from one atlas; WebGPU where available |
| UI | Plain DOM + CSS | Crisp text, tiny bundle, no per-frame virtual DOM |
| Audio | Web Audio API | Low latency; every sound synthesised in code |
| Backend | SpacetimeDB 2.14 TypeScript module | Tables, reducers, subscriptions and scheduling in one place |
| Client SDK | `spacetimedb` npm package | Typed bindings generated from the module |
| Tests | Vitest + Playwright | Unit tests for the simulation; real multi-browser games end to end |
| Hosting | Vercel + SpacetimeDB Maincloud | Static client on a CDN; managed database |

All art and sound are generated in code at load: nothing is downloaded. The whole client is about
230 KB of gzipped JavaScript.
