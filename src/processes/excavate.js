'use strict'

// the excavate process — dig out every block in a cuboid (baritone's old
// #excavate, kept as a first-class minepilot command and as the engine
// behind #sel cleararea). walks cell to cell nearest-first, digs what is
// within reach, steps aside before digging its own floor column, and
// refuses vetoed blocks (blocksToDisallowBreaking) honestly.

const { GoalNear } = require('../engine/goals')
const { normCuboid } = require('../selection')
const { equipForDig } = require('../autotool')

const MAX_CELLS = 32768

function sleep (ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function ownCells (pilot) {
  const p = pilot.pos()
  if (!p) return []
  const x = Math.floor(p.x)
  const y = Math.floor(p.y)
  const z = Math.floor(p.z)
  return [{ x, y, z }, { x, y: y + 1, z }]
}

// every solid, breakable, non-air cell of the cuboid that still needs digging
function remaining (pilot, c) {
  const out = []
  for (let x = c.minX; x <= c.maxX; x++) {
    for (let y = c.minY; y <= c.maxY; y++) {
      for (let z = c.minZ; z <= c.maxZ; z++) {
        const name = pilot.view.name(x, y, z)
        if (!name) continue // fog
        if (name === 'air' || name === 'cave_air' || name === 'void_air' || name === 'light') continue
        const info = pilot.view.breakInfo(x, y, z)
        if (!info || !info.breakable) continue // vetoed or bedrock
        out.push({ x, y, z, name })
      }
    }
  }
  return out
}

function dist (pilot, cell) {
  const p = pilot.pos()
  if (!p) return Infinity
  const dx = (cell.x + 0.5) - p.x
  const dy = (cell.y + 0.5) - p.y
  const dz = (cell.z + 0.5) - p.z
  return dx * dx + dy * dy + dz * dz
}

function withinReach (pilot, cell) {
  const p = pilot.pos()
  if (!p) return false
  const dx = (cell.x + 0.5) - p.x
  const dy = (cell.y + 0.5) - (p.y + 1.6)
  const dz = (cell.z + 0.5) - p.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz) <= 4.2
}

// run the excavation. from/to are { x, y, z } corners.
async function runExcavate (pilot, from, to, alive) {
  const c = normCuboid(from, to)
  const volume = (c.maxX - c.minX + 1) * (c.maxY - c.minY + 1) * (c.maxZ - c.minZ + 1)
  if (volume > MAX_CELLS) {
    throw new Error(`cuboid has ${volume} cells, cap is ${MAX_CELLS}`)
  }
  let dug = 0
  let stalls = 0
  while (alive()) {
    const cells = remaining(pilot, c)
    if (cells.length === 0) break
    cells.sort((a, b) => dist(pilot, a) - dist(pilot, b))
    const cell = cells[0]
    // never dig our own standing column without stepping aside
    const mine = ownCells(pilot)
    const inOwnColumn = mine.some((o) => o.x === cell.x && o.z === cell.z && (o.y === cell.y || o.y === cell.y - 1))
    if (inOwnColumn || !withinReach(pilot, cell)) {
      const goal = new GoalNear(cell.x, cell.y, cell.z, 2)
      const r = await pilot.driveTo(goal)
      if (!r || (r.status !== 'found' && r.status !== 'partial' && r.status !== 'partial-stuck')) {
        stalls++
        if (stalls > 8) throw new Error('excavate stalled: cannot reach the remaining cells')
        await sleep(300)
        continue
      }
      await pilot.waitArrival(20000)
    }
    if (!alive()) break
    if (pilot.settings && pilot.settings.get('autoTool')) await equipForDig(pilot.bot, cell.name)
    const ok = await pilot.digCell(cell)
    if (ok) {
      dug++
      stalls = 0
      pilot.emit('progress', { index: dug, total: dug + cells.length - 1 })
    } else {
      stalls++
      if (stalls > 8) throw new Error('excavate stalled: cells refuse to break')
    }
  }
  pilot.emit('log', `excavated ${dug} blocks`)
  return { dug }
}

module.exports = { runExcavate, remaining }
