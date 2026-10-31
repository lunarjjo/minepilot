# changelog

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
