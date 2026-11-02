# progress — overnight sprint: non-blocking pathfinding

> live sprint log · started 2026-11-03 00:30 utc+7 · **status: 75%** · milestones 0, 1, 2, 3, 4 done

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
| 5 | full suite green | pending |
| 6 | v0.4.0 release — changelog, readme section, tag | pending |
| 7 | docs & wrap | pending |

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
