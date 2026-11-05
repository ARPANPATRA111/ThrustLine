# Algorithms

Short explanations of the techniques in THRUSTLINE, with pointers into the code. Paths are relative
to the repo root.

## 1. Fixed-timestep game loop

[client/src/game/game.ts](../client/src/game/game.ts) `frame()` (line 525)

Screens refresh at different rates (60, 90, 120 Hz) and frames take uneven time, but physics must
behave the same everywhere. So the loop keeps an **accumulator**:

```text
acc += frameTime
while acc >= 1/60:      step the simulation by exactly 1/60 s
    acc -= 1/60
alpha = acc / (1/60)    how far we are between the last two steps
draw at lerp(previous, current, alpha)
```

The simulation always advances in identical 1/60 s steps (deterministic and frame-rate independent),
and drawing interpolates between the last two steps, so motion stays smooth even when the screen
runs faster or slower than 60 Hz. One-shot inputs (a click, G for grenade) apply to exactly one step.
Frame time is capped at 0.1 s so a stalled tab doesn't fast-forward.

## 2. AABB vs tiles, with one-way platforms

[server/src/shared/physics.ts](../server/src/shared/physics.ts) `stepPlayer` (line 79), `moveX` (133), `moveY` (168)

The player is an axis-aligned box (24 × 48 px; position = centre of the feet). Each step:

1. Update velocity: run acceleration/friction, jetpack thrust (or a hop on a fresh tap), gravity, speed caps.
2. **Move X, then Y, separately.** Moving one axis at a time makes the collision response simple:
   if the box would overlap a solid tile after moving in X, it is placed flush against that tile's
   face and `vx = 0`; the same for Y. Speeds are capped so one step never moves more than half a
   tile, so checking the tiles at the destination edge is enough (no tunnelling).
3. **One-way platforms (`=`)** only matter when moving down: they block if the feet were at or above
   the platform's top *before* this step and the player isn't holding "down". Coming from below,
   the feet start under the top, so the platform is ignored: you pass up through it and land on it.
   Holding down ignores platforms entirely, so you drop through.
4. Landing sets `grounded`; fuel refills after 0.4 s grounded.

Everything outside the map counts as solid ([map.ts](../server/src/shared/map.ts) `tileAt`).

## 3. Raycasts: DDA through the grid, slab test against players

[server/src/shared/raycast.ts](../server/src/shared/raycast.ts) `castTiles` (line 16), `rayVsBox` (59)

All guns are hitscan: a shot is a ray.

**DDA (digital differential analyzer)** walks the tile grid cell by cell along the ray. From the
start cell it computes how far along the ray the next vertical grid line is (`tMaxX`) and the next
horizontal one (`tMaxY`). It always steps into whichever is closer, then adds the constant spacing
between lines (`tDeltaX = 32 / |dx|`, `tDeltaY = 32 / |dy|`). The first solid cell gives the wall
distance. It visits only the cells the ray actually crosses, so it is exact and fast.

**Slab test** for a ray against a player's box: a box is the overlap of an x-slab and a y-slab.
For each slab compute the ray distances where it enters and leaves; the ray hits the box if the
latest entry comes before the earliest exit (and before the wall distance).

The client fires each pellet ([client/src/game/actor.ts](../client/src/game/actor.ts) `fire`, line 240):
DDA for the wall, slab test against every other player, keep the nearest hit, draw the tracer to it.

## 4. Hit validation ("favour the shooter")

[server/src/index.ts](../server/src/index.ts) `handleShot` (line 866) and [server/src/shared/validate.ts](../server/src/shared/validate.ts)

The shooter's client decides what it hit, because it saw the target where the target was drawn
(100 ms in the past). The server accepts the claim if it's *plausible*, with tolerances for latency:

- the weapon is equipped, allowed in the mode, not reloading, the magazine isn't empty, and at least
  `0.85 / rate` seconds have passed since the last shot (a token bucket allows a short burst when
  two shots arrive in one packet);
- the shot origin is within 48 px of the shooter's current or previous server position;
- for each claimed target: same room, alive, not spawn-protected; a clear DDA raycast to some part of
  its **current** body (shins, chest or head, so cover wins but a player peeking over a low wall can
  still be hit); its current or previous position within range + 64 px; and the claim's own ray angle
  passing within the target's half-diagonal + 40 px (`pointToRayDistance`).

Damage always comes from the **server's** weapon table and the **server's** distance (shotgun falloff),
times the Frenzy multiplier. A claim cannot report more pellets than the target's size allows at that
distance (`maxPelletsAt`: the share of the cone the body fills, plus two). Hit markers and damage numbers appear only when the
server's `hit_ev` arrives, so you never see a hit the server refused.

Movement is validated in `sync` in two steps. `validateMove` is the sanity check: inside the map, not
overlapping a solid tile, no farther than `1400 × dt × 1.3 + 24` px, and a clear path between the two
positions (`isPathClear`, so a step cannot cross a wall or floor). `spendMove` is the speed check. It
keeps a per-axis travel credit that refills at the speed physics allows right now and caps at 96 px:
run speed sideways and hop speed upward, plus `boost`, a bonus earned from real impulses (recoil, the
knife lunge, a nearby blast) that fades at the air-drag rate. The credit absorbs jitter without
raising the speed a client can sustain. A rejected move increments `player.correction`; the client
sees that and snaps back.

Knife hits are found by the server itself (`meleeHits`: within 72 px, within ±70° of the swing,
clear line of sight).

## 5. Remote player interpolation

[client/src/net/interp.ts](../client/src/net/interp.ts) `SnapshotBuffer.sample` (line 55)

Position updates for other players arrive about 20 times a second, unevenly. Each update is stored
in a 20-entry ring buffer stamped with the server time it was accepted. Every frame each remote
player is drawn at **`serverNow() − 100 ms`**: we find the two snapshots either side of that time and
interpolate position (linearly) and aim (the short way round the circle). Because we render slightly
in the past there is almost always a newer snapshot to interpolate toward, so motion is smooth even
when packets bunch up. If no newer snapshot exists, we extrapolate along the last velocity for at
most 100 ms, then hold.

`serverNow()` comes from clock sync ([client/src/net/timesync.ts](../client/src/net/timesync.ts) `onPong`, line 32):
`RTT = now − sent`, `offset = serverTime − (sent + RTT/2)`, using the median of the last 5 pings.

### Adaptive delay (why 100 ms was not enough)

Every sync now carries `t`, the time the state was simulated on the sender's clock (its estimate of
server time). The server stores it as `pstate.sentMs`, and receivers stamp snapshots with it, so
the spacing between snapshots is exactly the sender's 50 ms even when packets arrive in bursts.
On a 250 ms connection a snapshot is ~120–250 ms old when it arrives, so a fixed 100 ms delay meant
the client was almost always extrapolating, then snapping back. Now each remote player has a
`LagEstimator` ([client/src/net/interp.ts](../client/src/net/interp.ts)): it measures
`lag = serverNow − sentMs` for every arrival, keeps a running mean and jitter, and draws that player
`mean + 2 × jitter + 35 ms` in the past. The delay grows quickly and shrinks slowly, so the drawn
timeline never jumps.

### Movement checks on the client's timeline

Bunched packets used to cause snap-backs: two syncs sent 50 ms apart could arrive 5 ms apart, and
the server compared the distance moved against its own 5 ms. Now the movement check in `sync` uses
the time between the client's own timestamps. To stop a client from claiming extra time (a speed
hack), the total extra time it may claim over the server's clock is capped at 350 ms (`timeDebtMs`).

### Lag compensation

The server keeps the last 16 accepted positions of each player with their timestamps
(`pmeta.histT/histX/histY`). Each hit claim says when the shooter's view of the target was from
(`viewMs`, the render time of that target). The ray/range check accepts the target's position at
that time (interpolated from history, up to 700 ms back) as well as nearby samples. Line of sight to
the target's **current** body is still required, so ducking fully behind cover always protects you.

## 6. Spawn selection

[server/src/shared/spawn.ts](../server/src/shared/spawn.ts) `pickSpawn` (line 16)

1. Drop every spawn within 200 px of where you died (you never reappear in the same spot).
2. For each remaining spawn, measure the distance to the nearest living opponent.
3. Sort farthest first and pick randomly among the top 3 (randomness from `ctx.random`, which is
   deterministic inside the database).

At round start, everyone gets a distinct spawn from a Fisher–Yates shuffle (`shuffledSpawnOrder`).

## 7. Deterministic grenade simulation

[server/src/shared/grenade.ts](../server/src/shared/grenade.ts) `stepGrenade` (line 54), `simulateGrenade` (99)

When a grenade is thrown the server stores only its start: position, velocity (as f32) and the throw
time. Server and every client then run the **same** simulation on those **same** stored values:
fixed 120 Hz steps of gravity, axis-separated movement, bounces with restitution 0.45 and friction
0.7, landing on one-way platforms, rolling to rest. The code uses only `+ − × ÷` and comparisons
(no `sin`/`cos`, no randomness), which IEEE-754 arithmetic computes identically on every machine.

- The client precomputes the whole flight path once and draws the grenade at the path point for
  `serverNow()` ([game.ts](../client/src/game/game.ts) `grenadeInsert`).
- The scheduled `detonate` reducer runs one step per tick of the fuse and explodes at the result
  ([index.ts](../server/src/index.ts) `detonate`).

So the explosion happens exactly where everyone saw the grenade, without streaming its position.
Damage falls linearly from 80 at the centre to 0 at the blast radius, needs line of sight, and applies
to the thrower too. It is capped at 80 after Frenzy. Each client applies the knockback to its own
soldier (it owns its movement).

**Impact grenades** add two checks. Touching the map depends only on the throw, so `firstTouchTick` runs
the flight once at throw time and the fuse on the row becomes that tick. Nothing else changes: clients
draw the same path and the same reducer detonates it. Touching a player depends on where that player
goes, so at the end of each `sync` the server walks the stretch of flight covered by that packet and
tests it against the sender's body, interpolated between their last two positions, on the sender's
clock (`bodyContact`). A grenade that reached you on your screen hits you, however late the packet
arrives.

## 7a. EMP lift budget

[validate.ts](../server/src/shared/validate.ts) `spendRise`

Clients own their movement, so "the jetpack is off" has to be checked from positions. The vertical speed
of a jump and of a jet are close, so speed alone cannot tell them apart. What differs is how far you can
go: a jump lifts `v² / 2g` = 87 px and then gravity wins. While an EMP is active the server keeps a
budget of that height plus 40 px. Rising spends it, and only standing on real ground (`isStandingOn`)
refills it. A blast's knockback is exempt, since that lift is real. Enforcement starts 0.4 s after the
hit, because the client only learns of the EMP a round trip later and may still be climbing.

## 7b. Random pickup spots

[map.ts](../server/src/shared/map.ts) `findSpots`, [spawn.ts](../server/src/shared/spawn.ts) `pickSpot`

Each map derives its spots once at load: every empty tile with footing below, room for a body above, and
clear of spawns, flag stands and the edge of the acid. Airdrops use the subset with 8 tiles of open air.
`pickSpot` filters out anything under the acid, within 12 tiles of another pickup or within 320 px of a
living player, then picks at random with `ctx.random`. If nothing passes, it relaxes rather than fail.

## 7c. Radar and off-screen arrows

[client/src/render/radar.ts](../client/src/render/radar.ts). Each frame the game lists every living
player with "me / ally / enemy" and how long ago they last fired (shots, knife swings, grenades).
The minimap draws you and allies always, enemies only for 3 s after they fire. For enemies outside
the camera view that fired in the last 2.2 s, an arrow is placed where the line from the screen
centre toward them crosses a rectangle inset from the screen edges, rotated to point at them and
fading with time. Enemies inside the view never get an arrow.

## 8. CPU players

[client/src/game/bot.ts](../client/src/game/bot.ts) `BotBrain.think` (line 66)

Each bot is a real client: its own SpacetimeDB connection and identity, opened from the host's tab.
It runs the same `Actor` code as the local player and sends the same `sync` calls, so the server
validates it like anyone else. The host draws its bots from their own simulation (no network delay).

The brain is a set of human-like limits, tuned per difficulty (Easy / Normal / Hard in the lobby):

- **Sight:** it only notices enemies within its sight range (600–950 px) and in line of sight.
- **Perception delay:** it re-reads the target's position only every 0.15–0.45 s and aims at that
  remembered spot, so moving players are hard to hit.
- **Reaction time:** 0.3–0.8 s after spotting you before it fires.
- **Aim error:** a wandering angular offset (0.07–0.26 rad) that shrinks a little while it keeps you in view.
- **Turn speed:** the aim turns at a limited rate, like a thumb or a mouse hand.
- **Burst fire:** it fires in bursts with pauses; semi-auto weapons are tapped at a human rate.
- **Target choice:** nearer enemies are likelier, with randomness and a penalty for players other bots
  already chase, so bots don't all gang up on the human.
- **Routes:** [nav.ts](../server/src/shared/nav.ts) runs a breadth-first search out from the goal over
  every tile a body fits in, avoiding acid. The distance field is cached per goal, so eight bots heading
  for one flag cost one search. A bot looks 3 tiles along the falling distance, aims for the middle of
  that tile, and fires the jets if the route climbs. A body can span three tiles in the air, so it also
  checks the tile ahead at head and foot height, or it would pin itself under a tunnel's edge. Over
  open air it holds height; with floor close below it walks.
- **Movement:** keeps a weapon-specific distance, strafes and hops, flies over walls and acid, hunts
  your last known position for a few seconds after losing you, then patrols between spawn points.
