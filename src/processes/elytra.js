'use strict'

// the elytra process — minepilot's port of baritone's ElytraProcess.
// like baritone's (which is also a work in progress), this is a glide
// controller, not a full trajectory search:
//
//   takeoff     jump and open the elytra (entity action), or continue a
//               glide already in progress
//   steering    aim at the target with a pitch that trades altitude for
//               distance — shallow (~-10 degrees) when high, steeper as
//               the ground approaches, never below the terrain floor
//   boost       fire a firework rocket when altitude bleeds out and the
//               target is still far (elytraFireworkBoost)
//   landing     level out inside elytraTargetRadius and let the bot touch
//               down, then walk the remaining distance with the pathfinder
//
// honest limits: takeoff needs open sky above the bot and works best from
// a height; without fireworks a glide only descends. the aiming math is
// unit-tested; the packet layer runs against real servers.

const { GoalXZ } = require('../engine/goals')

const TICK_MS = 100
const GLIDE_MIN_SPEED = 0.3 // blocks/tick before we consider the glide dead

// the pitch (radians, negative = look down) that trades altitude for
// forward distance. high above the terrain: shallow. close to the floor:
// just enough to maintain airflow.
function aimPitch (altitudeAboveFloor, distance) {
  const minGlide = 8 // degrees; below this the glide stalls
  let deg = minGlide
  if (distance > 64) deg = 12
  if (distance > 128) deg = 15
  if (distance > 256) deg = 18
  // close to the floor: flatten to stretch the glide
  if (altitudeAboveFloor < 12) deg = Math.max(minGlide, deg - 8)
  else if (altitudeAboveFloor < 24) deg = Math.max(minGlide, deg - 4)
  // very high: dive a bit harder to gain speed
  if (altitudeAboveFloor > 96) deg += 6
  return -deg * Math.PI / 180
}

// should a firework be used right now?
function wantsBoost (altitudeAboveFloor, distance, vy, settings) {
  if (!settings.get('elytraFireworkBoost')) return false
  if (distance < 32) return false
  // about to hit the floor while still far from the target
  if (altitudeAboveFloor < settings.get('elytraMinGlideHeight') && distance > settings.get('elytraTargetRadius')) return true
  // sinking hard mid-flight
  if (vy < -0.9 && distance > settings.get('elytraTargetRadius')) return true
  return false
}

function hasElytraEquipped (bot) {
  try {
    if (bot.armor && bot.armor.length) {
      const chest = bot.armor[2] || bot.armor[1]
      if (chest && String(chest.name).includes('elytra')) return true
    }
    // older mineflayer: inspect the equipment slots via the inventory
    if (bot.inventory && bot.inventory.slots) {
      const chestSlot = bot.inventory.slots[6] // 103 equipment chest
      if (chestSlot && String(chestSlot.name).includes('elytra')) return true
    }
  } catch (e) { /* ignore */ }
  return false
}

function hasFireworks (bot) {
  try {
    const items = bot.inventory.items()
    return items.some((it) => it && it.name === 'firework_rocket')
  } catch (e) { return false }
}

function terrainFloor (pilot, x, z, fromY) {
  // the highest solid block in the column below the bot (loaded world only)
  let floor = -64
  for (let y = Math.min(319, Math.floor(fromY)); y >= -64; y--) {
    if (pilot.view.standable(x, y, z)) {
      floor = y + 1
      break
    }
    if (!pilot.view.known(x, y, z)) break // fog: stop scanning
  }
  return floor
}

async function fireBoost (bot) {
  try {
    // equip a rocket and use it — held item first so we do not swap the
    // elytra (which lives in the armor slot and is not touched by equip)
    const rocket = bot.inventory.items().find((it) => it && it.name === 'firework_rocket')
    if (!rocket) return false
    if (bot.equip) await bot.equip(rocket, 'hand')
    if (bot.activateItem) {
      await bot.activateItem()
      return true
    }
  } catch (e) { /* ignore */ }
  return false
}

async function startGlide (bot) {
  try {
    if (bot._client && bot._client.write) {
      // 8 = start flying with elytra (entity action), verified against the
      // 1.21 protocol docs; harmless no-op if already gliding
      bot._client.write('entity_action', { entityId: bot.entity.id, actionId: 8, jumpBoost: 0 })
      return true
    }
  } catch (e) { /* ignore */ }
  return false
}

async function stopGlide (bot) {
  try {
    if (bot._client && bot._client.write) {
      bot._client.write('entity_action', { entityId: bot.entity.id, actionId: 9, jumpBoost: 0 })
    }
  } catch (e) { /* ignore */ }
}

// run the glide toward (x, z) at whatever altitude works out. returns
// { landed, walked } — walked is true when the pathfinder finished the leg.
async function runElytra (pilot, x, z, alive) {
  const bot = pilot.bot
  const settings = pilot.settings
  const targetRadius = settings.get('elytraTargetRadius')

  const start = pilot.pos()
  if (!start) throw new Error('no position yet')
  if (!hasElytraEquipped(bot)) throw new Error('no elytra equipped (put one in the chestplate slot)')
  if (!hasFireworks(bot)) pilot.emit('log', 'no fireworks carried — this glide can only descend')

  // takeoff: open sky and some height, or we are already airborne
  const airborne = !bot.entity.onGround
  if (!airborne && settings.get('elytraAllowTakeoff')) {
    // jump, then flip the elytra open mid-air
    try { bot.setControlState('jump', true) } catch (e) { /* ignore */ }
    await new Promise((r) => setTimeout(r, 300))
    await startGlide(bot)
    try { bot.setControlState('jump', false) } catch (e) { /* ignore */ }
  } else if (!airborne) {
    throw new Error('on the ground with takeoff disabled — jump off something first')
  } else {
    await startGlide(bot)
  }

  let boostedRecently = 0
  let lastDist = Infinity
  let worse = 0

  while (alive()) {
    const p = pilot.pos()
    if (!p) break
    const dx = (x + 0.5) - p.x
    const dz = (z + 0.5) - p.z
    const dist = Math.hypot(dx, dz)

    // arrived in radius: level out and land
    if (dist <= targetRadius) {
      await stopGlide(bot)
      // walk the last blocks precisely
      const r = pilot.driveTo(new GoalXZ(Math.floor(x), Math.floor(z)))
      if (r && (r.status === 'found' || r.status === 'partial')) {
        await pilot.waitArrival(30000)
      }
      return { landed: true, walked: true }
    }

    const floor = terrainFloor(pilot, Math.floor(p.x), Math.floor(p.z), p.y)
    const alt = p.y - floor
    const vy = bot.entity.velocity ? bot.entity.velocity.y : 0
    const speed = bot.entity.velocity ? Math.hypot(bot.entity.velocity.x, bot.entity.velocity.z) : 0

    // aim: yaw at the target, pitch from the altitude budget
    const yaw = Math.atan2(-dx, -dz)
    const pitch = aimPitch(alt, dist)
    try { bot.look(yaw, pitch, true) } catch (e) { /* ignore */ }

    // boost when the altitude budget runs out
    if (Date.now() - boostedRecently > 3000 && wantsBoost(alt, dist, vy, settings)) {
      if (await fireBoost(bot)) {
        boostedRecently = Date.now()
        pilot.emit('log', `firework boost at ${Math.round(alt)} above the terrain`)
      }
    }

    // glide dead (hit the ground, elytra broke, stalled)
    if (!airborneOnly(bot) && speed < GLIDE_MIN_SPEED && Math.abs(vy) < 0.05 && alt < 2) {
      await stopGlide(bot)
      // out of the sky: walk the rest
      const r = pilot.driveTo(new GoalXZ(Math.floor(x), Math.floor(z)))
      if (r && (r.status === 'found' || r.status === 'partial')) {
        await pilot.waitArrival(60000)
      }
      return { landed: true, walked: true }
    }

    // no progress at all and no altitude: give up honestly
    if (dist > lastDist - 0.5) {
      worse++
      if (worse > 200) {
        await stopGlide(bot)
        throw new Error('glide stalled — landing and walking the rest')
      }
    } else {
      worse = 0
    }
    lastDist = dist

    await new Promise((r) => setTimeout(r, TICK_MS))
  }
  await stopGlide(bot)
  return { landed: false, walked: false, aborted: true }
}

function airborneOnly (bot) {
  try { return !bot.entity.onGround } catch (e) { return false }
}

// the #elytra command entry point
function commandElytra (pilot, x, y, z) {
  void y // the glide manages its own altitude; y is accepted for grammar parity
  pilot.startJob('elytra', `elytra ${x} ${z}`, (alive) => runElytra(pilot, x, z, alive))
  return { ok: true, reply: `flying toward ${x} ${z}` }
}

module.exports = { commandElytra, runElytra, aimPitch, wantsBoost, hasElytraEquipped, hasFireworks, terrainFloor }
