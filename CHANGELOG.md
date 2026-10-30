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
