'use strict'

// A* over standing positions with baritone-style behavior: admissible
// goal heuristics keep it optimal, and when the goal is unreachable inside
// the loaded world it returns the best PARTIAL path — the node closest to
// the goal it ever saw — instead of a flat failure. limits (node budget,
// wall-clock timeout) make it safe to run on the fleet's event loop.

const { MinHeap } = require('./heap')

const DEFAULTS = {
  maxNodes: 150000,
  timeoutMs: 3500
}

function keyOf (n) {
  return n.x + ',' + n.y + ',' + n.z
}

// neighbors: node -> [{ to, cost, ...movement fields }]
// goal: { heuristic(x,y,z), isMet(x,y,z) }
function search (start, goal, neighbors, opts) {
  const o = Object.assign({}, DEFAULTS, opts || {})
  const t0 = Date.now()

  const g = new Map([[keyOf(start), 0]])
  const parent = new Map() // key -> { key, move }
  const closed = new Set()
  const open = new MinHeap()

  const startH = goal.heuristic(start.x, start.y, start.z)
  open.push(startH, start)
  let best = { node: start, h: startH, g: 0 }
  let expanded = 0

  while (open.size > 0) {
    if ((expanded & 1023) === 0 && Date.now() - t0 > o.timeoutMs) {
      return finish('timeout', best, goal, parent, expanded, startH)
    }
    if (expanded >= o.maxNodes) {
      return finish('exhausted', best, goal, parent, expanded, startH)
    }

    const node = open.pop().value
    const k = keyOf(node)
    if (closed.has(k)) continue
    closed.add(k)
    expanded++

    const nodeG = g.get(k)
    const h = goal.heuristic(node.x, node.y, node.z)
    if (h < best.h) best = { node, h, g: nodeG }

    if (goal.isMet(node.x, node.y, node.z)) {
      return finish('found', { node, h, g: nodeG }, goal, parent, expanded, startH)
    }

    for (const move of neighbors(node)) {
      const nk = keyOf(move.to)
      if (closed.has(nk)) continue
      const tentative = nodeG + move.cost
      const known = g.get(nk)
      if (known !== undefined && tentative >= known) continue
      g.set(nk, tentative)
      parent.set(nk, { key: k, move })
      open.push(tentative + goal.heuristic(move.to.x, move.to.y, move.to.z), move.to)
    }
  }

  return finish('exhausted', best, goal, parent, expanded, startH)
}

function finish (status, best, goal, parent, expanded, startH) {
  const moves = []
  const nodes = []
  let k = keyOf(best.node)
  let guard = 0
  while (parent.has(k) && guard++ < 1000000) {
    const p = parent.get(k)
    moves.unshift(p.move)
    nodes.unshift(p.move.to)
    k = p.key
  }
  nodes.unshift({ x: Math.round(best.node.x), y: Math.round(best.node.y), z: Math.round(best.node.z) })
  const cost = best.g || 0
  // partial means: we could not reach the goal, but we know a place that
  // is strictly closer to it than where we started — worth walking to
  const madeProgress = best.h < startH
  return {
    status: status === 'found' ? 'found' : (madeProgress && moves.length ? 'partial' : status),
    moves,
    nodes,
    cost,
    end: best.node,
    endHeuristic: best.h,
    expanded,
    partial: status !== 'found'
  }
}

module.exports = { search, DEFAULTS }
