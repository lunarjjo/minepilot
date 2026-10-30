'use strict'

// the explore process — botfleet's take on baritone's ExploreProcess.
// the unit walks to the nearest unvisited chunk target within a radius,
// marks it visited, and repeats until the ring is covered or the world
// runs out. targets sit on a 16-block chunk grid (chunk centers), so a
// pass paints a fair spiral over the neighborhood instead of hugging
// one line. partial paths (the goal beyond the loaded world) still
// count: walk to the fog edge, replan as chunks load, exactly like the
// pilot's goto contract.

const { GoalXZ } = require('../engine/goals')

const CHUNK = 16
const MIN_LEG = 10 // closer than this is not a journey
const MAX_LEGS = 64
const MAX_CONSECUTIVE_FAILS = 3

function ckey (cx, cz) {
  return cx + ',' + cz
}

// nearest chunk-center target that has not been visited yet, measured
// from the exploration ORIGIN (not the current position) — baritone
// explores a bounded ring around where the process started, otherwise a
// target-chasing walk drifts across the map without ever finishing
function pickTarget (pilot, visited, radius, origin) {
  const p = origin || pilot.pos()
  const live = pilot.pos()
  if (!p) return null
  const ccx = Math.floor(p.x / CHUNK)
  const ccz = Math.floor(p.z / CHUNK)
  const ring = Math.ceil(radius / CHUNK)
  let best = null
  let bestD = Infinity
  for (let dx = -ring; dx <= ring; dx++) {
    for (let dz = -ring; dz <= ring; dz++) {
      const cx = ccx + dx
      const cz = ccz + dz
      const k = ckey(cx, cz)
      if (visited.has(k)) continue
      const tx = cx * CHUNK + CHUNK / 2
      const tz = cz * CHUNK + CHUNK / 2
      const d = Math.hypot(tx - p.x, tz - p.z)
      if (d > radius) continue
      if (live) {
        const ld = Math.hypot(tx - live.x, tz - live.z)
        if (ld < MIN_LEG) continue // already standing on it
      }
      if (d < bestD) {
        bestD = d
        best = { x: Math.round(tx), z: Math.round(tz), k }
      }
    }
  }
  return best
}

// roam until the ring around the origin is covered. returns { legs }.
async function runExplore (pilot, radius, alive) {
  const visited = new Set()
  const origin = pilot.node()
  if (origin) {
    visited.add(ckey(Math.floor(origin.x / CHUNK), Math.floor(origin.z / CHUNK)))
  } else {
    return { legs: 0 }
  }
  const originPos = { x: origin.x, z: origin.z }

  let legs = 0
  let fails = 0
  while (alive() && legs < MAX_LEGS) {
    const target = pickTarget(pilot, visited, radius, originPos)
    if (!target) {
      pilot.emit('log', `explored ${legs} targets within ${radius} blocks`)
      return { legs }
    }
    const goal = new GoalXZ(target.x, target.z)
    const r = pilot.driveTo(goal)
    if (!r || (r.status !== 'found' && r.status !== 'partial')) {
      // unreachable for now: remember it, try the next target
      visited.add(target.k)
      fails++
      if (fails >= MAX_CONSECUTIVE_FAILS * 4) break
      continue
    }
    const ok = await pilot.waitArrival()
    visited.add(target.k)
    legs++
    if (ok) {
      fails = 0
    } else {
      fails++
      if (fails >= MAX_CONSECUTIVE_FAILS) {
        pilot.emit('log', `explore stopped after ${legs} legs: the terrain refuses`)
        return { legs, stopped: true }
      }
    }
  }
  return { legs }
}

module.exports = { runExplore, pickTarget, CHUNK }
