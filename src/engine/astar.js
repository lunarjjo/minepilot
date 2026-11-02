'use strict'

// A* over standing positions with baritone-style behavior: admissible
// goal heuristics keep it optimal, and when the goal is unreachable inside
// the loaded world it returns the best PARTIAL path — the node closest to
// the goal it ever saw — instead of a flat failure. limits (node budget,
// wall-clock timeout) make it safe to run on the fleet's event loop.
//
// the core is time-sliced. search() runs synchronously to completion and is
// the parity oracle; searchAsync() expands a bounded number of pops per
// slice and yields through setImmediate in between, so physics ticks, packet
// pumps and steering keep running while a plan computes. pass opts.alive()
// to abort a search that has been superseded — it resolves with status
// 'aborted' rather than throwing, and an abort is never reported as partial.
//
// both entry points expand nodes in EXACTLY the same order — that parity is
// load-bearing, the tests pin it — so a fixture planned synchronously can be
// reproduced slice-by-slice and vice versa.
//
// the contract with callers: a plan is computed against a world snapshot and
// must be revalidated at execution time. do not lock the world while
// planning; trim what went stale and keep walking.

const { MinHeap } = require('./heap')

const DEFAULTS = {
  maxNodes: 150000,
  timeoutMs: 3500,
  sliceNodes: 4096,
  sliceMs: 12
}

function keyOf (n) {
  return n.x + ',' + n.y + ',' + n.z
}

// neighbors: node -> [{ to, cost, ...movement fields }]
// goal: { heuristic(x,y,z), isMet(x,y,z) }

function initSearch (start, goal, neighbors, opts) {
  const o = Object.assign({}, DEFAULTS, opts || {})
  const startH = goal.heuristic(start.x, start.y, start.z)
  const st = {
    o,
    goal,
    neighbors,
    g: new Map([[keyOf(start), 0]]),
    parent: new Map(), // key -> { key, move }
    closed: new Set(),
    open: new MinHeap(),
    t0: Date.now(),
    startH,
    best: { node: start, h: startH, g: 0 },
    expanded: 0,
    done: false,
    result: null
  }
  st.open.push(startH, start)
  return st
}

// advance the search by up to maxPops loop passes (maxPops <= 0 means no
// slice budget — run until the search finishes). mirrors the historical
// loop pass-for-pass: timeout probe, node budget probe, pop, closed set,
// best tracking, goal test, neighbor relax. returns true once the search
// has finished and st.result is set.
function stepSearch (st, maxPops) {
  const sliceT0 = Date.now()
  let pops = 0
  while (st.open.size > 0) {
    if (maxPops > 0) {
      if (pops >= maxPops) return false
      if ((pops & 255) === 0 && Date.now() - sliceT0 > st.o.sliceMs) return false
    }
    pops++

    if ((st.expanded & 1023) === 0 && Date.now() - st.t0 > st.o.timeoutMs) {
      st.result = finish('timeout', st)
      st.done = true
      return true
    }
    if (st.expanded >= st.o.maxNodes) {
      st.result = finish('exhausted', st)
      st.done = true
      return true
    }

    const node = st.open.pop().value
    const k = keyOf(node)
    if (st.closed.has(k)) continue
    st.closed.add(k)
    st.expanded++

    const nodeG = st.g.get(k)
    const h = st.goal.heuristic(node.x, node.y, node.z)
    if (h < st.best.h) st.best = { node, h, g: nodeG }

    if (st.goal.isMet(node.x, node.y, node.z)) {
      st.best = { node, h, g: nodeG }
      st.result = finish('found', st)
      st.done = true
      return true
    }

    for (const move of st.neighbors(node)) {
      const nk = keyOf(move.to)
      if (st.closed.has(nk)) continue
      const tentative = nodeG + move.cost
      const known = st.g.get(nk)
      if (known !== undefined && tentative >= known) continue
      st.g.set(nk, tentative)
      st.parent.set(nk, { key: k, move })
      st.open.push(tentative + st.goal.heuristic(move.to.x, move.to.y, move.to.z), move.to)
    }
  }

  st.result = finish('exhausted', st)
  st.done = true
  return true
}

function search (start, goal, neighbors, opts) {
  const st = initSearch(start, goal, neighbors, opts)
  while (!st.done) stepSearch(st, 0)
  return st.result
}

// cooperative time-sliced planning. each slice expands up to sliceNodes pops
// or st.o.sliceMs milliseconds, then the loop yields once so timers, packet
// pumps and physics get a turn. opts.alive() is polled between slices: the
// moment it reports false the search resolves as 'aborted' — a superseded
// plan, not a failure.
async function searchAsync (start, goal, neighbors, opts) {
  const st = initSearch(start, goal, neighbors, opts)
  while (!st.done) {
    stepSearch(st, st.o.sliceNodes)
    if (st.done) break
    if (st.o.alive && !st.o.alive()) {
      st.result = finish('aborted', st)
      st.done = true
      break
    }
    await new Promise(resolve => setImmediate(resolve))
  }
  return st.result
}

function finish (status, st) {
  const best = st.best
  const moves = []
  const nodes = []
  let k = keyOf(best.node)
  let guard = 0
  while (st.parent.has(k) && guard++ < 1000000) {
    const p = st.parent.get(k)
    moves.unshift(p.move)
    nodes.unshift(p.move.to)
    k = p.key
  }
  nodes.unshift({ x: Math.round(best.node.x), y: Math.round(best.node.y), z: Math.round(best.node.z) })
  const cost = best.g || 0
  // partial means: we could not reach the goal, but we know a place that
  // is strictly closer to it than where we started — worth walking to.
  // an aborted search is a superseded one: the caller has already moved on,
  // so it is neither a walkable partial nor a reportable failure.
  const madeProgress = best.h < st.startH
  const mapped = status === 'found'
    ? 'found'
    : status === 'aborted'
      ? 'aborted'
      : (madeProgress && moves.length ? 'partial' : status)
  return {
    status: mapped,
    moves,
    nodes,
    cost,
    end: best.node,
    endHeuristic: best.h,
    expanded: st.expanded,
    partial: status !== 'found' && status !== 'aborted'
  }
}

module.exports = { search, searchAsync, DEFAULTS }
