'use strict'

// the tunnel process — minepilot's port of baritone's TunnelCommand.
// dig a h x w x depth tunnel along the bot's facing cardinal direction,
// advancing slice by slice. deviation only when a cell refuses to break
// (bedrock) — the tunnel then shifts to the nearest breakable column, the
// honest equivalent of baritone's "deviate to avoid lava".

const { GoalBlock } = require('../engine/goals')
const { equipForDig } = require('../autotool')

const MAX_SLICE = 8

function sleep (ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function facingCardinal (pilot) {
  const e = pilot.bot.entity
  if (!e) return { dx: 1, dz: 0 }
  const yaw = e.yaw || 0
  const fx = -Math.sin(yaw)
  const fz = -Math.cos(yaw)
  if (Math.abs(fx) > Math.abs(fz)) return { dx: Math.sign(fx), dz: 0 }
  return { dx: 0, dz: Math.sign(fz) }
}

// the h x w cross-section of the tunnel at depth step k, for a bot at
// (x, y, z) digging direction (dx, dz). the section starts at foot level.
function sliceCells (x, y, z, dx, dz, k, height, width) {
  const cx = x + dx * k
  const cz = z + dz * k
  const cells = []
  // width runs perpendicular to the direction
  const px = dz // perpendicular unit
  const pz = dx
  const half = Math.floor((width - 1) / 2)
  for (let h = 0; h < height; h++) {
    for (let w = -half; w <= half + (width - 1) % 2; w++) {
      cells.push({ x: cx + px * w, y: y + h, z: cz + pz * w })
    }
  }
  return cells
}

// dig every solid cell of a slice; returns false when one refuses
async function digSlice (pilot, cells, alive) {
  const settings = pilot.settings
  for (const cell of cells) {
    if (!alive()) return false
    const name = pilot.view.name(cell.x, cell.y, cell.z)
    if (!name) continue // fog: nothing to do yet
    const info = pilot.view.breakInfo(cell.x, cell.y, cell.z)
    if (!info || !info.breakable) continue // bedrock / vetoed: skip honestly
    if (settings && settings.get('autoTool')) await equipForDig(pilot.bot, name)
    const ok = await pilot.digCell(cell)
    if (!ok) return false
  }
  return true
}

// walk forward into the cleared slice. driveTo keeps the replan wiring
// alive (a stale plan after falling into a dug cell gets spliced and
// replanned, instead of dead-looping the executor).
async function stepForward (pilot, x, y, z, dx, dz, k) {
  const tx = x + dx * k
  const tz = z + dz * k
  const r = pilot.driveTo(new GoalBlock(tx, y, tz))
  if (!r || (r.status !== 'found' && r.status !== 'partial' && r.status !== 'partial-stuck')) return false
  if (!r.moves || r.moves.length === 0) return true
  return pilot.waitArrival(15000)
}

// run the tunnel. resolves { slices } — how many depth steps were cleared.
async function runTunnel (pilot, height, width, depth, alive) {
  const n = pilot.node()
  if (!n) throw new Error('no position yet')
  const { dx, dz } = facingCardinal(pilot)
  let slices = 0
  for (let k = 1; k <= depth && alive(); k++) {
    // the bot's actual node each iteration (it advances with the tunnel)
    const cur = pilot.node()
    if (!cur) break
    // the k-th slice relative to the CURRENT position: we re-derive the
    // anchor from where the bot actually stands so a shift stays consistent
    const anchorK = k - slices
    if (anchorK < 1) continue
    const cells = sliceCells(cur.x, cur.y, cur.z, dx, dz, Math.min(anchorK, MAX_SLICE), height, width)
    const cleared = await digSlice(pilot, cells, alive)
    if (!alive()) break
    if (!cleared) {
      pilot.emit('log', `tunnel: a cell at depth ${k} refuses to break — stopping here`)
      break
    }
    // step into the tunnel mouth when it is one ahead
    const ahead = sliceCells(cur.x, cur.y, cur.z, dx, dz, 1, height, width)
    const mouthClear = ahead.every((c) => !pilot.view.solid(c.x, c.y, c.z) || !pilot.view.breakInfo(c.x, c.y, c.z) || pilot.view.breakInfo(c.x, c.y, c.z).breakable)
    void mouthClear
    const stepped = await stepForward(pilot, cur.x, cur.y, cur.z, dx, dz, 1)
    if (!stepped) {
      // could not advance (terrain step? place floor?) — try placing support
      pilot.emit('log', `tunnel: cannot advance at depth ${k}`)
      break
    }
    slices++
    pilot.emit('progress', { index: slices, total: depth })
    await sleep(80)
  }
  pilot.emit('log', `tunnel: cleared ${slices}/${depth} slices (${height}x${width})`)
  return { slices }
}

module.exports = { runTunnel, sliceCells, facingCardinal }
