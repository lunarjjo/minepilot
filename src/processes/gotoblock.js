'use strict'

// the get-to-block process — baritone's GetToBlockProcess, the engine behind
// "#goto <block_type>", "#find <block>" and "#click x y z". scans loaded
// space for the nearest block of the wanted type, walks adjacent to it and
// (optionally) activates it with a right click.

const { GoalGetToBlock } = require('../engine/goals')

function findNearestBlock (pilot, name, maxDistance) {
  const p = pilot.pos()
  if (!p) return null
  const d = maxDistance || 128
  if (typeof pilot.bot.findBlocks === 'function') {
    const reg = pilot.bot.registry || null
    const meta = reg && reg.blocksByName ? reg.blocksByName[name] : null
    if (meta) {
      const found = pilot.bot.findBlocks({ matching: meta.id, maxDistance: d, count: 8 })
      if (found && found.length > 0) {
        return { x: found[0].x, y: found[0].y, z: found[0].z }
      }
    }
    return null
  }
  // fallback scan over the loaded view
  const R = Math.min(48, d)
  const cx = Math.floor(p.x)
  const cy = Math.floor(p.y)
  const cz = Math.floor(p.z)
  let best = null
  let bestD = Infinity
  for (let dy = -16; dy <= 16; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      for (let dz = -R; dz <= R; dz++) {
        if (pilot.view.name(cx + dx, cy + dy, cz + dz) !== name) continue
        const dd = dx * dx + dy * dy + dz * dz
        if (dd < bestD) {
          bestD = dd
          best = { x: cx + dx, y: cy + dy, z: cz + dz }
        }
      }
    }
  }
  return best
}

// walk adjacent to the nearest block of a type; resolves its position or null
async function runGetToBlock (pilot, name, alive) {
  const target = findNearestBlock(pilot, name, pilot.settings ? pilot.settings.get('mineScanRadius') : 64)
  if (!target) throw new Error(`no ${name} found in range`)
  const goal = new GoalGetToBlock(target.x, target.y, target.z)
  const r = pilot.driveTo(goal)
  if (!r || (r.status !== 'found' && r.status !== 'partial')) {
    throw new Error(`cannot reach any ${name}`)
  }
  if (r.moves && r.moves.length > 0) {
    const ok = await pilot.waitArrival(60000)
    if (!ok) throw new Error(`could not reach the ${name}`)
  }
  if (!alive()) return null
  return target
}

// click a specific block: walk adjacent, then right click (activate) it.
// resolves true when the activation went through.
async function runClick (pilot, x, y, z, alive) {
  const goal = new GoalGetToBlock(x, y, z)
  const r = pilot.driveTo(goal)
  if (r && (r.status === 'found' || r.status === 'partial') && r.moves && r.moves.length > 0) {
    await pilot.waitArrival(60000)
  }
  if (!alive()) return false
  const block = pilot.botBlockAt({ x, y, z })
  if (!block) throw new Error(`no block at ${x} ${y} ${z}`)
  pilot.lookAtCell(x, y, z)
  try {
    if (pilot.bot.activateBlock) await pilot.bot.activateBlock(block)
    else if (pilot.bot._genericPlace) await pilot.bot._genericPlace(block, { x: 0, y: 1, z: 0 }, null)
    else return false
    return true
  } catch (e) {
    pilot.emit('log', `click refused: ${String(e.message || e).slice(0, 60)}`)
    return false
  }
}

module.exports = { runGetToBlock, runClick, findNearestBlock }
