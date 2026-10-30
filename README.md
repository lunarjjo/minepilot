# minepilot

**Fly one mineflayer bot with full baritone-style control — an interactive 2D map, a complete command grammar, and every process baritone has, in one lightweight web cockpit.**

![ci](https://github.com/lunarjjo/minepilot/actions/workflows/ci.yml/badge.svg)
![license](https://img.shields.io/badge/license-MIT-8b5dff)
![node](https://img.shields.io/badge/node-%3E%3D20-8b5dff)
![minecraft](https://img.shields.io/badge/minecraft-26.3%20%7C%2026.2%20%7C%201.21-8b5dff)
![dependencies](https://img.shields.io/badge/dependencies-5-8b5dff)

mineflayer bots usually live in a terminal. minepilot puts yours in a
cockpit: a live top-down map of every chunk the bot has loaded — real
terrain, color-coded and height-shaded — where **clicking walks the bot,
dragging selects an area to excavate or fill**, and every entity is one
click away from `follow` or `attack`. Under the map runs a faithful port
of [baritone](https://github.com/cabaletta/baritone)'s command grammar,
goals and processes: mine with vein handling, build from schematics, farm,
explore, tunnel, elytra glide, waypoints, selections, backfill — the
works. The full parity ledger lives in
[docs/baritone-parity.md](docs/baritone-parity.md).

## quickstart

```bash
git clone https://github.com/lunarjjo/minepilot.git
cd minepilot
./run.sh demo
```

one command, zero config: a throwaway vanilla server boots (java 25+ →
minecraft 26.2, java 21 → 1.21.8), the bot joins, and the cockpit opens on
http://127.0.0.1:3000. click the map to walk; drag to select; type
`mine 8 stone` in the console. Ctrl-C reaps everything.

to drive **your** server instead:

```bash
MINEPILOT_HOST=your.server MINEPILOT_PORT=25565 ./run.sh connect
# or bare node:
MINEPILOT_HOST=127.0.0.1 MINEPILOT_VERSION=1.21.8 npm start
```

the console is vanilla JS with no build step — node >= 20, curl, and (for
demo mode) java are the only requirements.

## the cockpit

- **the map** — every loaded chunk, topmost block per column, color-coded
  by material and shaded by relative height. pan (right-drag), zoom
  (wheel), follow the bot or freeze the camera. entities are drawn live:
  players cyan, hostiles red, drops amber. the active path paints as an
  amber dashed line with a goal marker; waypoints pin to the terrain.
- **click to command** — left click walks the bot to the column (on top of
  whatever is there, like baritone's click-to-path). left drag selects a
  rectangle and opens the action menu: `excavate`, `fill…`, `walls…`,
  `shell…`, `clear area`, `copy`, `undo`. double-click recenters; entities
  in the side list offer `follow` / `attack` / `goto` menus.
- **the panels** — hearts and food, live position, task and ETA, held
  item; nearby entities; waypoints by tag (home / death / user); the
  inventory grid with equip / drop / craft actions; and a searchable
  settings editor covering every engine knob.
- **the console** — the exact same command grammar as in-game chat
  (baritone's `#` prefix), with history. chat from the game streams into
  the feed; bot replies stream back to the game.

## commands

the grammar is baritone's, minus the `#` when typed in the console:

```text
goto 100 -200            walk to coordinates (or goto diamond_ore)
goal 100 -200 / path     set a goal without moving, then walk it
mine 64 diamond_ore      vein-mining with auto-tool and blacklist
excavate sel             dig out the selection (or a cuboid by coords)
tunnel 3 2 100           dig a 3-high 2-wide 100-deep tunnel
build slab / build hut.litematic  construct blueprints and schematics
farm 48 / farm 48 basecamp  harvest + replant around here or a waypoint
explore 1000             roam toward the closest unseen chunk
follow players / follow entity pig   track players or mobs
attack zombie / flee     hunt or run
elytra 500 1200          glide there (firework boosts when carried)
sel fill dirt / sel sphere glass 4   selection shape tools
wp save user base / wp goal base     waypoints with tags
set allowBreak false     tune any setting live
eta / proc / pause / resume / stop   state and lifecycle
help                     the full list (40+ commands)
```

in-game, prefix with `#` (`#goto 100 -200`, `#mine 16 iron_ore`) — or
whisper. `#come` walks to whoever asked.

## architecture

```
src/
  engine/      A* pathfinder: goals, movement vocabulary, executor
  autopilot.js the baritone equivalent: persistent goal, processes,
               pause/resume, replan-on-splice, eta
  processes/   mine, build, farm, explore, follow, combat, pickup,
               tunnel, excavate, gotoblock, elytra, backfill
  commands.js  the full baritone grammar (pure parser, fully tested)
  commandexec.js one dispatcher for chat, console, map and REST
  inventory.js drop/eat/craft/chest/throwaway policies
  selection.js cuboid selections, shapes, clipboard, undo
  waypoints.js tagged waypoints with persistence
  settings.js  ~80 typed settings across 10 categories
  mapview.js   chunk scanning + viewport streaming for the map
  server.js    http + ws cockpit (REST + live protocol)
  web/         the console — vanilla JS, no build step
  bot.js       connection lifecycle: backoff reconnect, auto-respawn
  version-compat/  minecraft 26.2/26.3 protocol overlay
```

no pathfinder plugin, no framework, 5 runtime dependencies (mineflayer,
minecraft-data, vec3, ws, prismarine-nbt — the last one rides along with
mineflayer anyway and is pinned explicitly for the schematic parser).

## minecraft version support

minepilot tracks the newest Minecraft releases instead of waiting on the
upstream data stack:

| version | support | verified |
| --- | --- | --- |
| 26.3 | vendored overlay (`src/version-compat/`) | live e2e in CI |
| 26.2 | vendored overlay (`src/version-compat/`) | live e2e in CI |
| 26.1, 1.21.x | official minecraft-data | live e2e in CI (1.21.8) |

the overlay self-disables per version: once the installed minecraft-data
ships a version natively, the vendored copy is skipped entirely.

## testing

```bash
npm test          # 122 offline tests: engine, grammar, processes, cockpit
npm run test:live # live e2e against a running vanilla server
```

the offline suite runs the whole stack against a kinematic fake bot —
the same decisions the real bot makes, at unit-test speed. the live suite
boots real vanilla servers in CI (26.3, 26.2, 1.21.8) and drives the bot
through goto, mine, waypoints, pause/resume, excavate, tunnel and a full
gather-and-build cycle.

## known issues

- **live-server build cycle is best-effort**: the builder's logic is fully
  covered by the offline suite (world diff, dig/place ordering, anchors,
  stall handling — 126 tests), but on a live vanilla server a *refused*
  placement racing a hotbar swap can desync mineflayer's window cache and
  lose the carried stack mid-build. the live e2e therefore reports the
  gather-and-build outcome without gating CI on it; mining, excavating,
  tunneling, goto, waypoints and the whole cockpit protocol are all
  hard-required and green. a proper fix wants a cursor-safe equip wrapper
  upstream.
- **elytra** is a glide controller (see the parity doc), not a trajectory
  search.

## license

MIT — same as the botfleet engine it grew out of.
