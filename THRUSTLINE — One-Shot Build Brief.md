# THRUSTLINE — One-Shot Build Brief

Oct 31, 2026 · @Arpan

## 1. How to use this brief

You are a coding agent running on the developer's laptop. Build THRUSTLINE from an empty folder to a deployed, playable web game in one continuous session, using this document as the complete specification.

Operating rules:

- Work autonomously. Make reasonable decisions without asking, record each non-obvious one in `DECISIONS.md` (one line: decision · reason), and keep going.
- Stop and ask only for steps you cannot do yourself: an interactive login (`spacetime login`, `vercel login`) or anything that costs money. Print the exact command, wait, then continue.
- The real APIs beat this brief. SpacetimeDB 2.x and PixiJS v8 change often and differ from older tutorials. Before writing code against either, read the installed package's type definitions and the official docs or skills. If a detail here conflicts with the real API, follow the API, keep the intent, and note it in `DECISIONS.md`.
- Build in vertical slices that always run: shared simulation with tests, then the server module, generated bindings, a client that connects and moves, combat, UI and polish, deployment. Commit to git after each slice with a clear message.
- Verify as you go: typecheck, unit tests, a local multi-client run, then the production URL. Never report something as working that you have not run.
- Keep the code explainable. The developer must explain and modify it live in a lab viva. Prefer plain, well-named functions over clever abstractions, put every tunable number in `shared/config.ts`, and comment wherever logic is non-obvious (collision, raycasts, validation, interpolation).
- No downloaded art, audio files or third-party asset packs. Every sprite and sound is generated in code at load (sections 8 and 9). This keeps the download tiny and meets the lab rule of self-created assets.
- Run independent work in parallel tool calls (installing packages while writing files, tests while building).
- Add nothing beyond this brief. If time remains after the definition of done, improve smoothness and feel, not scope.

## 2. Goal and identity

The end state is a public HTTPS URL on Vercel where 2–6 people on phones and laptops open the link, type a nickname, create or join a room with a 4-letter code, and play a timed free-for-all jetpack shooter at a smooth 60 fps. The backend is a SpacetimeDB database on Maincloud. There are no accounts and no auth: closing the tab removes the player.

The inspiration is side-view jetpack combat in the style of Mini Militia, but THRUSTLINE (working title, rename freely) has its own identity. Use no names, characters, art or sounds from any existing game.

| Area | THRUSTLINE |
| --- | --- |
| Setting | Riggers, jetpack contractors fighting over RIG-7, an abandoned sky refinery above an acid sea |
| Look | "Neon Rig": dark navy world, flat geometric shapes with thick outlines, each player a saturated neon colour, glow faked with additive sprites |
| Blast-jumping | Shotgun recoil and grenade blasts push you; skilled players chain them with the jetpack to move fast |
| Bounty | A player on a 3-kill streak glows gold and is worth +50 bonus score |
| Frenzy | The last 60 seconds: damage ×1.5, fuel refills twice as fast, music speeds up |
| Modes | Arms (guns), Blades (knives only), Boom (grenades only), chosen by the host |
| Hazard | An acid pit in the middle of the map that burns anyone inside it |

## 3. Stack and layout

TypeScript everywhere, Vite and PixiJS v8 on the client, a SpacetimeDB 2.x TypeScript module on the server, and one shared simulation folder used by both.

| Layer | Choice | Why |
| --- | --- | --- |
| Language | TypeScript, strict | One language for client, server and shared simulation |
| Client build | Vite, latest stable | Fast dev server; static `dist/` output that Vercel hosts directly |
| Rendering | PixiJS v8 with `preference: ['webgpu', 'webgl']` | Batched sprite rendering; WebGPU where the browser has it, WebGL everywhere else |
| UI | Plain DOM and CSS over the canvas, no framework | Crisp text, tiny bundle, no per-frame virtual DOM work |
| Audio | Web Audio API | Low-latency effects; every sound synthesised in code |
| Backend | SpacetimeDB 2.x, TypeScript module | Tables, reducers, subscriptions and scheduling in one place |
| Client SDK | `spacetimedb` npm package, not the deprecated `@clockworklabs/spacetimedb-sdk` | Typed bindings generated from the module |
| Tests | Vitest for units, Playwright for the multi-client smoke test and screenshots |  |
| Hosting | Vercel for the client, Maincloud for the database |  |

Don't use Phaser, React or a physics engine. The game needs a small custom platformer physics that runs identically on client and server, and a framework adds weight without helping.

Repo layout (npm workspaces):

```text
thrustline/
  package.json            root scripts: dev, test, typecheck, gen, publish:local, deploy
  server/                 SpacetimeDB module
    src/index.ts          schema, reducers, lifecycle, scheduled reducers
    src/shared/           pure TS, no DOM, no Node APIs; imported by server AND client
      config.ts           every tunable number
      map.ts              RIG-7 ASCII map, parser, tile queries
      physics.ts          stepPlayer(), AABB vs tiles, one-way platforms
      raycast.ts          DDA tile raycast, ray vs AABB (slab test)
      weapons.ts          weapon table
      grenade.ts          deterministic grenade simulation
      spawn.ts            spawn point selection
      validate.ts         movement and hit-claim validation helpers
      *.test.ts           unit tests
  client/
    index.html
    vite.config.ts        alias @shared -> ../server/src/shared
    src/main.ts           boot, loading screen, screen router
    src/net/              connection, subscriptions, time sync, interpolation buffers
    src/game/             fixed-step loop, local player, remote players, combat, camera
    src/render/           atlas generation, map baking, sprites, particles, effects
    src/audio/            synth, sound bank, mixer
    src/ui/               screens, HUD, touch controls, settings
    src/module_bindings/  generated by `spacetime generate`; never edit by hand
    public/               manifest.webmanifest, icon.svg
  tests/e2e/              Playwright smoke test
  docs/                   ALGORITHMS.md, LAB_MAPPING.md, screenshots/
  README.md, DECISIONS.md
```

Shared code lives inside `server/src/` so the SpacetimeDB bundler is sure to include it; the client reaches it through the `@shared` alias. If `spacetime publish` bundles a top-level `shared/` package without trouble, either layout is fine. Shared code must be deterministic: plain arithmetic, no `Math.random()`, no `Date.now()`.

## 4. Rules and mechanics

Every number below is a default in `shared/config.ts`. Units are world pixels (1 tile = 32 px) and seconds.

**Match flow**

- Free-for-all, 1–6 players per room. A room with one player can start, which helps testing.
- Room states: `lobby`, `playing`, `ended`, then `playing` again (Play again) or closed.
- The host picks the mode (Arms by default) and round length (3, 5 or 8 minutes; default 5). Rooms created from a URL with `?dev=1` are dev rooms: they also offer a 30-second round and allow the test-only teleport (section 6).
- Players can join mid-round and spawn after 1 second.
- At round end the leaderboard shows. The host's Play again resets all stats and starts a new round in the same room.

**Movement and jetpack**

- Player hitbox 24 × 48 px. Run speed 260, ground acceleration 2400, air acceleration 1400, ground friction 2600.
- Gravity 1800, maximum fall speed 900.
- Jetpack: holding thrust adds 3000 upward acceleration (net 1200 up), capped at 420 upward speed. Fuel 100, drains 38 per second while thrusting (about 2.6 s of flight), refills 30 per second after 0.4 s on the ground.
- Tapping thrust on the ground is a hop (vertical speed −520 at once, costs 6 fuel). Holding it is flight.
- One-way platforms (`=`): you pass through from below and land on top. Holding down drops you through.
- Facing follows the aim direction. External impulses (recoil, blasts) can push horizontal speed up to 1000.

**Weapons**

| Weapon | Fire | Damage | Rate (shots/s) | Mag / reserve | Reload (s) | Range (px) | Spread | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Pistol | semi | 18 | 4 | 12 / ∞ | 1.0 | 900 | 1.5° | Always carried |
| AR | auto | 11 | 10 | 30 / 120 | 1.6 | 1100 | 1.5° still, 3° moving |  |
| Shotgun | semi | 7 pellets × 9 | 1.1 | 6 / 24 | 2.2 | 420 | 14° cone | Full damage to 180 px, 50% at 420; recoil pushes the shooter 520 away from the aim |
| Sniper | bolt | 85 | 0.8 | 4 / 16 | 2.6 | 2400 | 0° still, 6° moving | Camera leads 320 px toward the aim |
| Knife | melee | 55 | 2 | — | — | 64 px, ±60° arc | — | Short forward lunge (220) |
| Frag grenade | thrown | up to 90 | cooldown 0.8 s | 2 per life in Arms | — | blast radius 150 | — | Fuse 2.5 s, throw speed 820, bounces (restitution 0.45, friction 0.7), knockback 650 |

- All guns are hitscan: a shot is a ray, and the shotgun fires 7 rays.
- Grenade damage falls linearly from 90 at the centre to 0 at 150 px, needs line of sight to the target's centre, and is halved on the thrower.
- No headshots in v1. HP 100 with no regeneration. Spawn protection lasts 1.5 s and ends early if you fire.

**Modes**

| Mode | Loadout | Pickups active |
| --- | --- | --- |
| Arms (default) | Pistol, one primary (AR, shotgun or sniper, chosen on the respawn screen), knife, 2 frags | Health, ammo, grenade |
| Blades | Knife only; run speed +15% | Health |
| Boom | Frags only, unlimited, 1.0 s cooldown, at most 2 live per player; knife as backup | Health |

**Pickups (collectibles)**

- Health pack: +50 HP, capped at 100. Ammo crate: refills the primary's reserve. Grenade crate: +1 frag, maximum 3.
- Collected by walking or flying through them. Each respawns 20 s after pickup.

**Hazard**

- Acid (`~`) deals 30 damage per second while your hitbox overlaps it. You can fly out.

**Respawn and spawn selection**

- Respawn after 4 s. The respawn screen shows the countdown and, in Arms, lets you pick your primary.
- The server picks from the map's 8 spawn points. It drops any spawn within 200 px of where you died, ranks the rest by distance to the nearest living opponent (farthest first), and picks randomly among the top 3. Spawn camping is hard, and you never reappear where you just died.

**Scoring**

- Kill: +100. Killing a bounty target (streak of 3 or more): +50 extra. Dying to acid or your own grenade: −50.
- Leaderboard order: score, then kills, then fewer deaths.
- Streaks reset on death; bounty status starts at a streak of 3.

**Frenzy**

- With 60 s left: damage ×1.5, fuel refill ×2, a FRENZY banner, a red edge tint and faster music. Both client and server compute it from the round's end time; nothing is stored.

## 5. Map: RIG-7

RIG-7 is the single v1 map: 96 × 40 tiles of 32 px (3072 × 1280 px), mirror-symmetric so no side has an advantage. Ship it in `shared/map.ts` exactly as below. The parser must assert that every row is 96 characters, and a unit test must check the counts listed under the map.

| Char | Meaning |
| --- | --- |
| `#` | Solid tile |
| `=` | One-way platform |
| `~` | Acid (not solid, damaging) |
| `.` | Empty |
| `S` | Spawn point (an empty tile; the player's feet rest on the tile below) |
| `H` | Health pack |
| `A` | Ammo crate |
| `G` | Grenade crate |

```text
################################################################################################
#..............................................................................................#
#..............................................................................................#
#..............................................................................................#
#..............................................................................................#
#.......................................G..............G.......................................#
#...................................========================...................................#
#..............................................................................................#
#...................S......................................................S...................#
#.............=================..................................=================.............#
#..............................................................................................#
#..............................................................................................#
#..............................................................................................#
#..............................................................................................#
#....========......................................................................========....#
#..............................................................................................#
#..............................................................................................#
#.............................####........H..........H........####.............................#
#.............................####......======####======......####.............................#
#...S.........................................####.........................................S...#
#=========....................................####....................................=========#
#.............................................####.............................................#
#.............................................####.............................................#
#..................==========.................####.................==========..................#
#.............................................####.............................................#
#..............................................................................................#
#..............................................................................................#
#......S................................................................................S......#
#############......................................................................#############
#..............==========..............................................==========..............#
#...........................................A......A...........................................#
#........................................==============........................................#
#..............................................................................................#
#...................##....................................................##...................#
#...................##..........##............................##..........##...................#
#...S....A..........##..........##............................##..........##..........A....S...#
########################################~~~~~~~~~~~~~~~~########################################
########################################~~~~~~~~~~~~~~~~########################################
################################################################################################
################################################################################################
```

Expected counts: 8 `S`, 2 `H`, 4 `A`, 2 `G`, 32 `~`. Every marker sits directly above a `#` or `=`, every spawn has two empty tiles of headroom, and every row reads the same backwards.

Layout from the edges inward: two mirrored bases (ground floor, solid second floor, one-way roof, high ledge), a crate and a low wall on each side of the ground, mid-height platforms, a floating cover block, and a centre structure. The centre has a bridge over the acid pit, a solid pillar with one-way wings, and a long catwalk under the ceiling. Vertical routes are jetpack-only.

- The map is static data. Bake its visuals once at load (section 8); never draw tiles per frame.
- Pickup markers seed the `pickup` table when a room is created. Spawn markers are read straight from the parsed map.
- Treat everything outside the map as solid, and clamp the camera to the map bounds.

## 6. Server: SpacetimeDB module

The server is the referee: each client simulates and owns its own movement, and the server validates every update and owns everything that decides the match (HP, deaths, kills, score, ammo, pickups, grenades, spawns, the clock).

Before writing the module, set up SpacetimeDB tooling for yourself by following https://spacetimedb.com/agent-setup.md: run `npx skills add clockworklabs/SpacetimeDB`. Read its `typescript-server`, `typescript-client` and `cli` skills before coding. Inside reducers, time comes only from `ctx.timestamp` and randomness only from `ctx.random`; `Date.now()` and `Math.random()` are not available in modules.

**Tables.** Hot movement data is split from cold stats so a 20 Hz position write doesn't resend the whole player.

| Table | Visibility | Key fields |
| --- | --- | --- |
| `room` | public | `id` (PK, auto-inc), `code` (unique, 4 letters), `hostIdentity`, `state` (0 lobby, 1 playing, 2 ended), `mode`, `roundSec`, `dev`, `startedAtMicros`, `endsAtMicros`, `roundNo`, `createdAt` |
| `player` | public | `identity` (PK), `roomId` (btree index), `name`, `colorIdx`, `joinedAt`, `alive`, `hp`, `lifeId`, `kills`, `deaths`, `score`, `streak`, `primary`, `weapon`, `mag`, `reserve`, `grenades`, `reloadUntilMicros`, `spawnProtectUntilMicros`, `respawnAtMicros`, `correction` (counter), `cx`, `cy` |
| `pstate` | public | `identity` (PK), `roomId` (index), `x`, `y`, `vx`, `vy`, `aim`, `flags` (facing, grounded, jetting, reloading bits), `weapon`, `seq`, `serverMicros` |
| `pmeta` | private | `identity` (PK), `lastSyncMicros`, `prevX`, `prevY`, `prevMicros`, last-fire time per weapon, `lastMeleeMicros`, `lastThrowMicros`, `deathX`, `deathY` |
| `pickup` | public | `id` (PK), `roomId` (index), `kind`, `tx`, `ty`, `availableAtMicros` (0 = available) |
| `grenade` | public | `id` (PK), `roomId` (index), `owner`, `x0`, `y0`, `vx0`, `vy0`, `thrownMicros`, `fuseMs` |

**Scheduled tables** (private, one-shot, scheduled with `ScheduleAt.time(...)`): `respawn_job` (identity, lifeId), `round_end_job` (roomId, roundNo), `detonate_job` (grenadeId), `pickup_job` (pickupId). Each scheduled reducer rejects any caller other than the scheduler (for example via `ctx.senderAuth.isInternal`; confirm in the skill) and re-checks that its target still exists, because the room may have ended or the player may have left.

**Event tables** (public, `event: true`). Clients subscribe filtered by `roomId`, or by recipient for `pong_ev`:

- `shot_ev`: roomId, shooter, weapon, x0, y0, flat array of end points
- `hit_ev`: roomId, attacker, target, dmg, x, y, killed
- `kill_ev`: roomId, killer, victim, cause, bounty
- `melee_ev`: roomId, attacker, x, y, dir
- `boom_ev`: roomId, owner, x, y
- `pickup_ev`: roomId, identity, kind
- `pong_ev`: to, clientMs, serverMicros

There is no continuous server tick. Everything timed is a one-shot schedule, and everything else happens inside `sync`. This keeps the server cheap and leaves no tick that must finish under 50 ms.

**Reducers**

| Reducer | Who | What it does |
| --- | --- | --- |
| `createRoom({name, mode, roundSec, dev})` | anyone | Leaves any current room, creates a room with a unique code (letters without O, I or L, via `ctx.random`), seeds pickups from the map, adds the caller as host |
| `joinRoom({code, name})` | anyone | Checks the code and the 6-player cap, adds the caller; if the room is playing, schedules a spawn in 1 s |
| `leaveRoom()` | member | Same cleanup as a disconnect |
| `updateRoomSettings({mode, roundSec})` | host, not while playing | Changes mode and round length |
| `startRound()` | host | Resets every player's stats, pickups and grenades, sets start and end times, spawns everyone at distinct points, schedules `round_end_job` |
| `choosePrimary({weapon})` | member | Stored; applies at the next spawn |
| `sync({...})` | member | The 20 Hz movement-and-actions call (below) |
| `ping({clientMs})` | anyone | Inserts a `pong_ev` addressed to the caller |
| `devTeleport({x, y})` | member of a dev room | Moves the caller, for automated tests only; normal rooms reject it |
| `clientConnected` | lifecycle | A log line only |
| `clientDisconnected` | lifecycle | Deletes the caller's rows, grenades and jobs; hands host to the earliest remaining player; deletes an empty room with its pickups and jobs |
| `doRespawn`, `endRound`, `detonate`, `restorePickup` | scheduler only | See below |

Names are trimmed to 16 characters with control characters removed. Each player gets the lowest free of 6 colour indices in the room.

**`sync` arguments:** `seq`, `x`, `y`, `vx`, `vy`, `aim`, `flags`, `weapon`, plus optional action lists that are usually empty: `shots` (each: weapon, `ox`, `oy`, angle, and hit claims of `{target, pellets}`), `melee` (angle), `throwG` (angle), `reload` (bool). Define them with the SDK's `t.object`, `t.array` and `t.option` builders.

**`sync` processing order**

1. Ignore the call if it arrives under 25 ms after the previous one, if the caller isn't in a playing room, or if they are dead.
2. Movement check. `dt` is the time since the last accepted sync, capped at 250 ms. Reject the move if the new position is outside the map, overlaps a solid tile, or lies farther than `1100 × dt × 1.3 + 24` px from the last accepted position. On rejection, increment `player.correction`, set `cx` and `cy` to the last valid position, and skip the movement write. Otherwise copy the old position into `pmeta` and write `pstate`.
3. Finish a pending reload once `reloadUntil` has passed (fill the magazine from reserve).
4. Acid: if the hitbox overlaps `~`, apply `30 × dt` damage with cause acid.
5. Pickups: overlapping an available pickup that the mode uses applies it, sets `availableAt` to now + 20 s, schedules `pickup_job` and emits `pickup_ev`.
6. Actions, in order: weapon switch (only to weapons the mode allows; cancels a reload), reload, shots, melee, throw.

**Shot validation** favours the shooter within tolerances. The weapon must be equipped and allowed, not reloading, fired at least `0.85 / rate` seconds after the last shot of that weapon, with magazine above 0 (then decremented), and the origin within 48 px of the shooter's server position. For each claimed target: same room, alive, not spawn-protected and not the shooter; its current or previous position within range + 64 px; a clear tile raycast from shooter to that position; and the claimed ray passing within the target's half-diagonal + 40 px of it. Damage comes from the server's weapon table and the server's own distance (shotgun falloff, at most 7 pellets), times the Frenzy multiplier. Firing ends the shooter's spawn protection. Emit one `shot_ev` per shot for other clients' tracers and sounds.

**Melee:** the server finds targets itself. The cooldown must have passed, and a target must be within 72 px of the attacker's server position (current or previous), within ±70° of the swing angle, with a clear line between them.

**Throw:** requires a grenade in Arms, or the cooldown and the 2-live limit in Boom. Insert a `grenade` row at the player's hand with velocity `aim direction × 820 + player velocity × 0.3`, and schedule `detonate_job` 2.5 s later.

**`applyDamage(target, amount, attacker, cause)`:** subtract HP and emit `hit_ev`. If HP reaches 0: mark dead, add a death, record the death position, reset the streak, schedule `respawn_job` 4 s out and emit `kill_ev`. A kill by another player gives them +1 kill, +100 score, another +50 if the victim's streak was 3 or more, and +1 streak. Death to acid or your own grenade costs −50 score.

**`doRespawn`:** pick a spawn (section 4) and write it to `pstate`; set alive, HP 100, `lifeId + 1`, a full magazine and reserve for the chosen primary, grenades per mode, and 1.5 s of spawn protection.

**`detonate`:** run `simulateGrenade` from `shared/grenade.ts` on the row's stored f32 values to find the blast point. Damage players in the radius who have line of sight (falloff, Frenzy multiplier, half on the owner), emit `boom_ev` and delete the row.

**`endRound`:** if `roundNo` still matches, set the state to ended and delete the room's grenades and pending respawn and detonate jobs. Stats stay for the leaderboard.

## 7. Client netcode

Your own soldier is predicted locally and corrected only on rejection or respawn; everyone else is drawn 100 ms in the past and interpolated.

&#91;embedded content: netcode flow · 3 parts\]

Your browser sends one `sync` every 50 ms; the module validates it and pushes room rows and events to everyone else.

**Connection**

- Build the connection as `DbConnection.builder().withUri(VITE_STDB_URI).withDatabaseName(VITE_STDB_DB).withToken(<sessionStorage token>).withConfirmedReads(false)`. With confirmed reads off, updates arrive as soon as they are committed in memory, which cuts latency; match data is disposable anyway.
- Keep the token in `sessionStorage`, not `localStorage`. Each tab is then its own player (four tabs on one laptop = four players), and a reload keeps the same identity.
- Subscribe only to your room: `room` by id; `player`, `pstate`, `pickup` and `grenade` filtered by `roomId`; every event table filtered by `roomId`; `pong_ev` filtered by your identity. Event tables must be subscribed explicitly. Unsubscribe and resubscribe when you change rooms.
- Store the current room code in `sessionStorage`. If the socket drops, show "Reconnecting…", retry with backoff (0.5, 1, 2, 4 s, then every 8 s) and rejoin the room by code.
- Maincloud's free tier pauses idle databases. If connecting takes over 3 s, show "Waking up the server…".
- Reducer calls return promises. Show `SenderError` messages as toasts ("Room is full", "Room not found").

**Time sync.** On connect, send 5 pings 200 ms apart, then one every 2 s. For each `pong_ev`: RTT = now − clientMs, and offset = serverMs − (clientMs + RTT/2). Use the median of the last 5. `serverNow()` = local `performance.now()` time + offset. The debug overlay shows RTT.

**Local player (prediction).** Run `stepPlayer()` from shared code at a fixed 60 Hz with an accumulator, and render by interpolating the last two steps. Apply input immediately. Every 50 ms while moving or acting (every 200 ms when idle), send one `sync` with the latest state and any queued actions. Never draw your own player from server rows. Snap the local simulation to the server only when `player.correction` increases (to `cx`, `cy`) or `lifeId` changes (to the spawn position in `pstate`).

**Remote players (interpolation).** Keep a ring buffer of the last 20 `pstate` snapshots per player, stamped with `serverMicros`. Draw each at `serverNow() − 100 ms`, interpolating position and aim between the two snapshots around that time. With no newer snapshot, extrapolate by velocity for up to 100 ms, then hold. The buffer also absorbs the bursty delivery of WebSocket messages on mobile data.

**Shooting.** When the local player fires: apply recoil, play the sound and muzzle flash, raycast at once against tiles (DDA) and remote players' rendered hitboxes (slab test), draw the tracer to the first hit and spawn sparks. Queue the shot with its hit claims for the next `sync`. Hit markers and damage numbers appear only on `hit_ev`, so they never show a hit the server refused. Other players' shots arrive as `shot_ev`; skip your own.

**Grenades.** Render every `grenade` row by running `simulateGrenade` locally from its stored values up to `serverNow()`. The same code with the same inputs gives the same path on the server, so the explosion happens where the grenade is drawn. On `boom_ev`, play the effect, and if your own player is in range with line of sight, apply the knockback locally (your client owns your movement).

**Ammo and HP.** Show the values from your `player` row. Predict the magazine between updates (decrement on fire) and take the server's value whenever the row changes.

## 8. Graphics and rendering

Every visual is generated in code at load and baked into textures. Nothing is downloaded, and no vector shapes are redrawn per frame.

**Palette.** Background gradient `#0B1020` to `#1B2340`; solid tiles `#2A3350` with a top lip `#5B6B9A`; one-way grates `#6B7AA8`; acid `#7CFF4F` with glow; UI ink `#E6ECFF`. Player colours by index 0–5: cyan `#22D3EE`, magenta `#F472B6`, lime `#A3E635`, amber `#FBBF24`, violet `#A78BFA`, coral `#FB7185`. Bounty gold `#FFD54A`.

**Atlas (one texture, at most 2048 × 2048).** Draw each part with Pixi `Graphics`, render it into a texture region, pack the regions with a simple shelf packer, and expose them as named `Texture`s.

- Soldier: torso capsule (white, tinted per player), helmet with visor, two leg segments, an arm and a jetpack. Animate by rotating and offsetting parts in code (leg swing, arm aim, body bob); no frame sheets.
- Weapons: pistol, AR, shotgun, sniper, knife and frag, as side silhouettes.
- Effects: muzzle flash (2 variants), a 1 × 8 px tracer (stretched and tinted), spark, soft dot, smoke puff, explosion ring, shockwave, jet flame (3 variants), spawn-protection bubble, bounty crown.
- Pickups: health cross, ammo box and grenade crate, each with a baked glow halo.
- UI icons: the weapons, grenade, skull (kill feed), crown (host).

**Map baking.** At load, draw RIG-7 into 1024 × 1024 `RenderTexture` chunks (3 × 2 for this map). Auto-tile solid edges from a 4-neighbour mask (bright top lip, darker sides, rivet dots), and draw grate platforms and background girders. The whole map then costs about six sprites. Acid is a separate layer: a slowly scrolling `TilingSprite`, a bubble emitter and an additive glow strip.

**Parallax.** Three pre-rendered layers (far skyline of rig silhouettes, mid pipes and girders, near fog band) move at 0.15, 0.4 and 0.7 of the camera.

**Effects and feel**

- Particles come from one pool (Pixi v8 `ParticleContainer` if the installed version supports it, otherwise pooled sprites), capped at 400 on High quality and 150 on Low.
- Muzzle flash lasts 2 frames, tracers fade over 80 ms, and sparks fly on wall and player hits (a bright spark in the victim's colour, no blood).
- Camera follows the local player with a 0.12 lerp and leads toward the aim (sniper: 320 px). It shakes slightly on firing (more for shotgun and sniper) and on explosions, decaying fast.
- Taking damage shows a red edge vignette and a damage-direction arc. Death is a burst in the player's colour with the body parts scattering.
- Name tags and floating damage numbers use `BitmapText` with a bitmap font generated at load.

**Rendering rules**

- `autoDensity: true`, resolution `min(devicePixelRatio, 2)`, antialias off (the art has clean edges of its own).
- No Pixi filters (blur, glow) in the game view; glows are baked additive sprites.
- Cull off-screen particles and effects. Stop the ticker when the tab is hidden.
- Log `app.renderer.name` and show it in the debug overlay.

## 9. Audio

All sound is synthesised at load with an `OfflineAudioContext` and kept as `AudioBuffer`s, which takes a few hundred milliseconds and downloads nothing.

| Sound | Recipe |
| --- | --- |
| Pistol | Short white-noise burst, 1.2 kHz low-pass sweep, click transient, 120 ms |
| AR | Like the pistol but tighter (70 ms), slight pitch variation per shot |
| Shotgun | Wider noise burst, lower cutoff, sub thump, 300 ms |
| Sniper | Sharp crack and a long filtered tail, 700 ms |
| Reload / empty | Two metallic clicks / one dry click |
| Jetpack | Looping band-passed noise with a slow LFO; volume follows thrust |
| Explosion | Noise plus a 50 Hz sine thump, 1.2 s decay |
| Knife | High-passed noise whoosh |
| Hit marker / hurt | 1.8 kHz sine tick / low thump |
| Pickup | Three-note rising arpeggio |
| UI click, countdown beep, Frenzy alarm, round-end sting | Short synth tones |
| Music | 8-bar loop at 120 bpm (kick, snare, saw bass), rendered twice: normal and Frenzy (faster, brighter) |

Mixer: master, music and SFX gain nodes, with volumes saved in `localStorage`. Use a pool of 16 voices; when it is full, steal the oldest. Pan each world sound by its x position relative to the camera and attenuate it by distance. Resume the `AudioContext` on the first tap or key press (browsers block audio until then), and mute while the tab is hidden.

## 10. Web interface

The UI is DOM and CSS layered over the canvas, with a system font stack (no web-font download) and bold uppercase headings with letter-spacing for the Neon Rig feel. HUD elements update only when their value changes, and animations use only `transform` and `opacity`.

**Screens**

1. Loading: logo and a progress bar while textures, the map and audio are generated, then a Tap to start button (this also unlocks audio).
2. Home: title, nickname field (saved in `localStorage`), Create room, Join room (4-character code field, auto-uppercase), How to play, Settings. A link like `/?room=ABCD` pre-fills the code.
3. Lobby: the room code in large type with Copy link and Share (`navigator.share` on phones); the player list with colours and a crown on the host; the host's mode and round-length pickers (read-only for others); Start (host only); Leave.
4. Game: canvas, HUD and touch controls.
5. Respawn overlay: who killed you, a 4-second countdown ring, and three primary buttons (Arms).
6. Round end: leaderboard (rank, colour, name, score, kills, deaths) with your row highlighted; Play again (host) or "Waiting for host"; Leave.
7. Overlays: menu (Settings, Leave), "Reconnecting…", "Rotate your phone" in portrait, and error toasts.

**HUD layout**

- Top-left: HP bar and fuel bar.
- Top-centre: round timer, which turns into a red FRENZY badge in the last minute.
- Top-right: mini leaderboard (top 3 plus you), with the kill feed (last 4) underneath.
- Bottom-right on desktop, above the right stick on touch: weapon icon, magazine and reserve, grenades.
- Centre: a crosshair on desktop; on touch, a faint aim line from the gun. Hit markers flash at the crosshair or the target.
- Hold Tab (desktop) or tap the mini leaderboard (touch) for the full scoreboard. F3 or a setting toggles the debug overlay (FPS, RTT, renderer, player count, quality).

**Keyboard and mouse:** A/D move, W or Space thrust, S drop through platforms, mouse aims, left click fires (hold for AR), right click or F melee, G grenade, Q swap weapon, R reload, Tab scoreboard, Esc menu.

**Touch (twin stick).** Use Pointer Events and track each pointer for multi-touch.

- Left stick appears where the thumb lands in the left 40% of the screen. Horizontal movement runs; pushing up past 40% thrusts; pushing down past 60% drops through platforms.
- Right stick appears where the thumb lands in the right 40%. Its direction aims; pushing past 60% fires, and automatic weapons keep firing.
- Buttons above the right stick (at least 56 px, semi-transparent): swap, reload, grenade, melee. An optional left-handed layout swaps the sides.
- `navigator.vibrate(15)` on hits where supported.

**Mobile setup**

- Viewport meta `width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover`; respect safe-area insets.
- On the game screen: `touch-action: none`, `overscroll-behavior: none`, no text selection, no context menu.
- Landscape only; portrait shows the rotate overlay. Show a Fullscreen button where the Fullscreen API works (Android, desktop); on iPhone, show a hint to add the game to the home screen.
- `manifest.webmanifest` with `display: "fullscreen"`, `orientation: "landscape"`, a theme colour and an SVG icon.
- Hold a Screen Wake Lock during a match and release it on leave.
- View size: about 680 world px of height, with the width following the screen's aspect ratio, capped at 1500.

**Settings:** master, music and SFX volume; graphics quality (Auto, High, Low); show FPS; left-handed touch layout.

## 11. Performance budget

The game must hold 60 fps on a mid-range Android phone from 2022 in Chrome, and on any recent laptop.

| Target | Budget |
| --- | --- |
| Frame rate | 60 fps; never under 50 for more than a second on Low quality |
| Frame time | Under 8 ms of JavaScript per frame on a laptop |
| Initial load | JavaScript under 500 KB gzipped; playable within 3 s on 4G, plus generation time |
| Network per player | One `sync` per 50 ms while active, per 200 ms when idle |
| Memory | No per-frame allocations in the loop (a Performance recording shows a flat heap with no GC sawtooth) |

**Quality governor.** Auto starts on High. If average FPS stays below 50 for 3 s, step down: resolution 2 → 1.5 → 1, particle cap 400 → 150, parallax layers 3 → 1. Step back up after 10 s above 58. Low quality forces the lowest step.

**Techniques:** one atlas so sprites batch into very few draw calls; the map as about six baked chunks; object pools for bullets, tracers, particles, damage numbers and kill-feed rows; reused vectors in physics and raycasts; `BitmapText` only; DOM writes only on change; subscriptions limited to one room; event tables for transient effects so nothing piles up in the client cache.

## 12. Testing and verification

Nothing counts as done until it has run: typecheck, unit tests, a local multi-client game, and the same game against production.

1. Typecheck every package in strict mode with zero errors.
2. Unit tests (Vitest) in `server/src/shared/`:
   - Map: 96-column rows, the expected counts, every marker supported, symmetry.
   - Physics: falling and landing; walls stop horizontal movement; one-way platforms let you up from below and drop you through on down; fuel drains and refills; a 10-second random-input simulation never leaves the map or enters a solid.
   - Raycast: DDA stops at the first solid tile; the slab test hits and misses boxes correctly.
   - Grenade: the same inputs give the same final position twice; it bounces off floors and walls and never ends inside a solid.
   - Spawn selection: never within 200 px of the death point; prefers spawns far from enemies.
   - Validation: accepts legitimate movement and shots with latency tolerance; rejects teleports, shots through walls, fire faster than the weapon's rate and out-of-range hits.
3. Local integration: run `spacetime start`, publish the module locally, generate bindings and run `vite dev`. A Playwright script opens three browser contexts (separate `sessionStorage`, so three identities). One creates a dev room with a 30-second round, two join by code, and the host starts. Each client moves and fires scripted inputs; then two players use `devTeleport` to stand face to face on the floor and one fires until a kill registers. Assert that every client sees the others move, a kill appears in all kill feeds, and the round ends with a leaderboard. Run Chromium with a software GL flag (such as `--use-angle=swiftshader` or `--enable-unsafe-swiftshader`) so the canvas renders headless.
4. Screenshots: the same script saves `docs/screenshots/home.png`, `lobby.png`, `gameplay.png` and `round-end.png` at 1280 × 720, plus `gameplay-mobile.png` at a phone landscape size with touch controls visible.
5. Production smoke test: after deploying, run the same script against the Vercel URL and the Maincloud database (one round, two clients).

## 13. Deployment

You deploy from the developer's laptop: the module goes to Maincloud with the `spacetime` CLI, and the client goes to Vercel with the already logged-in Vercel CLI.

1. Tools: check `node -v` (20 or later), `spacetime --version` (install from https://spacetimedb.com/install if it's missing) and `vercel --version`. Check the SpacetimeDB login status (see `spacetime login --help`). If not logged in, ask the developer to run `spacetime login`, which opens a browser, then continue.
2. Local development: run `spacetime start` in the background, publish to it with `spacetime publish thrustline-dev --server local` from `server/`, and generate bindings with `spacetime generate --lang typescript --out-dir client/src/module_bindings` pointed at the module (confirm every flag with `--help`). Develop against the local server so the Maincloud free energy budget is kept for real playtests.
3. Database name: pick a globally unique name such as `thrustline-` plus 4 random lowercase letters. Write `client/.env.production` with `VITE_STDB_URI=https://maincloud.spacetimedb.com` and `VITE_STDB_DB=<name>`, and `client/.env.development` with `ws://localhost:3000` and `thrustline-dev`. These aren't secrets; commit both files.
4. Publish to Maincloud: `spacetime publish <name> --server maincloud` from `server/`. If a later publish fails because of an incompatible schema change, republish with `--delete-data`; all game data is disposable, so that's acceptable here.
5. Deploy the client: from `client/`, run `npm run build`, then `vercel link --yes` the first time (project name `thrustline`) and `vercel --prod`. Vercel detects Vite and serves `dist`. Add a `vercel.json` that gives `/assets/*` a long, immutable `Cache-Control`.
6. Verify: open the production URL in Playwright, create a room, and confirm the connection succeeds and the renderer reports `webgpu` or `webgl`. Then run the production smoke test (section 12).
7. One command for later: a root `npm run deploy` script runs typecheck, tests, generate, publish to Maincloud, build and `vercel --prod`.

**Fallbacks**

- If `vercel --prod` fails twice with the same error, stop and report it. `client/dist/` is a plain static site that any static host can serve.
- Offline LAN, for the README only (build nothing extra): a laptop runs `spacetime start` and `vite preview --host` with `VITE_STDB_URI=ws://<laptop-ip>:3000`, and players on the same Wi-Fi open `http://<laptop-ip>:4173`. That page isn't a secure context, so WebGPU is unavailable and Pixi uses WebGL. A phone hotspot can be the network, but the laptop must be the host.

## 14. Documentation for the lab

Five files cover what the lab asks for, written so the developer can present from them.

- `README.md`: what the game is; how to play (rules, keyboard and touch controls, modes); a customisation section (jetpack fuel, blast-jumping, bounty, Frenzy, modes, acid hazard, smart spawns); how to run locally; how to deploy; the LAN fallback; the architecture in one paragraph; and the stack with one line of reasoning per choice.
- `docs/ALGORITHMS.md`: short explanations with code references for the fixed-timestep loop, AABB-vs-tile collision with one-way platforms, the DDA raycast and slab test, hit validation (favour the shooter), remote interpolation, spawn selection and the deterministic grenade simulation.
- `docs/LAB_MAPPING.md`: a table from each lab requirement to where the game meets it: start screen, instructions, score, timer, lives (respawns), controls, animation, collision detection, scoring rules, difficulty progression (Frenzy), game states, multimedia (generated sprites, parallax, sound effects, music), collectibles (pickups), hazard (acid), restart (Play again).
- `docs/screenshots/`: the images from section 12.
- `DECISIONS.md`: every deviation from this brief, one line each.

## 15. Definition of done

The build is done when every box below is true and has been checked by running it.

- [ ] `npm run typecheck` and `npm test` pass.
- [ ] Four tabs on one laptop can create, join and play a round locally, with smooth movement, kills, respawns, pickups, acid damage and round end all working.
- [ ] All four guns, the knife and frags work in Arms; Blades and Boom restrict loadouts correctly.
- [ ] Touch controls work on a phone in landscape; keyboard and mouse work on desktop.
- [ ] Sound plays after the first tap, and the music switches in Frenzy.
- [ ] The debug overlay shows 60 fps on a laptop and names the active renderer.
- [ ] The module is on Maincloud, the client is on Vercel, and the production smoke test passes.
- [ ] README, ALGORITHMS, LAB\_MAPPING, screenshots and DECISIONS exist.

**Final report** (your last message to the developer): the production URL; the Maincloud database name; how to redeploy (`npm run deploy`); the result of each checklist item; anything not done or behaving differently from this brief, and why; and three things to test first on real phones.
