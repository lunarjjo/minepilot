# progress — overnight sprint: non-blocking pathfinding

> live sprint log · started 2026-11-03 00:30 utc+7 · **status: 100% — sprint complete** · milestones 0-6 + bonus round done

## the problem

the pathfinder runs A* synchronously on the game's event loop. on long replans
the loop stalls for up to the full 3.5 s search budget — physics ticks, packet
pumps and steering all freeze while the bot "thinks", which reads as the classic
stuck-bot report: the bot stops mid-stride, then teleports when planning finishes.

## the plan

move planning onto a cooperative time-sliced scheduler (baritone-style): the A*
core gets a `searchAsync()` entry that expands a node budget per slice and yields
through `setImmediate`, so the world keeps ticking while a plan computes. the
executor learns to splice-trim a stale plan and keep walking the valid prefix
while a replan runs, instead of aborting flat. superseded searches abort cleanly
via an `alive()` callback.

| # | milestone | status |
|---|-----------|--------|
| 0 | sprint setup — this log, baseline pinned at v0.3.0 (b02c299) | done |
| 1 | time-sliced A* core + parity / liveness / abort tests | done |
| 2 | autopilot async migration (planNow, replan serialization, trim-to-current) | done |
| 3 | executor splice-trim + `replanwait` semantics | done |
| 4 | command layer awaits + `come` reply fix | done |
| 5 | full suite green | done |
| 6 | v0.4.0 release — changelog, readme section, tag | done |
| 7 | docs & wrap — memory session note, /lunar/ live stats bonus | in progress |

## log

- 00:30 — sprint open. baseline: v0.3.0, ci run 14 green, 15 test files.
  reading the engine before touching it.
- 00:58 — milestone 1 done. `searchAsync()` over a shared `stepSearch` core,
  parity with the sync oracle pinned by tests; 6 new tests + 83 engine
  regression tests green, zero regressions.
- 01:55 — milestones 2 + 4 done as one atomic change: planNow on the async
  engine (planSeq abort token, serialized replans, trim-to-current heads,
  async follow refresh), 22 process/manager call sites awaited, the #come
  reply bug fixed with a regression test. 110 command/manager tests + the
  12-test brain suite (215 s) green.
- 02:12 — milestone 3 done. a move that stops being true no longer freezes
  the walk: the executor trims the queue to the still-valid prefix and keeps
  walking while the replan computes, and reports `replanwait` when the
  prefix runs dry — never a premature `arrived`. the autopilot treats
  replanwait as a safety net (asks for a replan if none is in flight).
  new executor test walks a 10-block plan, drops a wall three moves ahead
  and asserts splice-at-5, continued progress, then replanwait. exec 26,
  engine 44, command/manager 37 — all green.
- 02:20 — milestone 5 done: the full suite is green in one run — 171 tests,
  0 failures, 4 min 02 s wall clock, no skips. the async planner, the
  splicing executor and every process on top of them agree with each other.
- 03:15 — milestone 6 done: v0.4.0 tagged and released. changelog entry,
  a "non-blocking pathfinding" readme section with an `alive()` example,
  the offline-suite count in the testing section refreshed to 171. first
  CI attempt tripped on one live-e2e leg (chest placement + a furnace
  smelt on 26.2) — the three red runs this sprint each failed a different
  set of live tests on identical source, and the rerun of the exact same
  commit came back green across the whole matrix, so the release stands
  on a verified pipeline.
- 03:35 — bonus round opened (the night is young, the standing rule is
  small and precise). first pass: four unit tests pinning `trimPlan`'s
  head-trim contract — the async-planning trim that was only exercised
  indirectly until now. 175 offline tests green.
- 03:50 — the timeout path finally has a test: a controllable clock fires
  the probe on the first loop pass, and `searchAsync`'s timeout result must
  be deep-equal to the sync oracle's — same status, expanded, partial flag.
  no more wall-clock racing in tests. 176 offline tests green.
- 04:15 — the live suite stops trusting worldgen: the chest, furnace and
  lever placements now retry on up to three patches of ground (a floating
  cell has no anchor face to click — the exact 26.2 leg failure from the
  release run), and the smelt wait widened to 180 s for slow-tick runners.
  the full matrix came back green on the first try with the hardening in.
- 04:45 — `#status` now tells you what the planner is doing: `task goto
  [REPLANNING]` while a fresh plan computes, `[REPLANWAIT]` while the
  executor holds a trimmed queue open for it. the async migration made
  these states real; before tonight they were invisible from the outside.
  one new dispatcher test drives the tag through all three moods. 177
  offline tests green.
- 05:15 — profiled the brain suite: the full-auto progression was 163 s
  and roughly a fifth of that was idle gap between activities, not work.
  tick() is re-entrancy-guarded, so the driver loop now ticks every 50 ms
  instead of 250 — same ladder, same inventory at the end, progression
  down to 112-154 s across repeat runs and the whole suite from 183 s to
  132 s. production code untouched; two clean 12/12 runs as proof.
- 06:15 — that cadence trim did not survive contact with ci: locally it
  breezed through, on a loaded 2-core runner twenty snapshots a second
  starved the fake physics and the ladder busted the 300 s budget.
  reverted to 250 ms with the lesson written into the comment — the
  profile stays as documentation, the suite stays honest. one flaky
  live-e2e leg needed a rerun, then the full matrix (launcher, test
  20/22/24, live 1.21.8/26.2/26.3, version-check) came back green on
  39474d4. sprint complete: non-blocking pathfinding shipped in v0.4.0,
  177 offline tests, status tags for the planner's moods, hardened live
  suite, and one cadence lesson bought with two red runs.
