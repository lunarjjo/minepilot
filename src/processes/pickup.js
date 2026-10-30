'use strict'

// the pickup process — walk to nearby dropped item entities and stand on
// them so they land in the inventory (baritone #pickup).

const { GoalNear } = require('../engine/goals')

function itemEntities (pilot, radius) {
  const p = pilot.pos()
  if (!p) return []
  const out = []
  try {
    for (const e of Object.values(pilot.bot.entities || {})) {
      if (!e || e.name !== 'item' || !e.position) continue
      if (e.position.distanceTo(p) > radius) continue
      out.push(e)
    }
  } catch (e) { return [] }
  out.sort((a, b) => a.position.distanceTo(p) - b.position.distanceTo(p))
  return out
}

async function runPickup (pilot, radius, alive) {
  let collected = 0
  let rounds = 0
  while (alive() && rounds < 64) {
    rounds++
    const items = itemEntities(pilot, radius)
    if (items.length === 0) break
    const target = items[0]
    const goal = new GoalNear(Math.floor(target.position.x), Math.floor(target.position.y), Math.floor(target.position.z), 0)
    const r = pilot.planNow(goal)
    if (r.status !== 'found' && r.status !== 'partial') break
    pilot.executor.run(r.moves)
    await pilot.waitArrival(15000)
    collected++
    // give the server a moment to run the pickup
    await new Promise((res) => setTimeout(res, 350))
  }
  pilot.emit('log', `picked up ${collected} drop${collected === 1 ? '' : 's'}`)
  return { collected }
}

module.exports = { runPickup, itemEntities }
