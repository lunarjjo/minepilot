'use strict'

// the mine process — minepilot's port of baritone's MineProcess.
// scan loaded chunks for the wanted blocks, path to the closest one that
// is not blacklisted, dig it (and its directly adjacent same-type blocks —
// vein mining), auto-equip the best tool, wait for the drops to land in
// the inventory, and repeat until the count is reached or nothing is left
// in range. veins that cannot be reached are blacklisted instead of being
// retried forever (blacklistClosestOnFailure).

const { GoalNear } = require('../engine/goals')
const { equipForDig } = require('../autotool')

const OWN_COLUMN_EXEMPT = true // never dig the column the bot stands in

function sleep (ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function blacklistOf (pilot) {
  if (!pilot.mineBlacklist) pilot.mineBlacklist = new Set()
  return pilot.mineBlacklist
}

// nearest wanted block in loaded space, skipping blacklisted cells and the
// bot's own column. uses bot.findBlocks when the bot provides it (real
// mineflayer), and falls back to a bounded view scan otherwise (fakes).
function findNearest (pilot, names) {
  const p = pilot.pos()
  if (!p) return null
  const myX = Math.floor(p.x)
  const myZ = Math.floor(p.z)
  const blacklist = blacklistOf(pilot)
  const radius = pilot.settings ? pilot.settings.get('mineScanRadius') : 64
  const sameColumn = (x, z) => OWN_COLUMN_EXEMPT && x === myX && z === myZ

  // legitMine: only target blocks with an adjacent air pocket (visible),
  // the way baritone's legit mode refuses to x-ray
  const legitVisible = (x, y, z) => {
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      if (pilot.view.passable(x + dx, y + dy, z + dz)) return true
    }
    return false
  }
  const legit = pilot.settings ? pilot.settings.get('legitMine') : false

  if (typeof pilot.bot.findBlocks === 'function') {
    const ids = []
    const reg = pilot.bot.registry || null
    const blocksByName = reg && reg.blocksByName ? reg.blocksByName : null
    for (const n of names) {
      const meta = blocksByName ? blocksByName[n] : null
      if (meta) ids.push(meta.id)
    }
    if (ids.length > 0) {
      const found = pilot.bot.findBlocks({ matching: ids, maxDistance: radius, count: 64 })
      let best = null
      let bestD = Infinity
      for (const f of found || []) {
        if (blacklist.has(f.x + ',' + f.y + ',' + f.z)) continue
        if (sameColumn(f.x, f.z)) continue
        if (legit && !legitVisible(f.x, f.y, f.z)) continue
        const d = (f.x - p.x) ** 2 + (f.y - p.y) ** 2 + (f.z - p.z) ** 2
        if (d < bestD) { bestD = d; best = f }
      }
      if (best) return { x: best.x, y: best.y, z: best.z }
    }
  }

  // fallback: scan the loaded view in a cube around the bot
  const wanted = new Set(names)
  const R = Math.min(32, radius)
  const cx = Math.floor(p.x)
  const cy = Math.floor(p.y)
  const cz = Math.floor(p.z)
  let best = null
  let bestD = Infinity
  for (let dy = -8; dy <= 8; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      for (let dz = -R; dz <= R; dz++) {
        const x = cx + dx
        const y = cy + dy
        const z = cz + dz
        if (sameColumn(x, z)) continue
        if (blacklist.has(x + ',' + y + ',' + z)) continue
        if (!wanted.has(pilot.view.name(x, y, z))) continue
        if (legit && !legitVisible(x, y, z)) continue
        const d = dx * dx + dy * dy + dz * dz
        if (d < bestD) {
          bestD = d
          best = { x, y, z }
        }
      }
    }
  }
  return best
}

// vein mining: after breaking one block, break the adjacent blocks of the
// same type within veinRadius (baritone treats a connected ore blob as one
// target). BFS over the 6 face neighbors.
async function digVein (pilot, start, alive) {
  const veinRadius = pilot.settings ? pilot.settings.get('veinRadius') : 1
  const wantName = pilot.view.name(start.x, start.y, start.z)
  if (!wantName) return 1
  const queue = [{ ...start, d: 0 }]
  const seen = new Set([start.x + ',' + start.y + ',' + start.z])
  let dug = 0
  while (queue.length > 0 && alive()) {
    const cell = queue.shift()
    if (pilot.view.name(cell.x, cell.y, cell.z) !== wantName) continue
    if (pilot.settings && pilot.settings.get('autoTool')) {
      await equipForDig(pilot.bot, wantName)
    }
    const ok = await pilot.digCell(cell)
    if (!ok) continue
    dug++
    if (veinRadius > 0 && cell.d < veinRadius + 1) {
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const nx = cell.x + dx
        const ny = cell.y + dy
        const nz = cell.z + dz
        const k = nx + ',' + ny + ',' + nz
        if (seen.has(k)) continue
        seen.add(k)
        if (pilot.view.name(nx, ny, nz) === wantName) {
          queue.push({ x: nx, y: ny, z: nz, d: cell.d + 1 })
        }
      }
    }
  }
  return dug
}

// give dropped items a moment to reach the inventory before moving on — a
// bot that walks away from its own drops mines thin air next tick
async function waitPickup (pilot) {
  const t0 = Date.now()
  const nearbyItems = () => {
    try {
      return Object.values(pilot.bot.entities || {}).filter((e) =>
        e && e.name === 'item' && e.position && pilot.bot.entity &&
        e.position.distanceTo(pilot.bot.entity.position) < 2.5).length
    } catch (e) { return 0 }
  }
  while (Date.now() - t0 < 1200 && nearbyItems() > 0) {
    await sleep(150)
  }
}

// run the mine loop. returns { dug, wanted, foundVein } or throws.
async function runMine (pilot, names, count, alive) {
  let dug = 0
  let failures = 0
  const blacklist = blacklistOf(pilot)
  for (let i = 0; i < count; i++) {
    if (!alive()) return { dug, aborted: true }
    const target = findNearest(pilot, names)
    if (!target) {
      if (dug === 0) throw new Error(`no ${names[0]} in range`)
      break
    }
    // stand within reach of the ore: GoalNear radius 1 (adjacent or on top),
    // the dig reach is 4.2 so a radius-1 arrival always reaches the vein.
    // driveTo (not planNow + executor.run) keeps the autopilot's replan
    // wiring alive: if the plan goes stale (the bot fell into the vein,
    // the world changed), splices trigger real replans.
    const goal = new GoalNear(target.x, target.y, target.z, 1)
    const r = pilot.driveTo(goal)
    if (!r || (r.status !== 'found' && r.status !== 'partial' && r.status !== 'partial-stuck')) {
      if (pilot.settings && pilot.settings.get('blacklistClosestOnFailure')) {
        blacklist.add(target.x + ',' + target.y + ',' + target.z)
        pilot.emit('log', `blacklisted unreachable ${names[0]} at ${target.x} ${target.y} ${target.z}`)
        failures++
        if (failures >= 8) {
          if (dug === 0) throw new Error(`cannot reach any ${names[0]}`)
          break
        }
        i-- // this round did not consume a count slot
        continue
      }
      if (dug === 0) throw new Error(`cannot reach any ${names[0]}`)
      break
    }
    if (r.moves && r.moves.length > 0) {
      const done = await pilot.waitArrival()
      if (!done) {
        if (pilot.settings && pilot.settings.get('blacklistClosestOnFailure')) {
          blacklist.add(target.x + ',' + target.y + ',' + target.z)
        }
        throw new Error('could not reach the vein')
      }
    }
    if (!alive()) return { dug, aborted: true }
    const got = await digVein(pilot, target, alive)
    dug += got
    pilot.emit('progress', { index: dug, total: count })
    await waitPickup(pilot)
  }
  pilot.emit('log', `mined ${dug} ${names[0]}${dug === 1 ? '' : 's'}`)
  return { dug, wanted: count }
}

module.exports = { runMine, findNearest, digVein }
