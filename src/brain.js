'use strict'

// the survival brain — full-auto mode. layered like a player's instincts:
//
//   reflexes   (fast, may interrupt anything): dodge creepers, fight or
//              flee hostiles, eat when hurt or hungry
//   needs      (seconds): food supply (hunt animals, cook raw meat),
//              tool progression (logs -> planks -> table -> wooden pick ->
//              cobble -> stone tools + furnace -> iron), torches
//   goals      (idle filler): explore
//
// the brain drives the SAME engine a human driver uses — the autopilot,
// the processes, the craft command's table logic — never a private path.
// a command from a human (console, cockpit, chat, map) suspends goal
// execution for a hold window; reflexes keep running regardless.

const { FOOD_SCORE } = require('./inventory')

const HOSTILE_RE = /zombie|skeleton|creeper|spider|cave_spider|enderman|witch|blaze|ghast|slime|magma_cube|pillager|vindicator|evoker|ravager|phantom|drowned|husk|stray|wither_skeleton|piglin|hoglin|zoglin|warden|breeze|bogged/
const ANIMAL_RE = /cow|pig|sheep|chicken|rabbit/
// raw meats in vanilla item names (beef/porkchop/... have no raw_ prefix)
const RAW_FOOD = new Set(['beef', 'porkchop', 'chicken', 'mutton', 'rabbit', 'raw_beef', 'raw_porkchop', 'raw_chicken', 'raw_mutton', 'raw_rabbit', 'cod', 'salmon'])
const LOGS = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log', 'pale_oak_log']
const PLANKS = ['oak_planks', 'birch_planks', 'spruce_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks', 'pale_oak_planks']
const STONES = ['stone', 'cobblestone', 'cobbled_deepslate', 'deepslate', 'granite', 'diorite', 'andesite', 'tuff']
const IRON_ORES = ['iron_ore', 'deepslate_iron_ore', 'raw_iron_block']

const PICK_TIERS = ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe']
const SWORD_TIERS = ['wooden_sword', 'stone_sword', 'iron_sword']
const AXE_TIERS = ['wooden_axe', 'stone_axe', 'iron_axe']
// armor ladder: piece, iron cost, equip destination
const ARMOR_TIERS = [
  ['iron_helmet', 5, 'head'],
  ['iron_chestplate', 8, 'torso'],
  ['iron_leggings', 7, 'legs'],
  ['iron_boots', 4, 'feet']
]

const CREEPER_RADIUS = 7
const HOSTILE_FIGHT_RADIUS = 4.5
const HOSTILE_FLEE_HEALTH = 10
const EAT_FOOD_LEVEL = 15
const EAT_HEALTH_LEVEL = 14
const USER_HOLD_MS = 90000

function countOf (items, name) {
  return items.filter((it) => it && it.name === name).reduce((a, it) => a + (it.count || 1), 0)
}

function countAny (items, names) {
  return names.reduce((a, n) => a + countOf(items, n), 0)
}

function foodItems (items) {
  return items.filter((it) => it && FOOD_SCORE[it.name] !== undefined)
}

// the tier ladder: the best entry the inventory already holds
function bestTier (items, tiers) {
  for (let i = tiers.length - 1; i >= 0; i--) {
    if (countOf(items, tiers[i]) > 0) return tiers[i]
  }
  return null
}

function blockInRange (bot, names, maxDistance) {
  const reg = bot.registry
  if (!reg || !reg.blocksByName || typeof bot.findBlocks !== 'function') return false
  const ids = names.map((n) => reg.blocksByName[n]).filter(Boolean).map((m) => m.id)
  if (ids.length === 0) return false
  try {
    const found = bot.findBlocks({ matching: ids, maxDistance: maxDistance || 48, count: 1 })
    return !!(found && found.length > 0)
  } catch (e) { return false }
}

// ---------------------------------------------------------------- decide
// PURE: everything the brain knows, distilled into the next activity.
// unit-tested against hand-built snapshots.

// worn armor, read from the player window's equipment slots (5-8). null on
// builds without slot access (the offline fake) — the armor ladder simply
// stays off there instead of misdetecting pieces as missing.
function wornArmor (bot) {
  try {
    const slots = bot.inventory && bot.inventory.slots
    if (!slots) return null
    return [5, 6, 7, 8].map((s) => (slots[s] && slots[s].name) || null)
  } catch (e) { return null }
}

function snapshot (bot, pilot) {
  const items = (bot.inventory && bot.inventory.items()) || []
  const p = bot.entity && bot.entity.position
  const hostiles = []
  const animals = []
  if (p) {
    for (const e of Object.values(bot.entities || {})) {
      if (!e || !e.position || e === bot.entity) continue
      const n = String(e.name || e.type || '')
      const d = e.position.distanceTo(p)
      if (HOSTILE_RE.test(n)) hostiles.push({ name: n, d, entity: e })
      else if (ANIMAL_RE.test(n)) animals.push({ name: n, d, entity: e })
    }
    hostiles.sort((a, b) => a.d - b.d)
    animals.sort((a, b) => a.d - b.d)
  }
  const snap = {
    health: bot.health || 20,
    food: bot.food || 20,
    items,
    counts: {
      logs: countAny(items, LOGS),
      planks: countAny(items, PLANKS),
      stick: countOf(items, 'stick'),
      cobblestone: countOf(items, 'cobblestone') + countOf(items, 'cobbled_deepslate'),
      coal: countOf(items, 'coal') + countOf(items, 'charcoal'),
      iron: countOf(items, 'iron_ingot') + countOf(items, 'raw_iron'),
      torch: countOf(items, 'torch'),
      craftingTableItem: countOf(items, 'crafting_table'),
      furnaceItem: countOf(items, 'furnace'),
      food: foodItems(items).reduce((a, it) => a + (it.count || 1), 0),
      rawFood: items.filter((it) => RAW_FOOD.has(it.name)).reduce((a, it) => a + (it.count || 1), 0)
    },
    pick: bestTier(items, PICK_TIERS),
    sword: bestTier(items, SWORD_TIERS),
    axe: bestTier(items, AXE_TIERS),
    armor: wornArmor(bot),
    hostiles,
    animals,
    creeperNear: hostiles.some((h) => /creeper/.test(h.name) && h.d < CREEPER_RADIUS),
    hostileNear: hostiles.length > 0 ? hostiles[0] : null,
    animalNear: animals.length > 0 ? animals[0] : null,
    tableInRange: blockInRange(bot, ['crafting_table'], 32),
    furnaceInRange: blockInRange(bot, ['furnace', 'blast_furnace'], 32),
    stoneInRange: blockInRange(bot, STONES, 48),
    ironInRange: blockInRange(bot, IRON_ORES, 48),
    coalInRange: blockInRange(bot, ['coal_ore', 'deepslate_coal_ore'], 48)
  }
  return snap
}

function decide (snap, opts) {
  const o = opts || {}
  const c = snap.counts

  // ---- reflexes (never held back by a user command) ----
  if (snap.creeperNear) {
    return { kind: 'flee', reason: 'creeper nearby', urgent: true }
  }
  if (snap.hostileNear && snap.hostileNear.d < HOSTILE_FIGHT_RADIUS) {
    if (snap.health <= HOSTILE_FLEE_HEALTH) return { kind: 'flee', reason: `hurt, ${snap.hostileNear.name} close`, urgent: true }
    return { kind: 'fight', reason: `${snap.hostileNear.name} in reach`, urgent: true, target: snap.hostileNear.name }
  }
  if ((snap.health <= EAT_HEALTH_LEVEL || snap.food <= EAT_FOOD_LEVEL) && c.food > 0) {
    return { kind: 'eat', reason: snap.food <= EAT_FOOD_LEVEL ? 'hungry' : 'hurt', urgent: true }
  }

  // ---- beyond here, a recent human command wins ----
  if (o.userHold) return { kind: 'idle', reason: 'human has the controls' }

  // ---- needs ----
  // food pipeline: cook raw meat when a furnace can happen, else hunt
  if (c.rawFood > 0 && (snap.furnaceInRange || c.furnaceItem > 0 || c.cobblestone >= 8)) {
    return { kind: 'cook', reason: `${c.rawFood} raw food to cook`, target: 'rawFood' }
  }
  if (c.food === 0 && snap.animalNear && o.hunt !== false) {
    return { kind: 'hunt', reason: 'no food carried', target: snap.animalNear.name }
  }

  // tool progression: a pickaxe is the ladder everything else climbs.
  // order matters — the crafting table precedes anything shaped for it.
  if (!snap.pick) {
    if (c.craftingTableItem > 0 && !snap.tableInRange) return { kind: 'place', reason: 'place the crafting table', block: 'crafting_table' }
    if (!snap.tableInRange && c.craftingTableItem === 0 && c.planks >= 4) {
      return { kind: 'craft', reason: 'craft a crafting table', item: 'crafting_table', count: 1 }
    }
    if (c.planks >= 3 && c.stick >= 2) return { kind: 'craft', reason: 'craft a wooden pickaxe', item: 'wooden_pickaxe', count: 1 }
    if (c.stick < 2 && c.planks >= 6) return { kind: 'craft', reason: 'craft sticks', item: 'stick', count: 1 }
    if (c.logs > 0 && c.planks < 4) return { kind: 'craft', reason: 'mill logs into planks', item: 'planks', count: Math.max(1, Math.min(8, c.logs)), any: true }
    return { kind: 'gather', reason: 'chop wood for tools', blocks: LOGS, count: 4 }
  }
  if (snap.pick === 'wooden_pickaxe' && snap.stoneInRange && c.cobblestone < 8) {
    return { kind: 'gather', reason: 'mine stone for better tools', blocks: ['stone', 'cobblestone', 'cobbled_deepslate'], count: 10 }
  }
  if (!snap.sword && c.cobblestone >= 2 && c.stick >= 1) {
    return { kind: 'craft', reason: 'craft a stone sword', item: 'stone_sword', count: 1 }
  }
  if (snap.pick === 'wooden_pickaxe' && c.cobblestone >= 3 && c.stick >= 2) {
    return { kind: 'craft', reason: 'craft a stone pickaxe', item: 'stone_pickaxe', count: 1 }
  }
  if (!snap.axe && c.cobblestone >= 3 && c.stick >= 2 && snap.pick === 'stone_pickaxe') {
    return { kind: 'craft', reason: 'craft a stone axe', item: 'stone_axe', count: 1 }
  }
  // furnace for cooking (and smelting ore) once cobble exists
  if (!snap.furnaceInRange && c.furnaceItem === 0 && c.cobblestone >= 8 && (c.rawFood > 0 || c.iron > 0 || snap.ironInRange)) {
    return { kind: 'craft', reason: 'craft a furnace', item: 'furnace', count: 1 }
  }
  if (!snap.furnaceInRange && c.furnaceItem > 0) {
    return { kind: 'place', reason: 'place the furnace', block: 'furnace' }
  }
  // iron: ore first, then smelt, then tools
  if (snap.pick !== 'iron_pickaxe' && snap.ironInRange && c.iron < 3) {
    return { kind: 'gather', reason: 'mine iron ore', blocks: IRON_ORES, count: 5 }
  }
  if (snap.pick === 'stone_pickaxe' && c.iron >= 3 && c.stick >= 2) {
    return { kind: 'craft', reason: 'craft an iron pickaxe', item: 'iron_pickaxe', count: 1 }
  }
  // an iron sword before the armor: the best defense is killing it faster
  if (snap.sword && snap.sword !== 'iron_sword' && c.iron >= 4 && c.stick >= 1) {
    return { kind: 'craft', reason: 'craft an iron sword', item: 'iron_sword', count: 1 }
  }
  // armor: the first missing piece, when iron allows it after the tools
  // (cost + 2 spare ingots so the ladder never eats its own runway)
  if (snap.armor && snap.pick === 'iron_pickaxe') {
    const equipIndex = { head: 0, torso: 1, legs: 2, feet: 3 }
    for (const [piece, cost, dest] of ARMOR_TIERS) {
      const worn = snap.armor[equipIndex[dest]]
      const carried = countOf(snap.items, piece)
      if (worn || carried > 0) continue
      if (c.iron >= cost + 2 && c.iron >= 5) {
        return { kind: 'craft', reason: `craft ${piece}`, item: piece, count: 1, equip: dest }
      }
      break // not enough iron for the next missing piece yet
    }
  }
  if (c.iron > 0 && !snap.furnaceInRange) {
    return { kind: 'smelt', reason: 'smelt the raw iron', target: 'iron' }
  }
  if (c.iron >= 3 && (snap.furnaceInRange || c.furnaceItem > 0)) {
    return { kind: 'smelt', reason: 'smelt the raw iron', target: 'iron' }
  }
  // torches: coal or charcoal plus sticks
  if (c.torch < 16 && c.coal >= 1 && c.stick >= 1) {
    return { kind: 'craft', reason: 'craft torches', item: 'torch', count: 4 }
  }
  if (c.torch < 16 && c.coal === 0 && snap.coalInRange && snap.pick) {
    return { kind: 'gather', reason: 'mine coal for torches', blocks: ['coal_ore', 'deepslate_coal_ore'], count: 5 }
  }
  // stock wood — tools burn through it
  if (c.logs < 4 && c.planks < 8) {
    return { kind: 'gather', reason: 'keep wood stocked', blocks: LOGS, count: 8 }
  }
  if (c.stick < 4 && c.planks >= 2) {
    return { kind: 'craft', reason: 'craft sticks', item: 'stick', count: 4 }
  }

  // ---- goals ----
  if (o.explore !== false) return { kind: 'explore', reason: 'nothing pressing — scouting' }
  return { kind: 'idle', reason: 'nothing to do' }
}

// ---------------------------------------------------------------- brain

function createBrain (ctx, hooks) {
  const h = hooks || {}
  const log = h.log || (() => {})
  let enabled = false
  let busy = null // { kind, startedAt, cancel }
  let userHoldUntil = 0
  let lastActivity = 'off'
  let tickTimer = null
  let disposed = false

  function status () {
    return {
      on: enabled,
      activity: enabled ? (busy ? busy.kind : lastActivity) : 'off',
      reason: busy ? busy.reason : (enabled ? 'thinking' : 'full-auto is off')
    }
  }

  function noteUserCommand () {
    if (!enabled) return
    userHoldUntil = Date.now() + USER_HOLD_MS
  }

  function setEnabled (on) {
    enabled = !!on
    if (!enabled) {
      cancelBusy()
      lastActivity = 'off'
      // hands the controls back: stop whatever the brain started walking —
      // a lingering executor keeps its (ref'd) 50ms timer alive, which in
      // tests holds the node:test child open forever (the ci hang) and in
      // play leaves the bot wandering after "auto off"
      try { ctx.pilot.stop() } catch (e) { /* already gone */ }
    } else {
      log('full-auto ON — reflexes, needs and goals take over (#auto off to stop)')
    }
    return enabled
  }

  function cancelBusy () {
    if (busy && busy.cancel) {
      try { busy.cancel() } catch (e) { /* ignore */ }
    }
    busy = null
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  async function waitIdle (pilot, timeoutMs, isCancelled) {
    const t0 = Date.now()
    for (;;) {
      if (isCancelled()) return false
      const t = pilot.task
      if (!t || t === 'idle') return true
      if (Date.now() - t0 > (timeoutMs || 120000)) return false
      await sleep(400)
    }
  }

  // place a block from the inventory near the bot (1-cell builder job)
  function placeCell (pilot, blockName, x, y, z) {
    const bp = {
      name: `auto_${blockName}`,
      placements: [{ x, y, z, block: blockName }]
    }
    return pilot.build(bp, { x: 0, y: 0, z: 0 })
  }

  function findSpotNear (pilot) {
    const p = pilot.pos()
    if (!p) return null
    const x0 = Math.floor(p.x)
    const y = Math.floor(p.y)
    const z0 = Math.floor(p.z)
    // a small ring of cells beside the bot, on solid ground, not our body
    for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2], [2, 1], [-2, -1], [1, 2], [-1, -2]]) {
      const x = x0 + dx
      const z = z0 + dz
      try {
        if (pilot.view.name(x, y, z) !== 'air') continue
        if (!pilot.view.solid(x, y - 1, z)) continue
        return { x, y, z }
      } catch (e) { /* unknown cell */ }
    }
    return null
  }

  async function runPlace (pilot, snap, blockName) {
    const spot = findSpotNear(pilot)
    if (!spot) { log(`auto: no spot beside the bot for the ${blockName}`); return false }
    placeCell(pilot, blockName, spot.x, spot.y, spot.z)
    const ok = await waitIdle(pilot, 60000, () => !busy || busy.kind !== 'place')
    if (ok) log(`auto: placed the ${blockName} at ${spot.x} ${spot.y} ${spot.z}`)
    return ok
  }

  async function runCraft (ctx2, item, count, anyPlanks) {
    // planks of any wood: pick the log we actually carry
    let want = item
    if (anyPlanks || item === 'planks') {
      const carried = LOGS.find((l) => countOf((ctx2.bot.inventory && ctx2.bot.inventory.items()) || [], l) > 0)
      if (carried) want = carried.replace('_log', '_planks')
      else want = 'oak_planks'
    }
    const inv = require('./inventory')
    let r = await inv.commandCraft(ctx2, { item: want, count })
    if (!r.ok && /crafting table is needed|no recipe/.test(r.error || '')) {
      // place a table from the inventory (or craft one first), then retry
      const placed = await runPlace(ctx2.pilot, null, 'crafting_table')
      if (placed) r = await inv.commandCraft(ctx2, { item: want, count })
    }
    return r
  }

  // a furnace within reach, or one made reachable: craft it (needs 8
  // cobble), place it beside the bot. the cook decision fires on materials
  // alone — this is where they become a real smelting station, so a world
  // without a furnace in range cannot wedge the brain in a cook loop.
  async function ensureFurnace (bot, pilot) {
    if (blockInRange(bot, ['furnace', 'blast_furnace'], 32)) return true
    const items = (bot.inventory && bot.inventory.items()) || []
    const furnaceItem = items.find((it) => it.name === 'furnace')
    if (!furnaceItem) {
      const cobble = countOf(items, 'cobblestone') + countOf(items, 'cobbled_deepslate')
      if (cobble < 8) return false
      const r = await runCraft(ctx, 'furnace', 1, false)
      if (!r.ok) {
        log(`auto: craft furnace failed — ${r.error}`)
        return false
      }
    }
    const placed = await runPlace(pilot, null, 'furnace')
    if (!placed) return false
    return blockInRange(bot, ['furnace', 'blast_furnace'], 32)
  }

  // open a furnace, load it, wait for the output, take it (the station
  // lessons apply: containerItems vs items, transfer for the take)
  async function runFurnace (bot, pilot, inputName, fuelName) {
    const { items } = require('./inventory')
    const reg = bot.registry
    const blockName = 'furnace'
    const meta = reg && reg.blocksByName ? reg.blocksByName[blockName] : null
    if (!meta) return { ok: false, error: 'no furnace data' }
    let target = null
    if (typeof bot.findBlocks === 'function') {
      const found = bot.findBlocks({ matching: meta.id, maxDistance: 32, count: 1 })
      if (found && found.length > 0) target = { x: found[0].x, y: found[0].y, z: found[0].z }
    }
    if (!target) return { ok: false, error: 'no furnace in range' }
    // walk into reach
    const p = pilot.pos()
    if (!p) return { ok: false, error: 'no position' }
    const far = Math.hypot(target.x + 0.5 - p.x, target.y + 0.5 - p.y, target.z + 0.5 - p.z) > 4
    if (far) {
      const { GoalGetToBlock } = require('./engine/goals')
      const r = pilot.driveTo(new GoalGetToBlock(target.x, target.y, target.z))
      if (r && (r.status === 'found' || r.status === 'partial')) await pilot.waitArrival(30000)
    }
    const block = pilot.botBlockAt(target)
    if (!block) return { ok: false, error: 'the furnace is gone' }
    const furnace = await bot.openFurnace(block)
    try {
      const inStack = items(bot).find((it) => it.name === inputName)
      if (!inStack) return { ok: false, error: `no ${inputName} to smelt` }
      const invItems = items(bot)
      const countOfName = (n) => invItems.filter((it) => it.name === n).reduce((a, it) => a + (it.count || 1), 0)
      // fuel policy: coal/charcoal first; planks/logs only on a surplus —
      // never burn the wood the tool ladder still needs
      let fuel = invItems.find((it) => it.name === 'coal') || invItems.find((it) => it.name === 'charcoal')
      if (!fuel && countOfName('oak_planks') >= 8) fuel = invItems.find((it) => it.name === 'oak_planks')
      if (!fuel && countOfName('oak_log') >= 6) fuel = invItems.find((it) => it.name === 'oak_log')
      if (!fuel) return { ok: false, error: 'no fuel (coal or charcoal, or a wood surplus)' }
      await furnace.putInput(inStack.type, null, inStack.count)
      await furnace.putFuel(fuel.type, null, Math.max(1, Math.min(fuel.count, 4)))
      // wait for the WHOLE stack (10s per item vanilla): returning on the
      // first output strands the rest inside the furnace — the brain would
      // never come back for it once the inventory reads zero raw food
      const expected = Math.max(1, inStack.count)
      const deadline = Date.now() + 60000 + expected * 12000
      while (Date.now() < deadline) {
        const out = furnace.outputItem()
        const inp = furnace.inputItem()
        if (out && (out.count >= expected || out.count >= 64 || !inp)) {
          if (typeof bot.transfer === 'function') {
            await bot.transfer({
              window: furnace,
              itemType: out.type,
              metadata: null,
              count: out.count,
              sourceStart: 2,
              sourceEnd: 3,
              destStart: furnace.inventoryStart,
              destEnd: furnace.inventoryEnd
            })
          } else {
            await furnace.takeOutput()
          }
          return { ok: true, output: out.name, count: out.count }
        }
        await sleep(1500)
      }
      return { ok: false, error: 'smelt timed out' }
    } finally {
      try { furnace.close() } catch (e) { /* gone */ }
      // same cure as the station manager: force the server to resend the
      // player inventory after closing the furnace, or the next craft sees
      // phantom stacks (reproduced live: split planks, missing ingredients)
      try {
        if (typeof bot._syncWindow === 'function' && bot.inventory) {
          const p = bot._syncWindow(bot.inventory)
          if (p && p.catch) p.catch(() => {})
        }
      } catch (e) { /* older builds */ }
    }
  }

  async function execute (activity) {
    const { bot, pilot } = ctx
    lastActivity = activity.kind
    const isCurrent = () => busy && busy.kind === activity.kind

    if (activity.kind === 'eat') {
      const r = await require('./inventory').eatOnce(bot)
      if (r.ok) log(`auto: ${r.reply}`)
      return
    }
    if (activity.kind === 'flee') {
      // away from whatever is scaring us — the pilot's runaway launch
      const p = bot.entity && bot.entity.position
      if (!p) return
      let threat = null
      let bestD = Infinity
      for (const e of Object.values(bot.entities || {})) {
        if (!e || !e.position) continue
        if (!HOSTILE_RE.test(String(e.name || e.type || ''))) continue
        const d = e.position.distanceTo(p)
        if (d < bestD) { bestD = d; threat = e }
      }
      if (!threat) return
      pilot.runAway(threat.position.x, threat.position.z, 24)
      await waitIdle(pilot, 45000, () => !isCurrent())
      return
    }
    if (activity.kind === 'fight') {
      const { runCombat } = require('./processes/combat')
      pilot.startJob('attack', `auto: fight ${activity.target}`, (alive) => runCombat(pilot, activity.target, alive))
      await waitIdle(pilot, 60000, () => !isCurrent())
      return
    }
    if (activity.kind === 'hunt') {
      const { runCombat } = require('./processes/combat')
      const { runPickup } = require('./processes/pickup')
      pilot.startJob('hunt', `auto: hunt ${activity.target}`, async (alive) => {
        await runCombat(pilot, activity.target, alive)
        if (alive()) await runPickup(pilot, 16, alive)
      })
      await waitIdle(pilot, 120000, () => !isCurrent())
      return
    }
    if (activity.kind === 'gather') {
      pilot.mine(activity.blocks, activity.count)
      await waitIdle(pilot, 180000, () => !isCurrent())
      return
    }
    if (activity.kind === 'craft') {
      const r = await runCraft(ctx, activity.item, activity.count, activity.any)
      if (r.ok) {
        log(`auto: ${r.reply || `crafted ${activity.item}`}`)
        // armor goes on the moment it exists — a piece in the inventory
        // protects nothing
        if (activity.equip) {
          const stack = require('./inventory').findStack(bot, activity.item)
          if (stack && bot.equip) {
            try { await bot.equip(stack, activity.equip) } catch (e) { /* worn slot race */ }
          }
        }
      } else {
        log(`auto: craft ${activity.item} failed — ${r.error}`)
      }
      return
    }
    if (activity.kind === 'place') {
      await runPlace(pilot, null, activity.block)
      return
    }
    if (activity.kind === 'cook' || activity.kind === 'smelt') {
      // the cook decision fires on materials; make the station real first
      if (!blockInRange(bot, ['furnace', 'blast_furnace'], 32)) {
        const ready = await ensureFurnace(bot, pilot)
        if (!ready) {
          log('auto: no furnace to cook with yet — waiting for materials')
          return
        }
      }
      const items = (bot.inventory && bot.inventory.items()) || []
      const raw = items.find((it) => RAW_FOOD.has(it.name)) ||
        (activity.target === 'iron' ? items.find((it) => it.name === 'raw_iron') : null)
      if (!raw) return
      const r = await runFurnace(bot, pilot, raw.name, null)
      if (r.ok) log(`auto: smelted ${r.name || raw.name} -> ${r.output} x${r.count || 1}`)
      else log(`auto: smelt failed — ${r.error}`)
      return
    }
    if (activity.kind === 'explore') {
      pilot.explore(256)
      // exploring is long: let the next tick interrupt it on real needs
      await sleep(8000)
      return
    }
  }

  let ticking = false
  // an activity that keeps re-deciding with zero world change gets a
  // taboo cooldown — an autonomous loop must not spin on the impossible
  const taboos = new Map() // kind(+item/block) -> until-ms
  let lastStateKey = null
  let sameState = 0
  async function tick () {
    if (!enabled || disposed || ticking || !ctx.bot || !ctx.pilot) return
    ticking = true
    try {
      // a running activity keeps the floor unless a reflex interrupts
      const snap = snapshot(ctx.bot, ctx.pilot)
      if (busy) {
        if (Date.now() - busy.startedAt > 240000) {
          log(`auto: ${busy.kind} took too long — dropping it`)
          cancelBusy()
          try { ctx.pilot.stop() } catch (e) { /* ignore */ }
        } else if (busy.kind !== 'flee' && busy.kind !== 'fight' && busy.kind !== 'eat') {
          const urgent = decide(snap, { userHold: false })
          if (urgent.urgent && urgent.kind !== busy.kind) {
            log(`auto: reflex — ${urgent.reason} (was ${busy.kind})`)
            cancelBusy()
            try { ctx.pilot.stop() } catch (e) { /* ignore */ }
          }
        }
        return
      }
      const activity = decide(snap, {
        userHold: Date.now() < userHoldUntil,
        explore: ctx.settings ? ctx.settings.get('autoExplore') !== false : true,
        hunt: ctx.settings ? ctx.settings.get('autoHunt') !== false : true
      })
      if (activity.kind === 'idle') {
        lastActivity = 'idle'
        return
      }
      // a tabooed kind waits out its cooldown silently
      // taboo per kind AND target — a sticks dead-end must not also gag
      // the pickaxe craft for 90s (both are kind 'craft', seen live)
      const tabooKey = activity.kind + (activity.item ? ':' + activity.item : (activity.block ? ':' + activity.block : ''))
      if ((taboos.get(tabooKey) || 0) > Date.now()) {
        lastActivity = 'waiting'
        return
      }
      // stuck detector: same decision, same world -> cooldown that kind
      const stateKey = activity.kind + '|' + JSON.stringify(snap.counts) + '|' + (activity.item || activity.block || (activity.blocks ? activity.blocks.join(',') : '') || '')
      if (stateKey === lastStateKey) {
        sameState++
        if (sameState >= 3) {
          taboos.set(tabooKey, Date.now() + 90000)
          log(`auto: ${activity.reason} is going nowhere — backing off for 90s`)
          sameState = 0
          lastStateKey = null
          lastActivity = 'waiting'
          return
        }
      } else {
        lastStateKey = stateKey
        sameState = 0
      }
      busy = { kind: activity.kind, reason: activity.reason, startedAt: Date.now(), cancel: null }
      if (!activity.urgent) log(`auto: ${activity.reason}`)
      try {
        await execute(activity)
      } catch (e) {
        log(`auto: ${activity.kind} error — ${String(e.message || e).slice(0, 80)}`)
      } finally {
        if (busy && busy.kind === activity.kind) busy = null
      }
    } finally {
      ticking = false
    }
  }

  function start (intervalMs) {
    if (tickTimer) clearInterval(tickTimer)
    tickTimer = setInterval(() => { tick().catch(() => {}) }, intervalMs || 1200)
    if (tickTimer.unref) tickTimer.unref()
  }

  function dispose () {
    disposed = true
    if (tickTimer) clearInterval(tickTimer)
    tickTimer = null
    cancelBusy()
    // a test or shutdown can end mid-activity — the pilot's executor timer
    // is a ref'd handle and would hold the process open (and the bot
    // walking) after the brain is gone
    try { ctx.pilot.stop() } catch (e) { /* already gone */ }
  }

  return { setEnabled, status, tick, start, dispose, noteUserCommand, snapshot, decide }
}

module.exports = { createBrain, snapshot, decide, HOSTILE_RE, ANIMAL_RE, LOGS, PLANKS, RAW_FOOD }
