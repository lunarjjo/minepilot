'use strict'

// the combat process — hunt and attack a target (entity type or player
// name) until it dies or disappears. minepilot extra (baritone has no
// combat command; the web console and #attack use this).

const { GoalNear } = require('../engine/goals')

const ATTACK_COOLDOWN_MS = 620 // vanilla sword swing cooldown
const REACH = 3.4

function entityName (e) {
  if (!e) return null
  if (e.username) return e.username
  return e.name || (e.type) || null
}

// find the closest matching living entity
function findTarget (pilot, target) {
  const p = pilot.pos()
  if (!p) return null
  let best = null
  let bestD = Infinity
  try {
    for (const e of Object.values(pilot.bot.entities || {})) {
      if (!e || !e.position || e === pilot.bot.entity) continue
      const name = entityName(e)
      if (!name) continue
      const match = name.toLowerCase() === target.toLowerCase()
      if (!match) continue
      const d = e.position.distanceTo(p)
      if (d < bestD) { bestD = d; best = e }
    }
  } catch (e) { return null }
  return best
}

async function attackEntity (pilot, entity) {
  try {
    if (pilot.bot.attack) await pilot.bot.attack(entity)
    return true
  } catch (e) {
    pilot.emit('log', `attack failed: ${String(e.message || e).slice(0, 60)}`)
    return false
  }
}

async function sleep (ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// run the hunt. resolves { kills, target } when the target is dead or gone.
async function runCombat (pilot, target, alive) {
  let kills = 0
  let misses = 0
  while (alive()) {
    const entity = findTarget(pilot, target)
    if (!entity) {
      if (kills === 0 && misses === 0) throw new Error(`no ${target} in range`)
      break
    }
    if (!entity.position) break
    const p = pilot.pos()
    if (!p) break
    const d = entity.position.distanceTo(p)
    if (d > REACH) {
      // walk to it — the goal follows the live entity position
      const goal = new GoalNear(Math.floor(entity.position.x), Math.floor(entity.position.y), Math.floor(entity.position.z), 2)
      const r = pilot.planNow(goal)
      if (r.status !== 'found' && r.status !== 'partial') {
        misses++
        if (misses > 8) throw new Error(`cannot reach the ${target}`)
        await sleep(400)
        continue
      }
      pilot.executor.run(r.moves)
      await pilot.waitArrival(20000)
      continue
    }
    // in reach: look at it and swing
    try {
      if (pilot.bot.lookAt) pilot.bot.lookAt(entity.position.offset ? entity.position.offset(0, 1, 0) : entity.position)
    } catch (e) { /* ignore */ }
    const hit = await attackEntity(pilot, entity)
    if (hit) misses = 0
    const stillThere = findTarget(pilot, target) === entity
    if (!stillThere) kills++
    await sleep(ATTACK_COOLDOWN_MS)
  }
  return { kills, target }
}

module.exports = { runCombat, findTarget, entityName }
