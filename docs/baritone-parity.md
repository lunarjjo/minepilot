# baritone parity

minepilot ports [baritone](https://github.com/cabaletta/baritone) to a
headless mineflayer bot. this file is the honest ledger: every baritone
command, process, goal and notable setting, and where it lives here
(or why it cannot exist in a headless bot).

## commands

| baritone | minepilot | notes |
| --- | --- | --- |
| `#help [command]` | `help [command]` | same, plus the minepilot extras |
| `#set <key> [value]` | `set <key> [value]` | `set list` / `set modified` / `set reset [key]` included |
| `#modified` `#mod` `#baritone` `#modifiedsettings` | aliases of `set modified` | |
| `#reset [key]` | `reset [key]` | alias of `set reset` |
| `#goal <x y z\|x z\|y\|clear>` | `goal ...` | `goal` (feet) and `~` relative coords too |
| `#goto <x y z\|x z\|block>` | `goto ...` | block-type goto via the get-to-block process |
| `#path` | `path` | walks the persistent goal |
| `#proc` | `proc` | task, goal, progress, replans |
| `#eta` | `eta` | blocks + seconds estimate |
| `#version` | `version` | minepilot + mineflayer + minecraft versions |
| `#repack` | `repack` | rebuilds the map cache (the cockpit's "chunk cache") |
| `#build <schematic> [x y z]` | `build ...` | json blueprints + `.litematic` + `.schem` + `.schematic`, `~` relative |
| `#litematica <file>` | `litematica <file>` | |
| `#schematica` | — | commented out upstream (dead in baritone itself) |
| `#come [player]` | `come` | chat callers tracked for bare `#come` |
| `#axis [y]` | `axis [y]` | `axisHeight` setting honored (default 120) |
| `#forcecancel` | `forcecancel` | goal + processes + controls |
| `#gc` | `gc` | heap report, `--expose-gc` aware |
| `#invert` | `invert` | GoalInverted over the current goal |
| `#tunnel [h w d]` | `tunnel ...` | cross-section slices along the facing |
| `#render` | `render` | toggles cockpit path/goal drawing |
| `#farm [range] [waypoint]` | `farm ...` | waypoint-anchored ranges |
| `#follow player\|players\|entity\|entities` | `follow ...` | all four forms |
| `#pickup [radius]` | `pickup` | |
| `#explorefilter <file> [invert]` | `explorefilter ...` | chunk lists, invert |
| `#reloadall` | `reloadall` | waypoints + map cache |
| `#saveall` | `saveall` | waypoints to disk |
| `#explore [x z]` | `explore [x z\|radius]` | origin + radius |
| `#blacklist [x y z]` | `blacklist` | mine-process blacklist |
| `#find <block>` | `find` | nearest loaded occurrence |
| `#mine <blocks> [count]` | `mine ...` | both argument orders, vein mining |
| `#click` | `click <x y z>` + map clicks | right-click walk-and-activate; beds save home waypoints |
| `#surface` `#top` | `surface` | |
| `#thisway <distance>` | `thisway` | GoalStrictDirection |
| `#wp save\|goal\|list\|info\|delete\|clear` | `waypoints ...` | tags: home / death / user |
| `#sethome` `#home` | same | sugar over the home tag |
| `#sel <action>` | `sel ...` | all 18 actions (below) |
| `#elytra <x z>` | `elytra` | glide controller (below) |
| `#pause` `#resume` `#paused` | same | process pause semantics |
| `#cancel` `#stop` | `cancel` / `stop` | |
| `#damn daniel` | `damn daniel` | back at it again |

### sel actions

`pos1 p1 1` · `pos2 p2 2` · `clear c` · `undo u` · `set fill s f` ·
`walls w` · `shell shl` · `sphere sph` · `hsphere hsph` · `cylinder cyl` ·
`hcylinder hcyl` · `cleararea ca` · `replace r` · `expand ex` ·
`copy cp` · `paste p` · `contract ct` · `shift sh` — all present, with the
baritone short aliases. shape actions become builder jobs; `copy` snapshots
the world volume; `paste` rebuilds it at the feet or coords.

## processes

| baritone | minepilot | notes |
| --- | --- | --- |
| CustomGoalProcess | `goto` / `goal` / `path` | persistent goal + splice replanning |
| GetToBlockProcess | `goto <block>` / `find` / `click` | scan, walk adjacent, activate |
| MineProcess | `mine` | vein mining, blacklist, auto-tool, legitMine |
| BuilderProcess | `build` / `sel` shapes / `paste` | world-diffed dig/place loop |
| FarmProcess | `farm` | harvest + replant, waypoint ranges, waitForGrowth |
| ExploreProcess | `explore` | chunk-grid targets, filter, origin |
| FollowProcess | `follow` | players / entities with live replans |
| ElytraProcess | `elytra` | glide controller (see below) |
| BackfillProcess | backfill setting | executor logs digs; holes refilled after the task |
| InventoryPauserProcess | `allowInventory` setting | headless bots have no screen lock; the flag gates hotbar swaps instead |

## goals

all of baritone's goal types are implemented with admissible heuristics:
`GoalBlock`, `GoalXZ`, `GoalYLevel`, `GoalNear`, `GoalComposite` (or),
`GoalCompositeAnd`, `GoalInverted`, `GoalRunAway`, `GoalTwoBlocks`,
`GoalAxis`, `GoalStrictDirection`, `GoalGetToBlock` (exact baritone
adjacency formula), plus a dynamic `GoalFollow`.

## settings

~80 typed settings across 10 categories. every baritone setting whose
semantics exist in a headless mineflayer bot is ported with the same name
and default where the cost model matches (`blockBreakAdditionalPenalty`
2, `avoidBreakingMultiplier` 0.1, `acceptableThrowawayItems`, ...).

notable deltas:

- `blockPlacementPenalty` default 4 (baritone 20): minepilot's bridge
  movement is slower than a client mod's, so the tuned-down value reflects
  real placement cost. change it freely.
- `jumpPenalty` default 0: `ascendCost` (2) already prices the jump, which
  is what baritone's default of 2 bakes into its ascend cost.
- `allowSwimming` default true (baritone false): baritone disables it for
  client lag; a headless bot has no frames to drop.
- `elytra*` settings steer the glide controller.
- minepilot extras: `mapChunkRadius`, `reconnect*`, `autoEat*`,
  `mineScanRadius`, `veinRadius`, `stuckTimeoutMs`, `logVerbosity`,
  `allowPillar` (opt-in: a headless client cannot verify its own pillar
  placement acks — bridge stays on, pillar does not, see the readme).

settings that cannot exist headless (documented, not silently dropped):
rendering-thread knobs (`renderPathIgnoreDepth`, line widths — the cockpit
draws its own overlay), `freeLook` / `smoothLook` (camera semantics),
`antiCheatCompatibility` (movement packet interleaving specifics),
`chunkCaching` / `pruneRegionsFromRAM` (mineflayer owns the chunk cache),
`legitMine`-adjacent timing knobs that simulate a real player's input cadence.

## honest limits

- **elytra**: baritone's elytra is a beta trajectory search; minepilot's is
  a glide controller (pitch management + firework boosts + walk-out). no
  simulated-flight A* yet — a full physics simulation is future work.
- **schematica**: reads the three open schematic formats; the in-client
  schematica mod integration is client-only by definition.
- **version coverage**: identical approach to botfleet — official
  minecraft-data where it exists, a vendored protocol overlay for the
  newest releases (26.2 / 26.3 today) that self-disables upstream.
