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

// an exposed block has a passable neighbor: its drop will land in open air
// where the pickup walk can actually reach it
function isExposed (view, x, y, z) {
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
    if (view.passable(x + dx, y + dy, z + dz)) return true
  }
  return false
}

// mineflayer item entities carry the marker on `name` or `type` depending
// on the version — accept both (and the display name) so drops are never
// invisible to the collector
function isItemEntity (e) {
  if (!e) return false
  return e.name === 'item' || e.type === 'item' ||
    (typeof e.displayName === 'string' && e.displayName.toLowerCase() === 'item')
}

function sleep (ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function blacklistOf (pilot) {
  if (!pilot.mineBlacklist) pilot.mineBlacklist = new Set()
  return pilot.mineBlacklist
}

// nearest wanted block in loaded space, skipping blacklisted cells and the
// bot's own column. EXPOSED targets (an air-adjacent face) always win over
// buried ones at the same distance band: a buried target digs fine but its
// drop lands in a sealed pocket nothing can reach (the gather that starved
// the build). uses bot.findBlocks when the bot provides it (real
// mineflayer), and falls back to a bounded view scan otherwise (fakes).
function findNearest (pilot, names) {
  const p = pilot.pos()
  if (!p) return null
  const myX = Math.floor(p.x)
  const myZ = Math.floor(p.z)
  const blacklist = blacklistOf(pilot)
  const radius = pilot.settings ? pilot.settings.get('mineScanRadius') : 64
  const sameColumn = (x, z) => OWN_COLUMN_EXEMPT && x === myX && z === myZ

  // exposed first, then distance — see isExposed
  const exposed = (x, y, z) => isExposed(pilot.view, x, y, z)
  // legitMine: ONLY exposed targets (visible), the way baritone's legit
  // mode refuses to x-ray
  const legit = pilot.settings ? pilot.settings.get('legitMine') : false

  const pick = (cands) => {
    let best = null
    let bestKey = null
    for (const f of cands) {
      if (blacklist.has(f.x + ',' + f.y + ',' + f.z)) continue
      if (sameColumn(f.x, f.z)) continue
      const d = (f.x - p.x) ** 2 + (f.y - p.y) ** 2 + (f.z - p.z) ** 2
      // exposed first, then distance: the key sorts by both
      const key = (exposed(f.x, f.y, f.z) ? 0 : 1e9) + d
      if (legit && !exposed(f.x, f.y, f.z)) continue
      if (bestKey === null || key < bestKey) { bestKey = key; best = f }
    }
    return best ? { x: best.x, y: best.y, z: best.z } : null
  }

  if (typeof pilot.bot.findBlocks === 'function') {
    const ids = []
    const reg = pilot.bot.registry || null
    const blocksByName = reg && reg.blocksByName ? reg.blocksByName : null
    for (const n of names) {
      const meta = blocksByName ? blocksByName[n] : null
      if (meta) ids.push(meta.id)
    }
    if (ids.length > 0) {
      const found = pilot.bot.findBlocks({ matching: ids, maxDistance: radius, count: 64 }) || []
      const best = pick(found)
      if (best) return best
    }
  }

  // fallback: scan the loaded view in a cube around the bot
  const wanted = new Set(names)
  const R = Math.min(32, radius)
  const cx = Math.floor(p.x)
  const cy = Math.floor(p.y)
  const cz = Math.floor(p.z)
  const cands = []
  for (let dy = -8; dy <= 8; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      for (let dz = -R; dz <= R; dz++) {
        const x = cx + dx
        const y = cy + dy
        const z = cz + dz
        if (sameColumn(x, z)) continue
        if (!wanted.has(pilot.view.name(x, y, z))) continue
        cands.push({ x, y, z })
      }
    }
  }
  return pick(cands)
}

// vein mining: after breaking one block, break the adjacent blocks of the
// same type within veinRadius — for ORE-like targets only (a vein of
// "grass_block" would otherwise spread across the entire surface), and
// capped so a huge blob cannot take over the task.
const ORE_LIKE = /(_ore$|^ore_|ancient_debris)/

function veinEligible (name) {
  return ORE_LIKE.test(String(name))
}

const VEIN_MAX_BLOCKS = 8

async function digVein (pilot, start, alive) {
  const veinRadius = pilot.settings ? pilot.settings.get('veinRadius') : 1
  const wantName = pilot.view.name(start.x, start.y, start.z)
  if (!wantName) return 1
  if (!veinEligible(wantName)) {
    // plain blocks: exactly the one target, no vein expansion
    if (pilot.settings && pilot.settings.get('autoTool')) {
      const { equipForDig } = require('../autotool')
      await equipForDig(pilot.bot, wantName)
    }
    const ok = await pilot.digCell(start)
    return ok ? 1 : 0
  }
  const queue = [{ ...start, d: 0 }]
  const seen = new Set([start.x + ',' + start.y + ',' + start.z])
  let dug = 0
  while (queue.length > 0 && alive() && dug < VEIN_MAX_BLOCKS) {
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
        if (pilot.view.name(nx, ny, nz) === wantName && seen.size < VEIN_MAX_BLOCKS * 2) {
          queue.push({ x: nx, y: ny, z: nz, d: cell.d + 1 })
        }
      }
    }
  }
  return dug
}

// give dropped items a moment to reach the inventory, then actively walk
// over whatever did not fly to us — drops that fall into the dig hole
// never arrive on their own (the lesson every live gather learns)
async function waitPickup (pilot) {
  const t0 = Date.now()
  const nearbyItems = (radius) => {
    try {
      return Object.values(pilot.bot.entities || {}).filter((e) =>
        isItemEntity(e) && e.position && pilot.bot.entity &&
        e.position.distanceTo(pilot.bot.entity.position) < radius)
    } catch (e) { return [] }
  }
  while (Date.now() - t0 < 1200 && nearbyItems(2.5).length > 0) {
    await sleep(150)
  }
  // still-loose drops nearby: walk to them (radius-tolerant — drops land
  // in the dig hole, and a radius-0 goal on a sunken item is unreachable)
  const loose = nearbyItems(6)
  if (loose.length > 0) {
    loose.sort((a, b) => a.position.distanceTo(pilot.bot.entity.position) - b.position.distanceTo(pilot.bot.entity.position))
    for (const item of loose.slice(0, 4)) {
      const x = Math.floor(item.position.x)
      const y = Math.floor(item.position.y)
      const z = Math.floor(item.position.z)
      let arrived = false
      for (const radius of [1, 2]) {
        const r = pilot.driveTo(new GoalNear(x, y, z, radius))
        if (r && (r.status === 'found' || r.status === 'partial')) {
          if (r.moves && r.moves.length > 0) {
            await pilot.waitArrival(10000)
          }
          arrived = true
          break
        }
      }
      // give the server a moment to run the pickup into the inventory
      await sleep(400)
      void arrived
    }
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
    // never dig the column we are STANDING in — the floor is load
    // bearing. the approach goal (radius 1) legally lands the bot on top
    // of a shallow vein; digging it out from under our own feet drops
    // the bot into the hole and every following ascend launches from
    // mid-air (the infinite jump-bounce). step aside one cell first.
    {
      const p = pilot.pos()
      if (p && Math.floor(p.x) === target.x && Math.floor(p.z) === target.z) {
        let stepped = false
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const sx = target.x + dx
          const sz = target.z + dz
          const r = pilot.driveTo(new GoalNear(sx, Math.floor(p.y), sz, 0))
          if (r && (r.status === 'found' || r.status === 'partial')) {
            if (r.moves && r.moves.length > 0) await pilot.waitArrival(15000)
            const p2 = pilot.pos()
            if (p2 && (Math.floor(p2.x) !== target.x || Math.floor(p2.z) !== target.z)) {
              stepped = true
              break
            }
          }
        }
        if (!stepped) {
          blacklist.add(target.x + ',' + target.y + ',' + target.z)
          pilot.emit('log', `skipping ${names[0]} under our own feet — no room to step aside`)
          failures++
          if (failures >= 8) {
            if (dug === 0) throw new Error(`cannot mine any ${names[0]}`)
            break
          }
          i--
          continue
        }
      }
    }
    // a buried target digs fine but its drop lands in a sealed pocket no
    // pickup walk can enter — open the cover blocks above it first, the
    // way baritone digs through to reach a vein (cap: 2 covers)
    for (let cover = 0; cover < 2; cover++) {
      if (isExposed(pilot.view, target.x, target.y, target.z)) break
      const c = { x: target.x, y: target.y + 1 + cover, z: target.z }
      if (c.y > target.y + 2) break
      const name = pilot.view.name(c.x, c.y, c.z)
      if (!name || pilot.view.passable(c.x, c.y, c.z)) continue
      if (!pilot.isNearCell(c.x, c.y, c.z, 4.5)) break
      await pilot.digCell(c)
    }
    const got = await digVein(pilot, target, alive)
    dug += got
    if (got === 0) {
      // the dig ran but nothing broke (occluded cell, server refusal) —
      // blacklisting stops this round from re-picking the same dead cell
      if (pilot.settings && pilot.settings.get('blacklistClosestOnFailure')) {
        blacklist.add(target.x + ',' + target.y + ',' + target.z)
      }
      failures++
      if (failures >= 8) {
        if (dug === 0) throw new Error(`cannot mine any ${names[0]}`)
        break
      }
      i--
      continue
    }
    pilot.emit('progress', { index: dug, total: count })
    if (!pilot.settings || pilot.settings.get('mineScanDroppedItems') !== false) {
      await waitPickup(pilot)
    }
  }
  pilot.emit('log', `mined ${dug} ${names[0]}${dug === 1 ? '' : 's'}`)
  return { dug, wanted: count }
}

module.exports = { runMine, findNearest, digVein }
