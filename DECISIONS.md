# Decisions

Every deviation from the build brief, and every non-obvious choice, one line each (decision · reason).

## Tooling and deployment

- Upgraded the SpacetimeDB CLI from 2.0.1 to 2.14.0 · the `spacetimedb` npm SDK is 2.14.0; matching versions avoid codegen/bundler mismatches.
- TypeScript 7 (current `typescript` on npm) · latest stable; strict mode, zero errors in both packages.
- Vercel deploys from the repo root (`vercel.json` at the root, build `npm run build -w client`, output `client/dist`) instead of from `client/` · the client imports `../server/src/shared`, which isn't uploaded when the deploy root is `client/` (the first deploy failed for exactly this reason).
- `npm run publish:cloud` reads the database name from `client/.env.production` · one source of truth for the Maincloud name (`thrustline-zhtm`).
- The production smoke test uses a `?dev=1` room · `devTeleport` is only allowed in dev rooms, and the brief's smoke test needs it.

## Server module

- Scheduled reducers are bound with `spacetimedb.reducer({ onSchedule: table }, …)` and still check `ctx.senderAuth.isInternal` · `onSchedule` is the current API; scheduled reducers are private by default in 2.x, the check is defence in depth.
- Added `player.pistolMag` · the pistol keeps its own magazine when you swap; one `mag` field can't hold two weapons.
- Added `player.isBot` and a `bot` argument on `joinRoom` · CPU players (requested by the developer) show a CPU tag, and host hand-off prefers humans.
- `sync` takes two extra fields, `life` and `corr` · a sync from a previous life, or sent before the client applied a correction, is stale and must not move the player.
- `ShotIn` has an `ends` array (tracer end points) · the server has no per-pellet directions, so it relays the shooter's end points to other clients for tracers.
- `HitClaim` has its own `angle` (average direction of the rays that hit) · moving-sniper spread (6°) and shotgun pellets (±14°) would fail the "claimed ray within half-diagonal + 40 px" check if only the aim angle were sent.
- `pickup_ev` carries `pickupId` · clients play the pickup ring at the right crate.
- `pmeta` stores `connId`, `lastHazardMicros`, `hasDeath`, and `lastFire` as an array · reload race protection, acid timing, "no death yet", per-weapon fire times.
- Movement check uses 1400 px/s instead of 1100 · a blast (1000 px/s sideways) while falling at 900 px/s moves ~1345 px/s; 1100 would snap legitimate blast-jumps back.
- A sync under 25 ms after the previous one skips only the movement write; its actions still run · bunched mobile packets would otherwise silently drop shots.
- Fire rate uses a token bucket with a 200 ms burst allowance · two shots fired 100 ms apart can arrive in one sync; the average rate is still enforced.
- A shot's origin may be within 48 px of the shooter's current or previous accepted position · shotgun recoil moves the shooter up to ~36 px between firing and the next sync (found by the weapons e2e test).
- `dt` for the movement check is measured from the last accepted position (`pstate.serverMicros`) · matches "time since the last accepted sync".
- Pickups are only consumed when they help (health below 100, reserve not full, fewer than 3 grenades) · walking over a full health pack shouldn't waste it.
- Spawn protection also ends on knife swings and grenade throws · consistent with "ends early if you fire".
- A grenade that would spawn inside a wall starts at the thrower's centre · otherwise it could get stuck in a tile.
- `endRound` also marks everyone dead · nobody keeps moving or shooting behind the leaderboard.
- `clientDisconnected` cleans up only if the disconnecting connection owns the player row (`pmeta.connId`) · on a page reload the new connection may rejoin before the old one's disconnect arrives.
- Rejoining the same room (reload/reconnect) keeps your stats · `joinRoom` for a room you're already in just adopts the new connection.
- Dev rooms log every rejected move/shot/hit claim (`spacetime logs`) · makes validation visible in tests and in the viva.

## Client

- Atlas and map chunks are drawn with the Canvas 2D API, then uploaded as Pixi textures, instead of Pixi `Graphics` → `RenderTexture` · Canvas 2D has radial gradients for the baked glows; the result is the same: generated at load, one atlas texture (2× resolution), six map chunks.
- The atlas is shelf-packed into a 1024×1024 logical (2048×2048 physical) canvas · within the brief's 2048 limit, crisp on high-DPI screens.
- Automatic reconnect uses the SDK's `withAutomaticReconnect({ minDelayMs: 500, maxDelayMs: 8000 })` · it doubles 0.5 → 1 → 2 → 4 → 8 s like the brief (with the SDK's ±50 % jitter) and keeps subscriptions; the initial connection retries on the exact 0.5/1/2/4/8 s schedule.
- On touch, holding the aim stick past 60 % also repeats semi-auto weapons at their fire rate · tapping a stick repeatedly isn't practical on a phone.
- `Q` swaps primary ↔ pistol in Arms (knife has its own key, F) and frag ↔ knife in Boom · knife is always one key away; Blades has nothing to swap.
- Grenade flights are precomputed once per grenade as a path array (the same deterministic 120 Hz simulation) and looked up each frame · no per-frame re-simulation or allocation.
- Ammo prediction merges the server row only when the row object changes (for bots too) · otherwise prediction would be undone every frame.
- The knife lunge's vertical part is halved · a full upward lunge felt like a jump.
- Air drag of 300 px/s² when no direction is held (brief is silent) · keeps blast-jump momentum but lets you stop eventually.
- Quality governor steps never raise resolution above `devicePixelRatio` · no point rendering 2× on a 1× screen.
- `window.__tl` exposes the game objects · used by the Playwright tests (`debugState()`, `devTeleport`).

## CPU players (added at the developer's request)

- Bots run in the browser tab that adds them; each opens its own SpacetimeDB connection with a fresh identity and plays through `joinRoom`/`sync` · the server validates bots exactly like humans and no server tick is needed.
- Only the host sees "+ Add CPU" / "− Remove CPU" in the lobby · one owner per bot; closing that tab disconnects its bots and the server cleans them up.
- Bot brain: nearest visible enemy, aim error that shrinks with time in view, 0.3 s reaction delay, range keeping per weapon, wall hopping, acid look-ahead and escape · plain heuristics that are easy to explain and tune.

## Round 2: playtest feedback (bugs, rules, mobile, UI)

- Bots hosted in a tab are drawn from their own simulation, not from interpolated server rows · they were drawn ~220 ms in the past (100 ms buffer + round trip) while shooting from the present, so shots seemed to come through walls.
- CPU brain rewritten with Easy/Normal/Hard presets (sight range, perception delay, reaction time, aim error, turn speed, burst fire), spreads targets across players, and hunts your last known position · the old bot aimed at the exact live position every frame and felt like an aimbot. Measured time to kill a stationary player at close range: Easy ~4–10 s, Normal ~4–20 s, Hard ~2–4 s.
- A hit claim now needs a clear line of sight to the target's current server position (range and ray may still match the previous one) · being shot just after reaching cover felt like bullets passing through walls.
- Touch drop-through needs a firm, mostly vertical pull (> 75 % and twice as vertical as horizontal) · the old 60 % threshold dropped you through platforms when moving diagonally down.
- Exhaustive sweep tests added (DDA vs brute force over 4000 random rays; hop/fly/release from every surface) · they confirmed the shared physics and raycast never let bullets or players through solid tiles, which pointed to the netcode/visual causes above.
- Room house rules stored as one `rules` object column on `room` (infinite fuel, infinite ammo, pickups, acid, Frenzy, max HP, respawn delay, CPU skill), edited with `updateRoomSettings` · one place for everything the host controls, validated server-side.
- New Snipers mode (sniper + knife; health and ammo pickups) · the host asked for more match types; it reuses the existing weapon code via `effectivePrimary`.
- Infinite ammo also makes Arms grenades unlimited · players expect "infinite ammo" to cover grenades.
- `player.pingMs`, reported through the existing `ping` reducer (`rttMs` argument), shown in the HUD chip, mini leaderboard and scoreboard · lets players see who has a latency disadvantage.
- Invite links (`?room=CODE`) join the room straight after the start tap, with the saved or a random callsign; the server suffixes duplicate names in a room ("Ace 2") · the start tap is still needed because browsers block audio until a gesture.
- The grenade key/button throws in Boom too, and touch buttons hide when the mode doesn't use them · the grenade button did nothing in Boom.
- Phones zoom in: view height `clamp(screenHeight × 1.08, 420, 680)` world px · soldiers were tiny on a 390 px tall phone.
- Every screen is landscape-only on touch devices (rotate prompt in portrait) and all menus have compact landscape layouts · requested by the developer.
- UI redesign: OFL fonts (Russo One, Chakra Petch) from npm, inline SVG icons, live map drifting behind menus at 30 fps, visual How to Play · the developer allowed adding assets; fonts are bundled locally (no third-party CDN) and everything else is still drawn in code.
- Map art upgraded (gradient metal, neon walkable edges, lit windows, see-through mesh catwalks) · makes solid walls and pass-through platforms visibly different.
- Tapping start on a phone also requests fullscreen where supported · more screen for the game; failures are ignored.
- Move rejections are now logged in every room (other rejections only in dev rooms) · rare, and they help diagnose "snapped back" reports.
- Publishing this schema change to Maincloud used `--delete-data=always` · only room/match data is lost, which is disposable.

## Round 3: lobby flow, teams, jetpack, radar, latency

- Ended rounds return the whole room to the lobby automatically after 12 s (scheduled `lobby_job`, `room.lobbyAtMicros` for the countdown); host can also press Play again or Lobby now (`backToLobby`) · the old host-only "Lobby settings" view was client-side, leaving other players stuck on "Waiting for host".
- Clashing or empty names get a fresh random callsign from a shared list (`shared/names.ts`, picked with `ctx.random`) instead of "Name 2" · requested: nobody should look alike.
- Host can kick (`kickPlayer`); kicked humans are stored in a private `kicked` table so they can't rejoin that room, and get a `kick_ev` notice · requested.
- Teams: `room.teams`, `player.team` (1 red, 2 blue), balanced on join, `switchTeam` / `movePlayerTeam`; red spawns on the left half, blue on the right; MAX_PLAYERS raised to 8 for 4v4 · requested 1v1/2v2/4v4.
- Friendly fire is a rule, on by default; teamkills give no kill credit and cost 50 points · requested ("teammate damage should register").
- Team colours replace personal colours in team matches (red #FF4D5E, blue #3D8BFF) with an ally chevron over teammates · "easily identifiable".
- Analog jetpack: `MoveInput.thrustAmount` (0–1), vertical damping while thrusting (applied after gravity so ~60 % power is an exact hover), touch stick maps to power with a wide hover band · the binary jet could only climb or fall, unlike Mini Militia.
- Floating grenades rule: zero gravity and a 0.99-per-tick drag in the same deterministic simulation (`grenade.zeroG`) · requested as an option; normal grenades are unchanged.
- Radar: minimap reveals enemies only for 3 s after they fire; edge arrows only for off-screen enemies that fired · shows where shots come from without making hiding pointless or covering visible enemies.
- Menu and fullscreen buttons moved beside the timer and layered above the touch layer · they sat in the aim-stick zone and couldn't be tapped.
- Touch layout enabled from the start on touch devices · previously only after the first touch, so the weapon box overlapped the aim stick.
- Netcode: snapshots stamped with the sender's clock (`pstate.sentMs`), per-player adaptive interpolation delay (`LagEstimator`), movement validated on the client timeline with a 350 ms time-debt cap, lag-compensated hit claims from a 16-sample position history (`viewMs` per claim; cover still wins) · a fixed 100 ms delay and server-clock movement checks only work on low-latency links; at ~250 ms they caused constant extrapolation snaps and rejected moves.
- The latency e2e test simulates ~250 ms RTT with jitter by wrapping WebSocket in the browser (copying send buffers, since the SDK reuses them) · Chromium's network throttling doesn't apply to WebSockets.
- Ping stays ~250 ms because Maincloud runs in Virginia, USA (measured TCP connect ~250 ms from here); no code change can remove that · reducing it needs a SpacetimeDB server near the players (self-hosting costs money, so it wasn't done).

## Round 4: server location

- Measured latency options from India before choosing: Maincloud (Virginia) ~245–305 ms; a Cloudflare Durable Object probe 87–235 ms (free-plan traffic from this ISP is served from Singapore / Hong Kong / Tokyo and the route changes per connection); AWS Mumbai ~67 ms; Oracle Cloud Mumbai ~38 ms; Oracle Cloud Hyderabad ~25 ms · decide on data, not assumptions. The probe Worker was deleted afterwards.
- Chosen path: self-host the same SpacetimeDB module on Oracle Cloud Always Free in India (`deploy/oracle/`: one setup script with SpacetimeDB as a systemd service and Caddy for automatic HTTPS on `<ip>.sslip.io`) · ~10× lower ping, free, zero code changes; a Cloudflare rewrite would replace a tested backend for an inconsistent gain.
- `scripts/publish-cloud.mjs` now publishes to whatever server `VITE_STDB_URI` names (Maincloud or a self-hosted URL) · switching servers is one config change plus `npm run deploy`.
- `docs/GAME_GUIDE.md` added as the single explanation document for the presentation and viva.

## Round 5: submission polish (defaults, feel, rendering, hardening)

- Every house-rule toggle now defaults on (infinite jetpack/ammo, pickups, acid, Frenzy, floating grenades) · the requested fast, chaotic default; a fresh room needs no setup.
- Jetpack refills at 60/s after 0.15 s on the ground (was 30/s after 0.4 s) · ~1.7 s from empty to full instead of ~3.3 s, so a normal match keeps moving.
- `route()` is coalesced to one call per animation frame and the scoreboard only rewrites its table when the markup changes · player rows update ~20×/s (HP, ammo, ping), which used to rerun the router and replay lobby entry animations dozens of times a second.
- Lobby pings are updated in place instead of replacing the player-list HTML · a ping change no longer replays `@keyframes rise` on every row.
- The lobby keeps a local draft of settings and sends the full draft on every click · rapid clicks previously merged into the last server snapshot (lost update) and the next render reset the checkbox; the draft is discarded once the server row matches or after 4 s.
- The network chip and the F3 panel are compacted on short screens; on touch the panel is one line (FPS · RTT · quality) · the six-line block covered the play area on phones.
- `takeSync` sends a queued action after the 25 ms minimum gap instead of waiting for the next 50 ms tick · removes up to 50 ms from every shot, knife and throw; the local raycast also shows a provisional hit marker while the authoritative `hit_ev` is in flight.
- Parallax backdrop rebuilt with a moon, nebulae, lit towers, trusses, pipes, hanging lamps and foreground fog/railing, all still generated in code and tiled seamlessly · the old three-layer version looked flat and obviously procedural.
- Server rejects non-finite `sync` values (position, velocity, aim, melee/throw angles), malformed shots, more than 8 hit claims per shot and tracer arrays over 42 floats; `ping` ignores a non-finite `clientMs` · defensive validation for a client that sends NaN or oversized arrays.
- Vercel now sends CSP, `nosniff`, referrer and permissions headers · all scripts and assets are first-party. `script-src` must include `'unsafe-eval'`: PixiJS v8 feature-detects its renderer with `eval`, and a policy without it fails at boot (caught by the production smoke test); the rest of the policy still limits sources, frames and objects.
- The ping readout stays a real measurement · the 250 ms is the physical round trip to Virginia; shortening the display would misrepresent it. The honest levers are local hit feedback, immediate action sends and a closer server (`deploy/oracle/`), not a divided number.
