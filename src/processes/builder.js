'use strict'

// the builder process — botfleet's take on baritone's BuilderProcess.
// a blueprint is diffed against the live world into two task kinds:
//   dig    the cell must end up air but something solid is there
//   place  the cell must hold block X but holds something else
// the process then walks the difference down to zero, one nearest task
// per round: get within reach (or act from where we stand), equip the
// right inventory block, anchor the placement on a solid neighbor face,
// place, verify. it stalls honestly when material is missing or a cell
// has no anchor, and never digs the column it is standing in without
// stepping aside first.

const { GoalNear } = require('../engine/goals')
const { equipForPlace, anchorsFor, withinReach } = require('../engine/place')

const MAX_ROUNDS = 96
const STALL_LIMIT = 3
const AIR_NAMES = new Set(['air', 'cave_air', 'void_air', 'light', 'structure_void'])

function sleep (ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function worldName (pilot, x, y, z) {
  try { return pilot.view.name(x, y, z) } catch (e) { return null }
}

// diff the blueprint against the world at this instant
function diffRound (pilot, bp, origin) {
  const tasks = []
  let unknown = 0
  for (const pl of bp.placements) {
    const x = origin.x + pl.x
    const y = origin.y + pl.y
    const z = origin.z + pl.z
    const cur = worldName(pilot, x, y, z)
    if (cur === null) { unknown++; continue }
    if (pl.block === 'air' || AIR_NAMES.has(pl.block)) {
      if (!AIR_NAMES.has(cur) && !pilot.view.passable(x, y, z)) {
        tasks.push({ kind: 'dig', x, y, z })
      }
      continue
    }
    if (cur !== pl.block) {
      if (!pilot.view.passable(x, y, z)) tasks.push({ kind: 'dig', x, y, z })
      tasks.push({ kind: 'place', x, y, z, block: pl.block })
    }
  }
  return { tasks, unknown }
}

// the cell the bot's body currently occupies (feet and head)
function ownCells (pilot) {
  const p = pilot.pos()
  if (!p) return null
  const x = Math.floor(p.x)
  const y = Math.floor(p.y)
  const z = Math.floor(p.z)
  return [{ x, y, z }, { x, y: y + 1, z }]
}

function taskDist (pilot, t) {
  const p = pilot.pos()
  if (!p) return Infinity
  const dx = (t.x + 0.5) - p.x
  const dy = (t.y + 0.5) - p.y
  const dz = (t.z + 0.5) - p.z
  return dx * dx + dy * dy + dz * dz
}

// stand somewhere the target cell stops intersecting our body
async function stepAside (pilot, cell) {
  const goal = new GoalNear(cell.x, cell.y, cell.z, 2)
  const r = pilot.driveTo(goal)
  if (!r || (r.status !== 'found' && r.status !== 'partial')) return false
  const ok = await pilot.waitArrival()
  const mine = ownCells(pilot) || []
  return ok && !mine.some((c) => c.x === cell.x && c.y === cell.y && c.z === cell.z)
}

async function doDig (pilot, cell) {
  const mine = ownCells(pilot) || []
  if (mine.some((c) => c.x === cell.x && c.z === cell.z && (c.y === cell.y || c.y === cell.y - 1))) {
    // digging our own floor column: back off first, the classic rule
    const moved = await stepAside(pilot, cell)
    if (!moved) return false
  } else if (!withinReach(pilot, cell)) {
    const goal = new GoalNear(cell.x, cell.y, cell.z, 2)
    const r = pilot.driveTo(goal)
    if (!r || (r.status !== 'found' && r.status !== 'partial')) return false
    const ok = await pilot.waitArrival()
    if (!ok) return false
  }
  await pilot.digCell(cell)
  return true
}

async function doPlace (pilot, cell, blockName) {
  const item = pilot.hasItem(blockName)
  if (!item) throw new Error(`out of material: ${blockName}`)

  const mine = ownCells(pilot) || []
  const inBody = mine.some((c) => c.x === cell.x && (c.y === cell.y || c.y === cell.y - 1 || c.y === cell.y + 1) && c.z === cell.z)
  if (inBody) {
    // the body blocks this cell: step aside so the placement is legal
    const moved = await stepAside(pilot, cell)
    if (!moved) return false
  } else if (!withinReach(pilot, cell)) {
    const goal = new GoalNear(cell.x, cell.y, cell.z, 2)
    const r = pilot.driveTo(goal)
    if (!r || (r.status !== 'found' && r.status !== 'partial')) return false
    const ok = await pilot.waitArrival()
    if (!ok) return false
  }

  const anchors = anchorsFor(pilot.view, cell)
  if (anchors.length === 0) return false // nothing to click against yet
  const anchor = anchors[0]

  await pilot.equipItem(item)
  const ref = pilot.botBlockAt(anchor.ref)
  if (!ref) return false
  await pilot.lookAtCell(anchor.ref.x, anchor.ref.y, anchor.ref.z)
  try {
    await pilot.placeRefFace(ref, anchor.face)
  } catch (e) {
    pilot.emit('log', `place refused: ${String(e.message || e).slice(0, 60)}`)
    return false
  }
  const after = worldName(pilot, cell.x, cell.y, cell.z)
  if (after !== blockName) return false
  return true
}

// run the build to completion. returns { placed } — how many blueprint
// cells hold their intended block (including ones already correct).
async function runBuilder (pilot, bp, origin, alive) {
  const total = bp.placements.length
  let stalls = 0
  let actedAny = false

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (!alive()) return { placed: 0, aborted: true }
    const { tasks, unknown } = diffRound(pilot, bp, origin)
    if (unknown > 0) {
      throw new Error(`${unknown} blueprint cells lie beyond the loaded world`)
    }
    pilot.emit('progress', { done: total - tasks.length, total })
    if (tasks.length === 0) {
      pilot.emit('log', `build complete: ${total}/${total} (${bp.name})`)
      return { placed: total, acted: actedAny }
    }

    tasks.sort((a, b) => taskDist(pilot, a) - taskDist(pilot, b))

    let acted = false
    for (const t of tasks) {
      if (!alive()) return { placed: 0, aborted: true }
      try {
        acted = t.kind === 'dig' ? await doDig(pilot, t) : await doPlace(pilot, t, t.block)
      } catch (e) {
        throw e // material errors and friends end the build honestly
      }
      if (acted) break // one action per round: rescan before the next
    }

    if (acted) {
      actedAny = true
      stalls = 0
    } else {
      stalls++
      if (stalls >= STALL_LIMIT) {
        throw new Error(`build stuck: ${tasks.length} cells cannot be served (missing material or no anchor face)`)
      }
      await sleep(250)
    }
  }
  throw new Error(`build did not converge within ${MAX_ROUNDS} rounds`)
}

module.exports = { runBuilder, diffRound, anchorsFor }
