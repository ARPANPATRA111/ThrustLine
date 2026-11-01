# Algorithms

Short explanations of the techniques in THRUSTLINE, with pointers into the code. Paths are relative
to the repo root.

## 1. Fixed-timestep game loop

[client/src/game/game.ts](../client/src/game/game.ts) `frame()` (line 502)

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

[server/src/shared/physics.ts](../server/src/shared/physics.ts) `stepPlayer` (line 77), `moveX` (131), `moveY` (166)

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

The client fires each pellet ([client/src/game/actor.ts](../client/src/game/actor.ts) `fire`, line 230):
DDA for the wall, slab test against every other player, keep the nearest hit, draw the tracer to it.

## 4. Hit validation ("favour the shooter")

[server/src/index.ts](../server/src/index.ts) `handleShot` (line 818) and [server/src/shared/validate.ts](../server/src/shared/validate.ts)

The shooter's client decides what it hit, because it saw the target where the target was drawn
(100 ms in the past). The server accepts the claim if it's *plausible*, with tolerances for latency:

- the weapon is equipped, allowed in the mode, not reloading, the magazine isn't empty, and at least
  `0.85 / rate` seconds have passed since the last shot (a token bucket allows a short burst when
  two shots arrive in one packet);
- the shot origin is within 48 px of the shooter's current or previous server position;
- for each claimed target: same room, alive, not spawn-protected; its current or previous position is
  within range + 64 px; a DDA raycast from the origin to it is clear (no shooting through walls); and
  the claimed ray passes within the target's half-diagonal + 40 px (`pointToRayDistance`).

Damage always comes from the **server's** weapon table and the **server's** distance (shotgun falloff,
at most 7 pellets), times the Frenzy multiplier. Hit markers and damage numbers appear only when the
server's `hit_ev` arrives, so you never see a hit the server refused.

Movement is validated the same way in `sync` (line 655): inside the map, not overlapping a solid
tile, and no farther than `1400 × dt × 1.3 + 24` px from the last accepted position. A rejected move
increments `player.correction`; the client sees that and snaps back.

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
- The scheduled `detonate` reducer runs 300 steps (2.5 s × 120 Hz) and explodes at the result
  ([index.ts](../server/src/index.ts) line 942).

So the explosion happens exactly where everyone saw the grenade, without streaming its position.
Damage falls linearly from 90 at the centre to 0 at 150 px, needs line of sight, and is halved on the
thrower. Each client applies the knockback to its own soldier (it owns its movement).

## 8. CPU players

[client/src/game/bot.ts](../client/src/game/bot.ts) `BotBrain.think` (line 40)

Each bot is a real client: its own SpacetimeDB connection and identity, opened from the host's tab.
It runs the same `Actor` code as the local player and sends the same `sync` calls, so the server
validates it like anyone else. Its brain is a few heuristics evaluated every step: target the nearest
enemy (preferring visible ones), aim with an error that shrinks the longer the target stays in view,
wait a 0.3 s reaction time before firing, keep a weapon-specific distance, thrust over walls and
toward targets above, look ahead for acid and fly over it, and hop when stuck.
