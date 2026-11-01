# changelog

## 0.3.0 — the baritone-grade movement overhaul

field reports drive this one: the bot got stuck, free-fell, took wrong
routes, could not climb, dug with bare hands mid-path, and full-auto
sometimes just stood there. every report traced to real bugs, and each
fix carries a regression test:

- **chained placements were unplannable** — the A\\* searched the world
  as-is, but a bridge's support block only exists after the placement,
  so every plan ended after ONE placed block and the executor replanned
  per block forever. movements now mark their destination
  `placedSupport` and the search chains bridges, pillars and staircases
  in a single pass: a 9-bridge crossing is one plan.
- **the lookahead validator doomed chains** — it regenerated the full
  movement list from a planned node, and a chained bridge's successor
  "never existed" until its predecessor placed. bridging replanned
  forever without placing anything. `validateMove()` now checks what
  executing the move in order actually needs — cheaply, every other
  tick.
- **digs are tool-priced and tool-swung** — the planner priced every
  break with bare hands (a pickaxe divides stone cost by 6), so it
  detoured around walls it should have tunneled through; and the
  executor never equipped a tool mid-path, mining stone at 7.5 seconds
  a block by hand. costs use the carried tools; every dig equips the
  best one.
- **the executor drives like baritone** — collinear segments merge into
  one steer target (no more per-cell control stutter), sprint engages
  on straight runs, sprint-jump bunny-hops flat straights (~7 blocks/s
  on flat ground, live-measured), and passing a node advances instead
  of orbiting back to it. goal heuristics are priced at sprint pace so
  A\\* stops dismissing the fast routes.
- **vertical mobility** — diagonalAscend implemented (the setting
  existed but did nothing), ascendPlace staircases up broken terrain,
  digFall digs straight down one block per break with zero fall damage,
  bridging covers drops deeper than the no-damage budget, and pillar is
  on by default now that placements are verified (the rocket-tower
  failure mode is gone).
- **full-auto survives disconnects** — `bot.on('end')` used to call
  `brain.dispose()` (a permanent flag): ONE kick, restart or wifi blip
  and the brain was dead for the rest of the process while the cockpit
  kept reporting it ON. disconnects now suspend; the reconnect resumes.
- **reflexes actually interrupt now** — the tick loop held its guard
  across whole activities (gather waits up to 180s), so the busy branch
  never ran while the bot was busy. activities run fire-and-forget and
  the loop keeps ticking; findBlocks probes go through a 5s memo.
- **a movement watchdog** (`autoWatchdogMs`, 20s) — a claimed task with
  zero movement and zero dig/place work gets restarted and briefly
  tabooed. "the bot does not move" becomes "the bot retries".
- **mine steps aside before digging a vein under its own feet** — the
  approach goal legally landed the bot on top of shallow veins, and
  digging the floor out from under itself dropped the bot into its own
  hole with every following ascend launching from mid-air (the infinite
  jump-bounce).
- planning runs against a CachedView snapshot; long plans stop dying at
  the wall-clock budget. dig timeouts dropped 20s → 8s with one
  re-look/retry before splicing.

verification: 163/163 offline (the kinematic fake grew bridge-chain,
tool-equip, sprint, digFall and brain-lifecycle regressions) and a new
focused live suite — 15/15 against a real vanilla 1.21.8 server:
60 blocks in 8.8s (walk pace is 14s), an 8-wide trench crossed on
placed blocks, a 3-high hill climbed, a shaft dug to bedrock, and
full-auto verified alive after a same-name kick forced a reconnect.

## 0.2.0 — workstations, world interactions and the full-auto brain

the cockpit stops being a command line with a map. three layers landed,
each live-verified against real vanilla servers:

- **workstation windows** (the station + craft tabs): every recipe in
  the registry browsable and one-click craftable (have/need counts,
  table-walking included); chest windows with deposit / withdraw /
  transfer-all; furnace windows with live smelt + burn bars and slot
  control; villager trade lists with repeatable trades. the bot walks
  into reach and opens each window itself.
- **world interactions**: `feed <entity> [item]` and `breed <entity>`
  (a vanilla breeding-food table for 24 mobs), `sleep` / `wake` (find a
  bed, walk, sleep at night), `activate <block>` (levers, doors,
  buttons, trapdoors), all wired into the entity menus too.
- **the full-auto survival brain**: `auto on` and the bot plays —
  reflexes (flee creepers, fight or flee by health, emergency eating),
  needs (the whole tool ladder from punching the first tree to iron
  tools and worn armor, hunting and furnace-cooking its own food,
  torches, wood margins) and goals (scouting unseen chunks). it drives
  the same engine a human driver does, stands down for a hold window
  when a human commands, and cools off decisions that go nowhere.

the launch-day craft flake got its autopsy — three real bugs:

- mineflayer 4.39 removed `bot.openCraftingTable`; the silent typeof
  guard made every 3x3 recipe "unrecipeable". the table block now feeds
  `recipesFor` directly (any truthy 4th argument opens the 3x3 gate).
- multi-craft fires every click back-to-back and a busy server drops
  transactions — 8 crafts could land 6. crafts now run one verified
  iteration at a time with window-state resets between losses.
- a dropped craft strands materials in the 2x2 grid (invisible to
  `items()`), poisoning later crafts and even re-shaping a leftover
  plank into an oak_button. the grid is cleared before every craft and
  after every miss.

also: smelting waits for the whole stack instead of stranding the rest
in the furnace; the brain crafts and places its own furnace before
cooking; taboo cooldowns are keyed per kind+target; `autoSurvival` /
`autoExplore` / `autoHunt` settings; an auto pill in the cockpit hud.

verified: 151 offline tests (9 new brain tables + interactions +
stations); live e2e 58/58 on a real vanilla 1.21.8 server — zero
inventory to a wooden pickaxe to a furnace-cooked dinner under full-auto,
real chest/furnace/trade windows, fed and bred cows, a flipped lever and
a slept-in bed.

## 0.1.0 — the full-control cockpit

- engine: A* pathfinder over standing positions with the full movement
  vocabulary (traverse, diagonal, ascend, descend, fall, swim, climb,
  parkour, pillar, bridge), dig/place-aware costs, partial paths at the
  edge of the loaded world, splice replanning
- goals: every baritone goal type (block, xz, ylevel, near, composite
  or/and, inverted, runaway, twoblocks, axis, strictdirection,
  gettoblock, follow) with admissible heuristics
- autopilot: persistent goals, one foreground process with pause/resume,
  thisway/axis/surface/invert, eta, honest stuck escalation
- processes: mine (vein, blacklist, auto-tool, legitMine), build
  (blueprints + .litematic + .schem + legacy .schematic), farm (waypoint
  ranges, waitForGrowth), explore (origin + chunk filters), follow,
  combat, pickup, tunnel, excavate, goto-block/find/click, elytra glide,
  backfill
- commands: the complete baritone grammar (40+ commands, aliases, ~ relative
  coordinates) shared by in-game chat, the console, map clicks and REST
- cockpit: interactive 2D map (click-to-goto, drag-to-select with action
  menus, pan/zoom/follow, path/selection/waypoint overlays), entity list,
  inventory grid, settings editor, chat feed — vanilla JS, no build step
- inventory: drop/eat/craft/chest policies, auto-eat, throwaway handling
- waypoints: tagged (home/death/user) with persistence; beds and deaths
  auto-save
- selection: cuboids with undo, expand/contract/shift, fill/walls/shell/
  sphere/cylinder shapes, world copy to clipboard
- bot lifecycle: backoff reconnect, auto-respawn, version-compat overlay
  for minecraft 26.2/26.3
- 122 offline tests + a live e2e suite driving real vanilla servers

## 0.1.1 — the live gather-and-build cycle, for real this time

the launch-day e2e suite was red in ci: the launcher died on a bash
env-passing bug and the gather-and-build check failed on every minecraft
version. five real bugs were hiding behind that failure, each found by
reproducing against live vanilla servers:

- fixed: `run.sh` passed `VAR=VAL` words through a quoted `"$@"` prefix —
  bash treated them as a command name and the cockpit never started. also
  fixed: run.sh shipped `PORT` while the stack reads `APP_PORT`, and a
  missing `java` killed the script before its own friendly error could
  print.
- fixed: the stack shut down the moment stdin closed (ci runners, nohup,
  pipes) — stdin eof now only quits a real terminal.
- fixed: the e2e servers spawned hostile mobs (superflat slime chunks!)
  that killed the bot mid-gather; e2e/demo worlds are now peaceful by
  construction, re-asserted across 26.x property regeneration.
- fixed: `build <schem> <x> <z>` anchored at y=0 — a null y leaked from
  the coord parser into the builder (`null + offset` coerces to 0) and
  the build floated in the sky with no anchor faces.
- fixed: the mine process targeted buried blocks whose drops landed in
  sealed pockets no pickup walk could reach — target selection now
  prefers exposed (air-adjacent) blocks and opens the cover above a
  buried one before digging it, the way baritone digs through to a vein.
- changed: pillar is a separate setting (`allowPillar`, default off) —
  a headless client cannot verify its own pillar placement acks and a
  racy pillar burned the gather climbing its own tower; live-anchored
  placement with solid-state verification ships for when it is on.
- changed: arrival forgiveness tightened back to botfleet's numbers; the
  builder retries alternate anchor faces on a refused placement; executor
  no-material spam is logged once per episode and degrades navigation to
  no-place planning outside build jobs.
- verified: 126 offline tests green; live e2e 25/25 on a real vanilla
  1.21.8 superflat server including the full gather-and-build cycle
  (`build complete: 9/9`).
