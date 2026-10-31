'use strict'

// the survival brain: decide() is pure and gets table-driven coverage;
// the full progression (logs -> planks -> table -> wooden pick -> stone ->
// stone pick -> torches) runs against the kinematic fake in one loop.

const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')

const { createDefaultSettings } = require('../src/settings')
const { Autopilot } = require('../src/autopilot')
const { WaypointStore } = require('../src/waypoints')
const { SelectionManager } = require('../src/selection')
const { createBrain, snapshot, decide } = require('../src/brain')
const { FakeBot, VoxelWorld, mkItem } = require('./helpers/fake')
const os = require('os')
const path = require('path')

function makeStack (opts = {}) {
  const w = new VoxelWorld()
  // grass floor over stone — a mineable survival world
  w.fill(-24, 50, -24, 24, 60, 24, 'stone')
  w.fill(-24, 61, -24, 24, 61, 24, 'grass_block')
  w.fill(-24, 62, -24, 24, 130, 24, 'air')
  // reachable wood: fallen logs at ground level (a standing tree's crown
  // is out of reach once its trunk is mined away)
  w.fill(8, 62, 2, 8, 62, 7, 'oak_log')
  w.fill(-8, 62, 2, -8, 62, 5, 'oak_log')
  // surface coal (more than one: cover-digging for stone can eat one)
  w.setBlock(6, 61, 6, 'coal_ore')
  w.setBlock(-6, 61, 6, 'coal_ore')
  w.setBlock(0, 61, -6, 'coal_ore')
  w.setBlock(12, 61, -3, 'coal_ore')
  const bot = new FakeBot({ username: 'BrainBot', version: '1.21.4' }, w)
  bot.spawnAt(0.5, 62, 0.5)
  const settings = createDefaultSettings()
  const pilot = new Autopilot({ bot, deps: { Vec3 }, settings })
  const waypoints = new WaypointStore(path.join(os.tmpdir(), 'minepilot-brain-' + Date.now() + '-' + Math.floor(Math.random() * 1e6) + '.json'))
  const selection = new SelectionManager()
  const logs = []
  const ctx = {
    pilot, bot, settings, selection, waypoints,
    reply: () => {}, source: 'brain', commander: null, exploreFilter: null
  }
  ctx.mapview = { stats: () => ({ chunks: 0, dirty: 0 }), viewport: () => [], drainDirty: () => [], topOf: () => null, chunkPayload: () => null, cache: { clear () {} } }
  const brain = createBrain(ctx, { log: (t) => logs.push(t) })
  ctx.brain = brain
  return { ctx, bot, w, brain, logs, settings }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// hand-built snapshot for pure decide() tests
function snap (over) {
  return Object.assign({
    health: 20,
    food: 20,
    items: [],
    counts: {
      logs: 0, planks: 0, stick: 0, cobblestone: 0, coal: 0, iron: 0,
      torch: 0, craftingTableItem: 0, furnaceItem: 0, food: 0, rawFood: 0
    },
    pick: null, sword: null, axe: null,
    hostiles: [], animals: [],
    creeperNear: false, hostileNear: null, animalNear: null,
    tableInRange: false, furnaceInRange: false,
    stoneInRange: false, ironInRange: false, coalInRange: false
  }, over)
}

// ---------------------------------------------------------------- decide

test('decide: reflexes first', () => {
  assert.equal(decide(snap({ creeperNear: true })).kind, 'flee')
  const zombie = { name: 'zombie', d: 3 }
  assert.equal(decide(snap({ hostileNear: zombie })).kind, 'fight')
  assert.equal(decide(snap({ hostileNear: zombie, health: 8 })).kind, 'flee')
  assert.equal(decide(snap({ food: 5, counts: { ...snap().counts, food: 3 } })).kind, 'eat')
  assert.equal(decide(snap({ health: 10, counts: { ...snap().counts, food: 3 } })).kind, 'eat')
})

test('decide: a recent human command holds back goals, never reflexes', () => {
  const hungry = snap({ food: 5, counts: { ...snap().counts, food: 3 } })
  assert.equal(decide(hungry, { userHold: true }).kind, 'eat')
  const woodless = snap({})
  assert.equal(decide(woodless, { userHold: true }).kind, 'idle')
  assert.equal(decide(woodless, {}).kind, 'gather')
})

test('decide: the tool ladder', () => {
  // nothing carried: wood first
  assert.deepEqual(decide(snap({})), { kind: 'gather', reason: 'chop wood for tools', blocks: ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log', 'pale_oak_log'], count: 4 })
  // logs carried: mill them
  const c1 = { ...snap().counts, logs: 5 }
  assert.equal(decide(snap({ counts: c1 })).kind, 'craft')
  // planks, no table: the table precedes anything shaped for it
  const c2 = { ...snap().counts, planks: 20 }
  const a2 = decide(snap({ counts: c2 }))
  assert.equal(a2.kind, 'craft')
  assert.equal(a2.item, 'crafting_table')
  // table item held: place it
  const c4 = { ...snap().counts, craftingTableItem: 1, planks: 20, stick: 4 }
  const a4 = decide(snap({ counts: c4 }))
  assert.equal(a4.kind, 'place')
  assert.equal(a4.block, 'crafting_table')
  // table in range + materials: the pickaxe
  const c3 = { ...snap().counts, planks: 20, stick: 4 }
  const a3 = decide(snap({ counts: c3, tableInRange: true }))
  assert.equal(a3.kind, 'craft')
  assert.equal(a3.item, 'wooden_pickaxe')
})

test('decide: stone, sword, furnace, iron, torches', () => {
  // wooden pick + stone in world: gather stone
  const a1 = decide(snap({ pick: 'wooden_pickaxe', stoneInRange: true }))
  assert.equal(a1.kind, 'gather')
  assert.deepEqual(a1.blocks, ['stone', 'cobblestone', 'cobbled_deepslate'])
  // enough cobble: stone sword first
  const c2 = { ...snap().counts, cobblestone: 12, stick: 6 }
  assert.equal(decide(snap({ pick: 'wooden_pickaxe', counts: c2 })).item, 'stone_sword')
  // sword owned: stone pickaxe
  const c3 = { ...snap().counts, cobblestone: 10, stick: 4 }
  assert.equal(decide(snap({ pick: 'wooden_pickaxe', sword: 'stone_sword', counts: c3 })).item, 'stone_pickaxe')
  // raw food + furnace possible: cook
  const c4 = { ...snap().counts, rawFood: 2, cobblestone: 10 }
  assert.equal(decide(snap({ counts: c4 })).kind, 'cook')
  // no food but an animal: hunt
  assert.equal(decide(snap({ animalNear: { name: 'cow', d: 8 } })).kind, 'hunt')
  // iron ore + stone pick: mine it
  assert.equal(decide(snap({ pick: 'stone_pickaxe', ironInRange: true })).kind, 'gather')
  // iron ingots: iron pickaxe
  const c5 = { ...snap().counts, iron: 4, stick: 6 }
  assert.equal(decide(snap({ pick: 'stone_pickaxe', counts: c5 })).item, 'iron_pickaxe')
  // coal + sticks: torches
  const c6 = { ...snap().counts, coal: 3, stick: 6, pick: 'stone_pickaxe' }
  assert.equal(decide(snap({ counts: c6, pick: 'stone_pickaxe' })).item, 'torch')
})

test('decide: the defense ladder — iron sword, then armor pieces', () => {
  // iron sword before any armor: killing faster is the best defense
  const sw = { ...snap().counts, iron: 4, stick: 1 }
  const aSw = decide(snap({ pick: 'stone_pickaxe', sword: 'stone_sword', counts: sw, furnaceInRange: true }))
  assert.equal(aSw.kind, 'craft')
  assert.equal(aSw.item, 'iron_sword')
  // armor ladder off without slot access (the offline fake): iron goes to
  // torches/wood instead of phantom chestplates
  const noSlots = { ...snap().counts, iron: 20, coal: 3, stick: 6 }
  assert.notEqual(decide(snap({ pick: 'iron_pickaxe', sword: 'iron_sword', counts: noSlots, furnaceInRange: true })).item, 'iron_helmet')
  // with slots: the first missing piece when iron covers cost + 2 spare
  const bare = [null, null, null, null]
  const c1 = { ...snap().counts, iron: 7 }
  const a1 = decide(snap({ pick: 'iron_pickaxe', sword: 'iron_sword', armor: bare, counts: c1, furnaceInRange: true }))
  assert.equal(a1.item, 'iron_helmet')
  assert.equal(a1.equip, 'head')
  // not enough iron for helmet+spare: no armor craft, no infinite loop
  const c2 = { ...snap().counts, iron: 5 }
  const a2 = decide(snap({ pick: 'iron_pickaxe', sword: 'iron_sword', armor: bare, counts: c2, furnaceInRange: true }))
  assert.notEqual(a2.item, 'iron_helmet')
  // worn pieces are skipped: helmet on -> chestplate next
  const c3 = { ...snap().counts, iron: 10 }
  const a3 = decide(snap({ pick: 'iron_pickaxe', sword: 'iron_sword', armor: ['iron_helmet', null, null, null], counts: c3, furnaceInRange: true }))
  assert.equal(a3.item, 'iron_chestplate')
  assert.equal(a3.equip, 'torso')
  // a carried-but-unworn piece is not recrafted
  const c4 = { ...snap().counts, iron: 10 }
  const items4 = [{ name: 'iron_leggings', count: 1 }]
  const a4 = decide(snap({ pick: 'iron_pickaxe', sword: 'iron_sword', armor: ['iron_helmet', 'iron_chestplate', null, null], items: items4, counts: c4, furnaceInRange: true }))
  assert.equal(a4.item, 'iron_boots')
  assert.equal(a4.equip, 'feet')
})

test('decide: idle and explore', () => {
  const stocked = snap({
    pick: 'iron_pickaxe', sword: 'iron_sword', axe: 'iron_axe',
    counts: { ...snap().counts, logs: 10, planks: 20, stick: 8, torch: 20, food: 5, coal: 4 }
  })
  assert.equal(decide(stocked, {}).kind, 'explore')
  assert.equal(decide(stocked, { explore: false }).kind, 'idle')
})

// ------------------------------------------------------------ progression

test('full-auto progression: logs to stone tools against the fake world', async () => {
  const { bot, brain, w } = makeStack()
  brain.setEnabled(true)
  const has = (name) => (bot.inventory.items().find((i) => i.name === name) || {}).count || 0

  // drive the brain manually: each tick is one decision cycle (mining
  // waits make each tick take seconds). the 400s budget covers a slow
  // 2-core ci runner: a throw before dispose() leaves the executor's
  // ref'd timer alive, which holds the node:test child open forever —
  // the ci hang was exactly a failed assert skipping the cleanup
  let ticks = 0
  const t0 = Date.now()
  try {
    while (ticks < 900 && Date.now() - t0 < 400000) {
      await brain.tick()
      await sleep(60)
      ticks++
      if (has('stone_pickaxe') > 0 && has('torch') > 0) break
    }

    // the whole ladder happened with zero commands
    assert.ok(has('wooden_pickaxe') > 0, 'wooden pickaxe crafted (got ' + JSON.stringify(bot.inventory.items().map((i) => i.name)) + ')')
    assert.ok(has('stone_pickaxe') > 0, 'stone pickaxe crafted')
    assert.ok(has('stone_sword') > 0, 'stone sword crafted')
    assert.ok(has('torch') > 0, 'torches crafted from coal')
    // a crafting table was placed into the world somewhere along the way
    const table = [...w.blocks.values()].some((b) => b.name === 'crafting_table')
    assert.ok(table, 'crafting table placed into the world')
  } finally {
    brain.dispose()
  }
})

test('full-auto reflexes: a creeper interrupts and flees', async () => {
  const { ctx, bot, brain } = makeStack()
  brain.setEnabled(true)
  // a creeper 5 blocks away while the brain is mid-activity
  bot.entities[77] = { id: 77, name: 'creeper', type: 'creeper', position: new Vec3(5.5, 62, 0.5), velocity: new Vec3(0, 0, 0) }
  try {
    await brain.tick()
    await sleep(100)
    assert.equal(brain.status().activity, 'flee')
    // and the bot actually moved away from the creeper's x
    await sleep(3000)
    const x = bot.entity.position.x
    assert.ok(x < 0, `bot ran west of the creeper (x=${x})`)
  } finally {
    brain.dispose()
  }
})

test('full-auto eats when hungry', async () => {
  const { bot, brain } = makeStack()
  bot.setInventory([mkItem('bread', 3)])
  bot.food = 6
  brain.setEnabled(true)
  try {
    await brain.tick()
    await sleep(100)
    assert.equal(brain.status().activity, 'eat')
    // the bread was consumed
    await sleep(500)
    assert.equal((bot.inventory.items().find((i) => i.name === 'bread') || {}).count, 2)
  } finally {
    brain.dispose()
  }
})

test('auto command round-trips through the executor', async () => {
  const { ctx, brain } = makeStack()
  const { executeCommand } = require('../src/commandexec')
  const lines = []
  const cctx = { ...ctx, reply: (t) => lines.push(t), source: 'console' }
  assert.equal(brain.status().on, false)
  const on = await executeCommand('auto on', cctx)
  assert.equal(on.ok, true)
  assert.equal(brain.status().on, true)
  assert.equal(ctx.settings.get('autoSurvival'), true)
  const st = await executeCommand('auto status', cctx)
  assert.equal(st.ok, true)
  assert.match(lines.join(' | '), /full-auto: ON/)
  const off = await executeCommand('auto off', cctx)
  assert.equal(off.ok, true)
  assert.equal(brain.status().on, false)
  brain.dispose()
})
