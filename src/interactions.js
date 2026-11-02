'use strict'

// entity and block interactions beyond movement: feeding animals (the
// breeding right-click with food in hand), pairing two animals up for a
// baby, sleeping in a bed, activating named blocks (levers, doors,
// buttons) and looking at things. everything the cockpit's entity menu
// and the `interact` grammar reach for.

// what each animal accepts for breeding (vanilla tables, common mobs)
const BREED_FOOD = {
  cow: ['wheat'],
  sheep: ['wheat'],
  mooshroom: ['wheat'],
  pig: ['carrot', 'potato', 'beetroot'],
  chicken: ['wheat_seeds', 'melon_seeds', 'pumpkin_seeds', 'beetroot_seeds', 'torchflower_seeds'],
  rabbit: ['carrot', 'golden_carrot', 'dandelion'],
  horse: ['golden_apple', 'golden_carrot'],
  donkey: ['golden_apple', 'golden_carrot'],
  mule: ['golden_apple', 'golden_carrot'],
  wolf: ['rotten_flesh', 'porkchop', 'cooked_porkchop', 'beef', 'cooked_beef'],
  cat: ['cod', 'salmon'],
  ocelot: ['cod', 'salmon'],
  fox: ['sweet_berries', 'glow_berries'],
  panda: ['bamboo'],
  turtle: ['seagrass'],
  camel: ['cactus'],
  hoglin: ['crimson_fungus'],
  frog: ['slime_ball'],
  goat: ['wheat'],
  bee: ['flower', 'poppy', 'dandelion'],
  sniffer: ['torchflower_seeds'],
  armadillo: ['spider_eye']
}

// the mobs whose feeding actually breeds them in vanilla
const BREEDABLE = new Set(Object.keys(BREED_FOOD))

function entitiesOfKind (bot, kind, maxDistance) {
  const p = bot.entity && bot.entity.position
  if (!p) return []
  const out = []
  for (const e of Object.values(bot.entities || {})) {
    if (!e || !e.position || e === bot.entity) continue
    const n = String(e.name || e.type || '')
    if (kind !== '*' && n !== kind) continue
    const d = e.position.distanceTo(p)
    if (d <= (maxDistance || 16)) out.push({ e, d })
  }
  out.sort((a, b) => a.d - b.d)
  return out
}

// pick the food to use: the named one if given and carried, else the
// first accepted food actually in the inventory
function pickFood (bot, kind, itemName) {
  const items = (bot.inventory && bot.inventory.items()) || []
  if (itemName) {
    const stack = items.find((it) => it && it.name === itemName)
    if (!stack) return { error: `no ${itemName} in the inventory` }
    return { item: stack }
  }
  const accepted = BREED_FOOD[kind] || []
  for (const food of accepted) {
    const stack = items.find((it) => it && it.name === food)
    if (stack) return { item: stack }
  }
  if (accepted.length === 0) return { error: `${kind} cannot be fed` }
  return { error: `no breeding food for ${kind} (needs ${accepted[0]})` }
}

async function walkToEntity (pilot, e, reach) {
  const p = pilot.pos()
  if (!p || !e.position) return false
  if (e.position.distanceTo(p) <= reach) return true
  const { GoalGetToBlock } = require('./engine/goals')
  const r = await pilot.driveTo(new GoalGetToBlock(Math.floor(e.position.x), Math.floor(e.position.y), Math.floor(e.position.z)))
  if (!r || (r.status !== 'found' && r.status !== 'partial')) return false
  await pilot.waitArrival(30000)
  return true
}

// feed one entity: equip the food, right-click it. returns the reply.
async function feedEntity (ctx, kind, itemName, entity) {
  const { bot, pilot, reply } = ctx
  const target = entity || (entitiesOfKind(bot, kind, 16)[0] || {}).e
  if (!target) return { ok: false, error: `no ${kind} within 16 blocks` }
  const food = pickFood(bot, String(target.name || target.type || kind), itemName)
  if (food.error) return { ok: false, error: food.error }
  const reached = await walkToEntity(pilot, target, 3.5)
  if (!reached) return { ok: false, error: `cannot reach the ${target.name || kind}` }
  try {
    if (bot.equip) await bot.equip(food.item, 'hand')
    if (!bot.activateEntity) return { ok: false, error: 'this mineflayer build cannot interact with entities' }
    await bot.activateEntity(target)
  } catch (e) {
    return { ok: false, error: `feed refused: ${String(e.message || e).slice(0, 60)}` }
  }
  const n = String(target.name || target.type || kind)
  reply(`fed the ${n} with ${food.item.name}`)
  return { ok: true, fed: n, item: food.item.name }
}

// breed: feed TWO nearby adults of the same kind (the vanilla recipe for
// a baby; gestation is server-side and takes minutes)
async function breedPair (ctx, kind) {
  const { bot, reply } = ctx
  const found = entitiesOfKind(bot, kind, 24)
  if (found.length < 2) {
    return { ok: false, error: `need two ${kind}s within 24 blocks to breed (found ${found.length})` }
  }
  if (!BREEDABLE.has(kind)) return { ok: false, error: `${kind} cannot be bred` }
  const food = pickFood(bot, kind, null)
  if (food.error) return { ok: false, error: food.error }
  const first = await feedEntity(ctx, kind, null, found[0].e)
  if (!first.ok) return first
  const second = await feedEntity(ctx, kind, null, found[1].e)
  if (!second.ok) return second
  reply(`both ${kind}s fed — a baby is on the way`)
  return { ok: true, bred: kind, item: food.item.name }
}

// sleep: find a bed in range, walk to it, sleep (only works at night or
// in a thunderstorm — vanilla rules)
function nearestBed (pilot, maxDistance) {
  const bot = pilot.bot
  const reg = bot.registry
  if (!reg || !reg.blocksByName || typeof bot.findBlocks !== 'function') return null
  const bedIds = []
  for (const b of Object.values(reg.blocksByName)) {
    if (typeof b.name === 'string' && b.name.endsWith('_bed')) bedIds.push(b.id)
  }
  if (bedIds.length === 0) return null
  const found = bot.findBlocks({ matching: bedIds, maxDistance: maxDistance || 16, count: 1 })
  if (!found || found.length === 0) return null
  return { x: found[0].x, y: found[0].y, z: found[0].z }
}

async function sleepInBed (ctx) {
  const { bot, pilot, reply } = ctx
  const target = nearestBed(pilot, 16)
  if (!target) return { ok: false, error: 'no bed within 16 blocks' }
  const { GoalGetToBlock } = require('./engine/goals')
  const r = await pilot.driveTo(new GoalGetToBlock(target.x, target.y, target.z))
  if (r && (r.status === 'found' || r.status === 'partial')) {
    await pilot.waitArrival(30000)
  }
  const block = pilot.botBlockAt(target)
  if (!block) return { ok: false, error: 'the bed is gone' }
  try {
    if (!bot.sleep) return { ok: false, error: 'this mineflayer build cannot sleep' }
    await bot.sleep(block)
  } catch (e) {
    return { ok: false, error: `cannot sleep: ${String(e.message || e).slice(0, 80)}` }
  }
  reply(`sleeping in the bed at ${target.x} ${target.y} ${target.z} (#wake to get up)`)
  return { ok: true }
}

async function wakeUp (ctx) {
  const { bot } = ctx
  try {
    if (bot.isSleeping) {
      await bot.wake()
      return { ok: true, reply: 'awake' }
    }
    return { ok: false, error: 'not sleeping' }
  } catch (e) {
    return { ok: false, error: `wake refused: ${String(e.message || e).slice(0, 60)}` }
  }
}

// activate the nearest block of a type (lever, door, button, trapdoor...)
async function activateBlock (ctx, blockName) {
  const { pilot, reply } = ctx
  const { findNearestBlock, runClick } = require('./processes/gotoblock')
  const target = findNearestBlock(pilot, blockName, 16)
  if (!target) return { ok: false, error: `no ${blockName} within 16 blocks` }
  const ok = await runClick(pilot, target.x, target.y, target.z, () => true)
  if (!ok) return { ok: false, error: `could not activate the ${blockName}` }
  reply(`activated the ${blockName} at ${target.x} ${target.y} ${target.z}`)
  return { ok: true }
}

module.exports = { BREED_FOOD, BREEDABLE, entitiesOfKind, pickFood, feedEntity, breedPair, sleepInBed, wakeUp, activateBlock }
