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
// first when topping up. vanilla item names: raw meats are beef/porkchop/
// chicken/mutton/rabbit (no raw_ prefix — cod/salmon DO have it)
const FOOD_SCORE = {
  golden_apple: 20, enchanted_golden_apple: 20, golden_carrot: 14,
  cooked_beef: 12, cooked_porkchop: 12, cooked_mutton: 10, cooked_salmon: 10,
  cooked_cod: 9, bread: 9, cooked_chicken: 8, baked_potato: 8, beetroot_soup: 7,
  mushroom_stew: 7, carrot: 6, apple: 6, melon_slice: 4, sweet_berries: 3,
  beef: 4, porkchop: 4, chicken: 2, mutton: 4, rabbit: 3, cod: 3, salmon: 3,
  raw_beef: 4, raw_porkchop: 4, raw_chicken: 2, raw_mutton: 4, raw_rabbit: 3,
  rotten_flesh: 1, spider_eye: 1, poisonous_potato: 0
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

// items stranded in the 2x2 crafting grid (player window slots 1-4) poison
// every later craft: items() does not count them, so the next recipe fails
// with "missing ingredient" while materials visibly sit in the inventory —
// and one leftover plank in the grid re-shapes into an oak_button the next
// time anything touches the output slot (both reproduced live by the
// survival brain). mineflayer's craftOnce never clears the grid on error,
// so we do it ourselves: shift-click each occupied grid slot back into the
// inventory before crafting. a no-op when the grid is clean.
async function clearCraftGrid (bot) {
  try {
    const inv = bot.inventory
    if (!inv || !inv.slots || typeof bot.clickWindow !== 'function') return
    for (const slot of [1, 2, 3, 4]) {
      try {
        if (inv.slots[slot]) await bot.clickWindow(slot, 1, 0)
      } catch (e) { /* keep clearing the rest */ }
    }
  } catch (e) { /* older builds */ }
}

// craft N iterations of a resolved recipe, ONE AT A TIME, verifying each
// landed in the inventory before the next. mineflayer's multi-craft fires
// every click back-to-back and a busy server silently drops transactions —
// reproduced live as 24-28 of 32 planks "crafted ok", and as few as 6 when
// a stale stateId epoch eats most of the run (the same flake that reddened
// the launch-day ci). a dropped craft strands its half-placed materials in
// the 2x2 grid, which then reads as "missing ingredient" — so every miss
// (drop, stall or missing-ingredient) resets the window state (grid clear
// + server re-sync) and retries; only a missing-ingredient that SURVIVES
// a reset means the materials are genuinely spent.
async function craftVerified (bot, recipe, count, table, wantName) {
  const perCraft = (recipe.result && recipe.result.count) || 1
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const startCount = countOf(bot, wantName)
  const target = startCount + count * perCraft
  let attempts = 0
  let consecutiveMissing = 0
  let lastError = null
  const maxAttempts = count * 3 + 3
  while (countOf(bot, wantName) < target && attempts < maxAttempts) {
    attempts++
    const before = countOf(bot, wantName)
    try {
      await bot.craft(recipe, 1, table)
      consecutiveMissing = 0
    } catch (e) {
      const msg = String(e.message || e)
      lastError = msg.slice(0, 80)
      if (/missing ingredient/i.test(msg)) consecutiveMissing++
      else consecutiveMissing = 0
    }
    // the server's window_items reply can lag the click ack under load —
    // give the inventory model a moment to show THIS iteration's result
    for (let i = 0; i < 12 && countOf(bot, wantName) <= before && countOf(bot, wantName) < target; i++) {
      await sleep(150)
    }
    if (countOf(bot, wantName) >= target) break
    // materials genuinely spent (a reset already tried to rescue them)?
    if (consecutiveMissing >= 2) break
    // the iteration was lost server-side: reset the window state — this
    // also returns grid-stranded materials to the inventory — and retry
    await clearCraftGrid(bot)
    try {
      if (bot.currentWindow && bot.closeWindow) await bot.closeWindow(bot.currentWindow)
    } catch (e) { /* ignore */ }
    try {
      if (typeof bot._syncWindow === 'function') await Promise.race([bot._syncWindow(bot.inventory), sleep(2000)])
    } catch (e) { /* older builds */ }
    await sleep(300)
  }
  const done = Math.max(0, Math.floor((countOf(bot, wantName) - startCount) / perCraft))
  return { done, error: done < count ? (lastError || 'the server dropped the craft') : null }
}

async function commandCraft (ctx, args) {
  const { bot, pilot } = ctx
  const want = args.item
  if (typeof bot.recipesFor !== 'function' || typeof bot.craft !== 'function') {
    return { ok: false, error: 'this mineflayer build cannot craft (offline bot?)' }
  }
  const reg = bot.registry
  const itemMeta = reg && reg.itemsByName ? reg.itemsByName[want] : null
  if (!itemMeta) return { ok: false, error: `unknown item "${want}"` }
  // hand (2x2) recipes first. 3x3 recipes: mineflayer's recipesFor gates
  // them on ANY truthy 4th argument — we pass the table BLOCK (no window
  // is opened here: bot.openCraftingTable was removed in mineflayer
  // 4.39, and holding a window open freezes bot.inventory.count, which
  // recipesFor reads — a silent "no recipe" while materials sit in the
  // inventory, found live by the survival brain). bot.craft opens the
  // table window itself once given the block.
  let recipes = bot.recipesFor(itemMeta.id, null, args.count)
  let table = null
  if (!recipes || recipes.length === 0) {
    const { runGetToBlock } = require('./processes/gotoblock')
    const target = await runGetToBlock(pilot, 'crafting_table', () => true)
    if (!target) {
      return { ok: false, error: `no recipe for ${want} from carried materials (a crafting table may be needed and none is in range)` }
    }
    const block = pilot.botBlockAt(target)
    if (!block) return { ok: false, error: 'the crafting table vanished' }
    recipes = bot.recipesFor(itemMeta.id, null, args.count, block)
    if (recipes && recipes.length > 0) table = block
    if (!recipes || recipes.length === 0) {
      return { ok: false, error: `no recipe for ${want} from carried materials` }
    }
  }
  const tableFree = recipes.filter((r) => !r.requiresTable)
  const recipe = tableFree[0] || recipes[0]
  // clean the crafting grid before starting — a failed craft leaves its
  // half-placed materials in slots 1-4, and every craft after that
  // misfires against the dirty grid
  await clearCraftGrid(bot)
  const { done, error } = await craftVerified(bot, recipe, args.count, table, want)
  if (done > 0) {
    const partial = done < args.count ? ` (of ${args.count} — ${error})` : ''
    return { ok: true, reply: `crafted ${done} x ${want}${partial}` }
  }
  return { ok: false, error: `craft failed: ${error || 'nothing landed'}` }
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
    const r = await pilot.driveTo(new GoalGetToBlock(target.x, target.y, target.z))
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
    // the chest's own storage — containerItems(); window.items() would be
    // the PLAYER range inside the window (a mineflayer subtlety: deposit
    // searches the player range, withdraw the container range)
    const containerItems = () => (chest.containerItems ? chest.containerItems() : chest.items())
    if (args.mode === 'list') {
      const its = containerItems()
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
    const its = containerItems().filter((it) => !filter || it.name === filter)
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
  commandCraft, commandChest, nearestChest, tossThrowaway, clearCraftGrid
}
