'use strict'

// the backfill process — minepilot's port of baritone's BackfillProcess.
// when the backfill setting is on, every block the executor digs through
// while walking is remembered; when the task that dug them finishes, the
// backfill job walks the recorded cells in reverse order and places a
// throwaway block into each hole, repairing the tunnel behind the bot.

const { GoalNear } = require('../engine/goals')
const { equipForPlace } = require('../engine/place')

const MAX_BACKFILL_CELLS = 2048

// the shared dug-cell log the executor appends to (autopilot owns it)
function dugLog (pilot) {
  if (!pilot.dugCells) {
    pilot.dugCells = []
    pilot.dugCellsSet = new Set()
  }
  return pilot
}

function recordDig (pilot, x, y, z) {
  if (!pilot.settings || !pilot.settings.get('backfill')) return
  dugLog(pilot)
  const k = x + ',' + y + ',' + z
  if (pilot.dugCellsSet.has(k)) return
  if (pilot.dugCells.length >= MAX_BACKFILL_CELLS) return
  pilot.dugCells.push({ x, y, z })
  pilot.dugCellsSet.add(k)
}

function takeDugCells (pilot) {
  dugLog(pilot)
  const cells = pilot.dugCells
  pilot.dugCells = []
  pilot.dugCellsSet = new Set()
  return cells
}

function sleep (ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// refill the recorded holes, farthest-last so the bot walks back the way
// it came. returns { filled }.
async function runBackfill (pilot, cells, alive) {
  if (!cells || cells.length === 0) return { filled: 0 }
  // nearest-first ordering means the bot sweeps back through the tunnel
  const p = pilot.pos()
  const withDist = cells.map((c) => ({
    ...c,
    d: p ? Math.hypot(c.x - p.x, c.y - p.y, c.z - p.z) : 0
  }))
  withDist.sort((a, b) => a.d - b.d)

  let filled = 0
  let stalls = 0
  for (const cell of withDist) {
    if (!alive()) break
    // only holes that are still open and standable-adjacent matter
    if (!pilot.view.passable(cell.x, cell.y, cell.z)) continue
    const p2 = pilot.pos()
    if (p2 && Math.hypot(cell.x - p2.x, cell.y - p2.y, cell.z - p2.z) > 4.5) {
      const r = pilot.driveTo(new GoalNear(cell.x, cell.y, cell.z, 1))
      if (!r || (r.status !== 'found' && r.status !== 'partial' && r.status !== 'partial-stuck')) {
        stalls++
        if (stalls > 4) break
        continue
      }
      await pilot.waitArrival(15000)
    }
    // place a throwaway block into the hole
    const item = await equipForPlace(pilot.view, pilot.bot, null)
    if (!item) {
      pilot.emit('log', 'backfill: out of placeable blocks')
      break
    }
    // find a solid neighbor to click against
    let ref = null
    let face = null
    for (const [dx, dy, dz] of [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]]) {
      if (pilot.view.solid(cell.x + dx, cell.y + dy, cell.z + dz)) {
        ref = pilot.botBlockAt({ x: cell.x + dx, y: cell.y + dy, z: cell.z + dz })
        face = { x: -dx, y: -dy, z: -dz }
        break
      }
    }
    if (!ref || !face) {
      stalls++
      if (stalls > 4) break
      continue
    }
    try {
      pilot.lookAtCell(ref.position.x, ref.position.y, ref.position.z)
      await pilot.placeRefFace(ref, face)
      filled++
      stalls = 0
    } catch (e) {
      stalls++
      if (stalls > 4) break
    }
    await sleep(60)
  }
  pilot.emit('log', `backfill: repaired ${filled}/${cells.length} dug blocks`)
  return { filled }
}

// the autopilot calls this after a task completes when backfill is enabled
function backfillAfterTask (pilot) {
  if (!pilot.settings || !pilot.settings.get('backfill')) return
  const cells = takeDugCells(pilot)
  if (cells.length === 0) return
  pilot.startJob('backfill', `backfill ${cells.length} cells`, (alive) => runBackfill(pilot, cells, alive))
}

module.exports = { runBackfill, backfillAfterTask, recordDig, takeDugCells }
