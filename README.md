# minepilot

**Fly one mineflayer bot with full baritone-style control — an interactive 2D map, a complete command grammar, every process baritone has, workstation windows in the cockpit, and a full-auto survival brain that plays like nobody's at the keyboard.**

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

the movement engine itself is **baritone's playbook, written in
javascript from scratch** — see the [credits](#credits) section. it plans
straight runs it can sprint-jump at ~7 blocks/s, tunnels through walls
when the carried tools make that the cheap route, pillars and staircases
up cliffs, bridges gaps one placed block at a time, and digs straight
down to reach goals below it — all in one A* pass that prices every
break and placement before committing.

and when you want the bot to just play: flip `#auto on` and the survival
brain takes over — reflexes, needs and goals, from punching the first
tree to cooking dinner in a furnace it crafted itself.

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

for the full-auto experience on the demo server, type `auto on` in the
console (or click the auto pill in the hud) and watch the log.

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
- **the craft tab** — every recipe in the registry, browsable and
  searchable, each entry showing the variant closest to the current
  inventory with have/need counts and a one-click craft (which still
  walks to a table when the recipe needs one — one crafting path, not
  two).
- **the station tab** — chest windows (grid + deposit / withdraw /
  transfer-all), furnace windows (input / fuel / output slots with live
  smelt + burn bars) and villager trade lists, driven from the ui. the
  bot walks into reach and opens the window itself.
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
feed cow wheat / breed cow   feed and breed animals
sleep / wake / activate lever   right-click the world
elytra 500 1200          glide there (firework boosts when carried)
sel fill dirt / sel sphere glass 4   selection shape tools
wp save user base / wp goal base     waypoints with tags
set allowBreak false     tune any setting live
auto on                  full-auto: the survival brain takes over
eta / proc / pause / resume / stop   state and lifecycle
help                     the full list (60+ commands)
```

in-game, prefix with `#` (`#goto 100 -200`, `#mine 16 iron_ore`) — or
whisper. `#come` walks to whoever asked.

## full-auto

`auto on` (or the hud pill, or the `autoSurvival` setting) hands the bot
to a survival brain layered like a player's instincts:

- **reflexes** — never suspended, not even while you hold the controls:
  flee creepers, fight or flee hostiles depending on health, eat when
  hurt or hungry.
- **needs** — the whole tool ladder from nothing: logs to planks to a
crafting table to a wooden pick, cobble to stone tools, a furnace
(crafted and placed by the bot itself) to smelt iron and cook meat, an
iron sword, armor pieces worn the moment they exist, torches. the food
  pipeline hunts animals and cooks the raw drops. wood never runs out.
- **goals** — with nothing pressing, the bot scouts unseen chunks.

the brain drives the same engine you drive — the autopilot, the
processes, the craft path — never a private lane. any command from you
suspends its goals for a hold window; the reflexes stay on for safety.
a decision that goes nowhere gets a 90-second cooldown, so the loop
cannot spin. `auto off` hands it back.

disconnects don't kill it: a kick, a server restart, a wifi blip — the
session reconnects, the brain suspends and resumes, and full-auto picks
up where it left off. a watchdog restarts any activity that claims a
task but stops moving (and isn't digging or placing) for 20 seconds.

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
  brain.js     the full-auto survival brain: reflexes, needs, goals
  stations.js  workstation windows: chest, furnace, villager, table
  interactions.js feed, breed, sleep, wake, activate
  inventory.js drop/eat/craft/chest/throwaway policies + the
               verified per-iteration craft loop
  selection.js cuboid selections, shapes, clipboard, undo
  waypoints.js tagged waypoints with persistence
  settings.js  ~90 typed settings across 11 categories
  mapview.js   chunk scanning + viewport streaming for the map
  server.js    http + ws cockpit (REST + live protocol)
  web/         the console — vanilla JS, no build step
  bot.js       connection lifecycle: backoff reconnect, auto-respawn
  version-compat/  minecraft 26.2/26.3 protocol overlay
```

no pathfinder plugin, no framework, 5 runtime dependencies (mineflayer,
minecraft-data, vec3, ws, prismarine-nbt — the last one rides along with
mineflayer anyway and is pinned explicitly for the schematic parser).

## non-blocking pathfinding

planning never blocks the game loop. the A\* core runs in cooperative time
slices — `searchAsync()` expands a node budget, yields to the event loop,
and keeps going — so physics, steering and packet pumps keep ticking while
a plan computes. the synchronous `search()` shares the exact same core and
expansion order, which makes it the parity oracle the async path is tested
against.

the planner plans against a snapshot and the executor validates at
execution time: a move that stopped being true trims the plan to the
still-valid prefix and keeps walking it while a replan computes; when the
prefix runs dry the executor reports `replanwait` — never a premature
`arrived`. superseded searches abort through an `alive()` callback instead
of racing a newer plan:

```js
const r = await searchAsync(start, goal, neighbors, {
  alive: () => seq === currentSeq
})
// r.status === 'aborted' — a newer plan superseded this one;
// never degraded into a misleading partial path
```

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
npm test          # 175 offline tests: engine, grammar, processes, cockpit, brain
npm run test:live # live e2e against a running vanilla server
```

the offline suite runs the whole stack against a kinematic fake bot —
the same decisions the real bot makes, at unit-test speed (the brain's
full tool ladder included). the live suite boots real vanilla servers
in CI (26.3, 26.2, 1.21.8) and drives the bot through goto, mine,
waypoints, pause/resume, excavate, tunnel, a full gather-and-build
cycle, workstation windows, animal breeding, sleeping, and a start
from zero inventory to a furnace-cooked dinner under full-auto.

## known issues

- **elytra** is a glide controller (see the parity doc), not a trajectory
  search.
- the full-auto brain is a survival generalist, not a speedrunner: it
  plays safely (flee thresholds, wood margins) and its progression is
  gated by what the world actually offers nearby.
- chained pillars occasionally race the placement ack on high-latency
  servers — the executor verifies each placement, stumbles, splices and
  re-plans, so it costs seconds, not the task.

## credits

**[baritone](https://github.com/cabaletta/baritone)** by
[cabaletta](https://github.com/cabaletta) and contributors, LGPL-3.0 —
the pathfinding system this project's movement engine is modeled on.
minepilot is an independent javascript implementation: no baritone code
was copied (licensing would not allow it into an MIT repo), but the
approach is deliberately, visibly theirs, and this project would not
exist without it. specific ideas carried over, adapted and credited in
the code comments where they live:

- the movement model — A* over standing positions where every legal
  minecraft action (traverse, ascend, descend, fall, swim, climb,
  parkour, pillar, bridge) is an edge with a realistic cost
- the cost constants — walking priced at sprint pace so the heuristic
  never overestimates a sprintable route (their `COST_HEURISTIC`, our
  `SPRINT_FACTOR`), walking off an edge cheaper than walking a block
  (`WALK_OFF_BLOCK_COST`), a flat penalty on every block break
  (`BLOCK_BREAK_ADDITIONAL_PENALTY`)
- dig costs priced with the tools the player actually carries
  (autoTool as a planning input, not just an equip)
- the goal system — GoalBlock / GoalNear / GoalXZ / GoalRunAway /
  GoalInverted / GoalTwoBlocks and the composites
- the executor behavior — segment merging with sprint, sprint-jumping
  flat straights, digging what is in the way, placing what is missing,
  splicing into a replan when the world changes under the plan
- the process set and command grammar — #goto, #mine, #follow, #thisway,
  #eta, and the rest of the vocabulary in
  [docs/baritone-parity.md](docs/baritone-parity.md)

if baritone's movement quality is the bar, standing on their shoulders
is how this project reaches for it.

## license

MIT — same as the botfleet engine it grew out of.
