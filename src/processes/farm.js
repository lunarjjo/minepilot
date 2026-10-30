'use strict'

// the farming process — botfleet's take on baritone's FarmProcess.
// scan the loaded area around the unit for mature crops, harvest them
// nearest-first, and replant the same crop when the seed is in the
// inventory and the soil below accepts it (farmland for most crops,
// soul sand for nether wart). one scan, then a walk down the queue —
// like baritone, which harvests known ready crops and moves on.

const { GoalNear } = require('../engine/goals')

function sleep (ms) {
  return new Promise((r) => setTimeout(r, ms))
}
const { findItem, equipForPlace } = require('../engine/place')

const SCAN_BAND = 8 // crops live within a few blocks of walking height

const CROPS = {
  wheat: { maxAge: 7, replantOn: 'farmland', seed: 'wheat_seeds' },
  carrots: { maxAge: 7, replantOn: 'farmland', seed: 'carrot' },
  potatoes: { maxAge: 7, replantOn: 'farmland', seed: 'potato' },
  beetroots: { maxAge: 7, replantOn: 'farmland', seed: 'beetroot_seeds' },
  nether_wart: { maxAge: 3, replantOn: 'soul_sand', seed: 'nether_wart' }
}

// the crop this block is (when mature), or null
function matureCrop (block) {
  if (!block || !block.name) return null
  const c = CROPS[block.name]
  if (!c) return null
  const age = block.properties ? Number(block.properties.age) : NaN
  if (!Number.isFinite(age)) return null // state unreadable: leave it alone
  return age >= c.maxAge ? c : null
}

// collect mature crops within radius of the scan center (the bot, or a
// waypoint the farm was anchored to), nearest first. the own-column rule
// always protects the BOT's column, wherever the scan is centered.
function scan (pilot, radius, center) {
  const p = center || pilot.pos()
  const bp = pilot.pos()
  if (!p) return []
  const cx = Math.floor(p.x)
  const cy = Math.floor(p.y)
  const cz = Math.floor(p.z)
  const ownX = bp ? Math.floor(bp.x) : null
  const ownZ = bp ? Math.floor(bp.z) : null
  const r = Math.max(2, Math.min(48, Math.floor(radius)))
  const found = []
  for (let dy = -SCAN_BAND; dy <= SCAN_BAND; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        const x = cx + dx
        const y = cy + dy
        const z = cz + dz
        let block = null
        try { block = pilot.view.block(x, y, z) } catch (e) { continue }
        const crop = matureCrop(block)
        if (!crop) continue
        // never harvest the column we stand in — same rule as mining
        if (ownX !== null && cx + dx === ownX && cz + dz === ownZ) continue
        found.push({ x, y, z, crop, d: dx * dx + dy * dy + dz * dz })
      }
    }
  }
  found.sort((a, b) => a.d - b.d)
  return found
}

async function harvest (pilot, target, alive) {
  const { x, y, z, crop } = target
  // walk adjacent to the crop
  if (!pilot.isNearCell(x, y, z, 3)) {
    const goal = new GoalNear(x, y, z, 1)
    const r = pilot.driveTo(goal)
    if (!r || (r.status !== 'found' && r.status !== 'partial')) return false
    const ok = await pilot.waitArrival()
    if (!ok) return false
  }
  if (!alive()) return false
  await pilot.digCell({ x, y, z })

  // replant when the seed is around and the soil accepts it
  const soilName = pilot.view.name(x, y - 1, z)
  if (soilName !== crop.replantOn) return true
  if (!findItem(pilot.bot, crop.seed)) return true
  const item = await equipForPlace(pilot.view, pilot.bot, crop.seed)
  if (!item) return true
  const soil = pilot.botBlockAt({ x, y: y - 1, z })
  if (!soil) return true
  await pilot.lookAtCell(x, y - 1, z)
  try {
    await pilot.placeRefFace(soil, { x: 0, y: 1, z: 0 })
  } catch (e) {
    pilot.emit('log', `replant refused: ${String(e.message || e).slice(0, 50)}`)
  }
  return true
}

// run a farm pass. origin: optional { x, y, z } waypoint the range is
// measured from (baritone's farm <range> <waypoint>). returns the harvest.
async function runFarm (pilot, radius, alive, origin) {
  const center = origin || null
  const crops = scan(pilot, radius, center)
  if (crops.length === 0) {
    pilot.emit('log', `no mature crops within ${radius} blocks${center ? ' of the waypoint' : ''}`)
    return { harvested: 0 }
  }
  let harvested = 0
  let replanted = 0
  for (const target of crops) {
    if (!alive()) break
    const ok = await harvest(pilot, target, alive)
    if (!ok) continue
    harvested++
    if (pilot.view.name(target.x, target.y, target.z) === target.crop.name) replanted++
    pilot.emit('progress', { index: harvested, total: crops.length })
  }
  pilot.emit('log', `harvested ${harvested} crops (replanted ${replanted})`)

  // farmWaitForGrowth: stay on the farm while immature crops grow back
  const waitForGrowth = pilot.settings ? pilot.settings.get('farmWaitForGrowth') : false
  if (waitForGrowth && alive()) {
    let rounds = 0
    while (alive() && rounds < 24) {
      await sleep(8000)
      if (!alive()) break
      const stillGrowing = scan(pilot, radius, center).length
      if (stillGrowing === 0) {
        // any immature crops of the known types nearby?
        let immature = 0
        const r2 = Math.max(2, Math.min(48, Math.floor(radius)))
        const pp = center || pilot.pos()
        if (pp) {
          const cx = Math.floor(pp.x)
          const cy = Math.floor(pp.y)
          const cz = Math.floor(pp.z)
          for (let dy = -SCAN_BAND; dy <= SCAN_BAND && immature === 0; dy++) {
            for (let dx = -r2; dx <= r2 && immature === 0; dx++) {
              for (let dz = -r2; dz <= r2 && immature === 0; dz++) {
                const block = pilot.view.block(cx + dx, cy + dy, cz + dz)
                if (block && CROPS[block.name]) immature++
              }
            }
          }
        }
        if (immature === 0) break
      }
      rounds++
      const again = await runFarm(pilot, radius, alive, center)
      harvested += again.harvested || 0
      replanted += again.replanted || 0
    }
  }
  return { harvested, replanted }
}

module.exports = { runFarm, scan, matureCrop, CROPS }
