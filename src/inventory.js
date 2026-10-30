'use strict'

// the inventory manager — everything about items: what is carried, what to
// drop, what to eat, how to craft, and how to move stacks into and out of
// chests. the command executor calls in here for #drop #eat #craft #chest
// and the throwaway policy the mine process uses when full.

function items (bot) {
  try {
    return (bot.inventory && bot.inventory.items()) || []
  } catch (e) { return [] }
}

function countOf (bot, name) {
  return items(bot)
    .filter((it) => it && it.name === name)
    .reduce((a, it) => a + (it.count || 1), 0)
}

function findStack (bot, name) {
  return items(bot).find((it) => it && it.name === name) || null
}

// ---- drop ----------------------------------------------------------------

async function toss (bot, item) {
  try {
    if (bot.tossStack) return await bot.tossStack(item)
    if (bot.toss) return await bot.toss(item.type, null, item.count)
    return false
  } catch (e) {
    return false
  }
}

// args from the drop command: { mode: 'stack' | 'all' | 'hand' | 'item', item? }
async function drop (bot, args) {
  if (args.mode === 'hand') {
    const held = bot.heldItem
    if (!held) return { ok: false, error: 'nothing in hand' }
    const ok = await toss(bot, held)
    return ok ? { ok: true, reply: `dropped ${held.name} x${held.count}` } : { ok: false, error: 'drop refused' }
  }
  if (args.mode === 'item') {
    const stack = findStack(bot, args.item)
    if (!stack) return { ok: false, error: `no ${args.item} in the inventory` }
    const ok = await toss(bot, stack)
    return ok ? { ok: true, reply: `dropped ${args.item} x${stack.count}` } : { ok: false, error: 'drop refused' }
  }
  if (args.mode === 'all') {
    let n = 0
    for (const it of items(bot)) {
      if (await toss(bot, it)) n++
    }
    return { ok: true, reply: `dropped ${n} stacks` }
  }
  // mode === 'stack': one throwaway stack (baritone's bare #drop)
  const settingsThrowaway = bot.settingsThrowaway || null
  const pref = ['cobblestone', 'dirt', 'netherrack', 'gravel', 'sand', 'stone']
  const stack = items(bot).find((it) => it && pref.includes(it.name)) ||
    items(bot).find((it) => it && settingsThrowaway && settingsThrowaway.includes(it.name)) ||
    items(bot)[0] || null
  if (!stack) return { ok: false, error: 'inventory empty' }
  const ok = await toss(bot, stack)
  return ok ? { ok: true, reply: `dropped ${stack.name} x${stack.count}` } : { ok: false, error: 'drop refused' }
}

// ---- eating ----------------------------------------------------------------

// rough food quality ranking — keep the best for emergencies, eat the worst
// first when topping up
const FOOD_SCORE = {
  golden_apple: 20, enchanted_golden_apple: 20, golden_carrot: 14,
  cooked_beef: 12, cooked_porkchop: 12, cooked_mutton: 10, cooked_salmon: 10,
  cooked_cod: 9, bread: 9, cooked_chicken: 8, baked_potato: 8, beetroot_soup: 7,
  mushroom_stew: 7, carrot: 6, apple: 6, melon_slice: 4, sweet_berries: 3,
  raw_beef: 4, raw_porkchop: 4, raw_chicken: 2, rotten_flesh: 1, spider_eye: 1,
  poisonous_potato: 0
}

function bestFood (bot) {
  const foods = items(bot).filter((it) => it && FOOD_SCORE[it.name] !== undefined && it.name !== 'rotten_flesh' && it.name !== 'spider_eye' && it.name !== 'poisonous_potato')
  if (foods.length === 0) {
    // starving: anything edible
    const any = items(bot).filter((it) => it && FOOD_SCORE[it.name] !== undefined)
    return any[0] || null
  }
  // eat the LOWEST quality decent food first, keep the golden apples
  foods.sort((a, b) => (FOOD_SCORE[a.name] || 0) - (FOOD_SCORE[b.name] || 0))
  return foods[0]
}

async function eatOnce (bot) {
  const food = bestFood(bot)
  if (!food) return { ok: false, error: 'nothing to eat in the inventory' }
  try {
    if (bot.equip) await bot.equip(food, 'hand')
    if (bot.consume) await bot.consume()
    else if (bot.eat) await bot.eat()
    else if (bot.autoEat) await bot.autoEat()
    else return { ok: false, error: 'this mineflayer build cannot eat' }
    return { ok: true, reply: `ate ${food.name}` }
  } catch (e) {
    return { ok: false, error: `eat failed: ${String(e.message || e).slice(0, 60)}` }
  }
}

// ---- crafting ----------------------------------------------------------------

async function commandCraft (ctx, args) {
  const { bot, pilot, settings } = ctx
  const want = args.item
  try {
    if (typeof bot.recipesFor !== 'function' || typeof bot.craft !== 'function') {
      return { ok: false, error: 'this mineflayer build cannot craft (offline bot?)' }
    }
    const reg = bot.registry
    const itemMeta = reg && reg.itemsByName ? reg.itemsByName[want] : null
    if (!itemMeta) return { ok: false, error: `unknown item "${want}"` }
    const recipes = bot.recipesFor(itemMeta.id, null)
    if (!recipes || recipes.length === 0) {
      return { ok: false, error: `no recipe for ${want} from carried materials` }
    }
    // prefer a recipe craftable in a 2x2 (no table); else use a table
    const tableFree = recipes.filter((r) => !r.requiresTable)
    let recipe = tableFree[0] || recipes[0]
    let table = null
    if (recipe.requiresTable) {
      // find / walk to a crafting table first
      const { runGetToBlock } = require('./processes/gotoblock')
      const target = await runGetToBlock(pilot, 'crafting_table', () => true)
      if (!target) return { ok: false, error: 'a crafting table is needed and none is in range' }
      const block = pilot.botBlockAt(target)
      if (!block) return { ok: false, error: 'the crafting table vanished' }
      table = block
    }
    await bot.craft(recipe, args.count, table)
    return { ok: true, reply: `crafted ${args.count} x ${want}` }
  } catch (e) {
    return { ok: false, error: `craft failed: ${String(e.message || e).slice(0, 80)}` }
  }
}

// ---- chests ----------------------------------------------------------------

function nearestChest (pilot, maxDistance) {
  const p = pilot.pos()
  if (!p) return null
  if (typeof pilot.bot.findBlocks === 'function') {
    const reg = pilot.bot.registry || null
    const meta = reg && reg.blocksByName ? reg.blocksByName.chest : null
    if (meta) {
      const found = pilot.bot.findBlocks({ matching: meta.id, maxDistance: maxDistance || 16, count: 4 })
      if (found && found.length > 0) {
        return { x: found[0].x, y: found[0].y, z: found[0].z }
      }
    }
    return null
  }
  // fake fallback
  const R = Math.min(24, maxDistance || 16)
  const cx = Math.floor(p.x)
  const cy = Math.floor(p.y)
  const cz = Math.floor(p.z)
  let best = null
  let bestD = Infinity
  for (let dy = -8; dy <= 8; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      for (let dz = -R; dz <= R; dz++) {
        if (pilot.view.name(cx + dx, cy + dy, cz + dz) !== 'chest') continue
        const d = dx * dx + dy * dy + dz * dz
        if (d < bestD) { bestD = d; best = { x: cx + dx, y: cy + dy, z: cz + dz } }
      }
    }
  }
  return best
}

async function commandChest (ctx, args) {
  const { bot, pilot, reply } = ctx
  const target = nearestChest(pilot, 16)
  if (!target) return { ok: false, error: 'no chest within 16 blocks' }
  // walk to it if out of reach
  const p = pilot.pos()
  const far = p ? Math.hypot(target.x + 0.5 - p.x, target.y + 0.5 - p.y, target.z + 0.5 - p.z) > 4 : true
  if (far) {
    const { GoalGetToBlock } = require('./engine/goals')
    const r = pilot.driveTo(new GoalGetToBlock(target.x, target.y, target.z))
    if (r && (r.status === 'found' || r.status === 'partial')) {
      await pilot.waitArrival(30000)
    }
  }
  const block = pilot.botBlockAt(target)
  if (!block) return { ok: false, error: 'the chest is gone' }
  let chest = null
  try {
    chest = await bot.openChest(block)
  } catch (e) {
    return { ok: false, error: `cannot open the chest: ${String(e.message || e).slice(0, 60)}` }
  }
  try {
    if (args.mode === 'list') {
      const its = chest.items()
      if (its.length === 0) reply('the chest is empty')
      const counts = new Map()
      for (const it of its) counts.set(it.name, (counts.get(it.name) || 0) + (it.count || 1))
      for (const [n, c] of counts) reply(`  ${n} x${c}`)
      return { ok: true, items: [...counts.entries()] }
    }
    const reg = bot.registry
    const byName = reg && reg.itemsByName ? reg.itemsByName : null
    if (args.mode === 'deposit') {
      const filter = args.filter
      const toDeposit = items(bot).filter((it) => !filter || it.name === filter)
      let moved = 0
      for (const it of toDeposit) {
        try {
          await chest.deposit(it.type, null, it.count)
          moved += it.count || 1
        } catch (e) { /* full or refused */ }
      }
      return { ok: true, reply: `deposited ${moved} items${filter ? ` (${filter})` : ''}` }
    }
    // withdraw
    const filter = args.filter
    const its = chest.items().filter((it) => !filter || it.name === filter)
    if (its.length === 0) return { ok: false, error: filter ? `no ${filter} in the chest` : 'the chest is empty' }
    let moved = 0
    for (const it of its) {
      try {
        await chest.withdraw(it.type, null, it.count)
        moved += it.count || 1
      } catch (e) { /* inventory full */ }
    }
    return { ok: true, reply: `withdrew ${moved} items${filter ? ` (${filter})` : ''}` }
  } finally {
    try { chest.close() } catch (e) { /* ignore */ }
  }
}

// ---- throwaway policy (mine process) --------------------------------------

// toss one throwaway stack to make room for a valuable pickup
async function tossThrowaway (bot, throwaway) {
  const candidates = items(bot).filter((it) => it && throwaway.includes(it.name))
  if (candidates.length === 0) return false
  return toss(bot, candidates[0])
}

module.exports = {
  items, countOf, findStack, drop, eatOnce, bestFood, FOOD_SCORE,
  commandCraft, commandChest, nearestChest, tossThrowaway
}
