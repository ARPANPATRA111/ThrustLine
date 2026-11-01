# Lab requirement mapping

Where THRUSTLINE meets each lab requirement. Paths are relative to the repo root.

| Requirement | Where it is met | Code |
| --- | --- | --- |
| Start screen | Loading screen with logo and progress bar, then **Tap to start**; home screen with nickname, Create room, Join room | [client/index.html](../client/index.html) `#scr-loading`, `#scr-home`; [client/src/main.ts](../client/src/main.ts) `boot` |
| Instructions | Visual **How to play** (keycaps and phone diagram, weapon cards with sprites and stat bars, scoring icon cards) | `#scr-howto` in [index.html](../client/index.html) |
| Score | Server-side scoring; mini leaderboard (top 3 + you) on the HUD; full scoreboard on Tab | [server/src/index.ts](../server/src/index.ts) `applyDamage`, `creditKill`; [client/src/ui/hud.ts](../client/src/ui/hud.ts) `setMiniBoard` |
| Timer | Round timer (3/5/8 min, 30 s in dev rooms) at the top of the HUD; turns into a red FRENZY badge in the last minute | `room.endsAtMicros`; [game.ts](../client/src/game/game.ts) `updateHud` |
| Lives (respawns) | 100 HP, no regeneration; on death a 4 s respawn countdown with "eliminated by", then a fresh life with spawn protection | `doRespawn`, `respawnPlayer` in [index.ts](../server/src/index.ts); `#scr-respawn` |
| Controls | Keyboard + mouse, and twin-stick touch controls with action buttons; left-handed layout option | [client/src/game/input.ts](../client/src/game/input.ts), [client/src/ui/touch.ts](../client/src/ui/touch.ts) |
| Animation | Soldiers built from parts and animated in code (leg swing, body bob, arm/gun aim, jet flame), particles, tracers, explosions, parallax scrolling | [client/src/render/soldier.ts](../client/src/render/soldier.ts), [particles.ts](../client/src/render/particles.ts), [effects.ts](../client/src/render/effects.ts) |
| Collision detection | Box vs tile collision with one-way platforms; DDA raycasts and slab tests for bullets; grenade bounces | [server/src/shared/physics.ts](../server/src/shared/physics.ts), [raycast.ts](../server/src/shared/raycast.ts), [grenade.ts](../server/src/shared/grenade.ts) |
| Scoring rules | Kill +100; bounty (3-kill streak) +50 extra; acid or own-grenade death −50; ranking by score, then kills, then fewer deaths | [config.ts](../server/src/shared/config.ts) `SCORE_*`; `rankPlayers` in [hud.ts](../client/src/ui/hud.ts) |
| Difficulty progression | **Frenzy** in the last 60 s: damage ×1.5, fuel refill ×2, red tint, banner, faster music; bounty targets raise the stakes as streaks grow; CPU skill Easy/Normal/Hard and host house rules (HP, respawn, fuel, ammo) | `isFrenzy` in [config.ts](../server/src/shared/config.ts); `frenzyMul` in [index.ts](../server/src/index.ts) |
| Game states | Loading → home → lobby → playing → round over → playing again (or leave); room state 0/1/2 on the server | `room.state`; `route()` in [main.ts](../client/src/main.ts) |
| Multimedia: graphics | Every sprite generated in code at load into one atlas; map baked into 6 textures; 3 parallax layers | [atlas.ts](../client/src/render/atlas.ts), [mapbake.ts](../client/src/render/mapbake.ts) |
| Multimedia: sound effects | Guns, reload, empty click, jetpack loop, explosion, knife, hit, hurt, pickup, UI sounds, all synthesised with `OfflineAudioContext`; stereo panning by position | [client/src/audio/audio.ts](../client/src/audio/audio.ts) |
| Multimedia: music | 8-bar 120 bpm loop (kick, snare, saw bass) and a faster, brighter Frenzy version | `musicRecipe` in [audio.ts](../client/src/audio/audio.ts) |
| Collectibles | Health packs (+50 HP), ammo crates (refill reserve), grenade crates (+1 frag); respawn 20 s after pickup | `collectPickups`, `restorePickup` in [index.ts](../server/src/index.ts) |
| Hazard | Acid pit in the middle of the map: 30 HP per second while you're in it | step 4 of `sync` in [index.ts](../server/src/index.ts) |
| Restart | Host's **Play again** on the round-over screen resets all stats and starts a new round in the same room | `startRound` in [index.ts](../server/src/index.ts); `#btn-again` |
| Multiplayer | 2–8 players per room (free-for-all or red vs blue teams) by 4-letter code or one-tap invite link, real-time over SpacetimeDB; live ping shown per player; CPU players for solo play | [server/src/index.ts](../server/src/index.ts); [client/src/game/bot.ts](../client/src/game/bot.ts) |

Screenshots: [docs/screenshots/](screenshots/) (home, lobby, gameplay, round end, mobile).
