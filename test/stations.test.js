'use strict'

// the crafting + station layer: the recipe index (pure data), the station
// manager (chest / furnace / villager windows against the fake bot) and
// the cockpit protocol that exposes both (rest + ws frames).

const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const WebSocket = require('ws')
const os = require('os')
const path = require('path')

const { createDefaultSettings } = require('../src/settings')
const { Autopilot } = require('../src/autopilot')
const { WaypointStore } = require('../src/waypoints')
const { SelectionManager } = require('../src/selection')
const { MapView } = require('../src/mapview')
const { createCockpitServer } = require('../src/server')
const { createStationManager } = require('../src/stations')
const { buildRecipeIndex, listRecipes } = require('../src/util/recipeindex')
const { FakeBot, VoxelWorld, mkItem } = require('./helpers/fake')

function makeStack (opts = {}) {
  const w = new VoxelWorld()
  w.fill(-16, 58, -16, 16, 63, 16, 'grass_block')
  w.fill(-16, 64, -16, 16, 120, 16, 'air')
  const bot = new FakeBot({ username: 'StationBot', version: '1.21.4' }, w)
  bot.spawnAt(opts.x || 0.5, 64, opts.z || 0.5)
  const settings = createDefaultSettings()
  const pilot = new Autopilot({ bot, deps: { Vec3 }, settings })
  const waypoints = new WaypointStore(path.join(os.tmpdir(), 'minepilot-st-' + Date.now() + '-' + Math.floor(Math.random() * 1e6) + '.json'))
  const selection = new SelectionManager()
  const ctx = {
    pilot, bot, settings, selection, waypoints,
    reply: () => {}, source: 'console', commander: null, exploreFilter: null
  }
  ctx.mapview = new MapView(bot, settings)
  return { ctx, bot, w }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- index

test('recipe index: shaped recipes, table flag, variant selection', () => {
  const idx = buildRecipeIndex(require('minecraft-data')('1.21.4'))
  assert.ok(idx.length > 500, 'a full index')
  const pick = idx.find((e) => e.name === 'iron_pickaxe')
  assert.ok(pick, 'iron_pickaxe indexed')
  assert.ok(pick.requiresTable, 'pickaxe needs a table')
  // with oak planks carried, crafting_table shows the oak variant
  const l = listRecipes(idx, [mkItem('oak_planks', 10)], 'crafting_table', {})
  const table = l.find((e) => e.name === 'crafting_table')
  assert.ok(table, 'crafting_table listed')
  assert.equal(table.craftable, true)
  assert.ok(table.ingredients.some((i) => i.name === 'oak_planks' && i.have === 10 && i.need === 4),
    'the variant matching the inventory is shown')
  // with cobblestone, the furnace recipe reads cobblestone, not deepslate
  const l2 = listRecipes(idx, [mkItem('cobblestone', 20)], 'furnace', {})
  const furnace = l2.find((e) => e.name === 'furnace')
  assert.equal(furnace.craftable, true)
  assert.ok(furnace.ingredients.every((i) => i.name === 'cobblestone'))
})

test('recipe index: availability flips with the inventory', () => {
  const idx = buildRecipeIndex(require('minecraft-data')('1.21.4'))
  const empty = listRecipes(idx, [], 'torch', {}).find((e) => e.name === 'torch')
  assert.equal(empty.craftable, false)
  const stocked = listRecipes(idx, [mkItem('stick', 4), mkItem('charcoal', 2)], 'torch', {}).find((e) => e.name === 'torch')
  assert.equal(stocked.craftable, true)
  assert.equal(stocked.count, 4, 'one craft makes 4 torches')
})

// ------------------------------------------------------------- manager

test('station manager: chest open -> deposit -> withdraw -> close', async () => {
  const { ctx, bot, w } = makeStack()
  w.setBlock(2, 64, 0, 'chest')
  bot.setInventory([mkItem('dirt', 32), mkItem('stone', 16)])
  const frames = []
  const stations = createStationManager(ctx, (f) => frames.push(f), () => {})
  const r = await stations.open('chest')
  assert.equal(r.ok, true, r.error)
  const win = bot.chestWindows[0]
  // deposit a stack of dirt
  const d = await stations.action({ action: 'deposit', name: 'dirt' })
  assert.equal(d.ok, true, d.error)
  assert.equal(win.containerItems().find((i) => i.name === 'dirt').count, 32)
  assert.equal(bot.inventory.items().find((i) => i.name === 'dirt'), undefined)
  // withdraw 8 back
  const wd = await stations.action({ action: 'withdraw', name: 'dirt', count: 8 })
  assert.equal(wd.ok, true, wd.error)
  assert.equal(bot.inventory.items().find((i) => i.name === 'dirt').count, 8)
  assert.equal(win.containerItems().find((i) => i.name === 'dirt').count, 24)
  // frames flowed — and the frame lists ONLY the chest's storage, never
  // the bot's own inventory (the stone is still carried, never deposited)
  const openFrames = frames.filter((f) => f.t === 'station' && f.open)
  assert.ok(openFrames.some((f) => f.items.some((i) => i.name === 'dirt')))
  assert.ok(openFrames.every((f) => !f.items.some((i) => i.name === 'stone')),
    'the chest frame must not leak the bot\'s own inventory (window.items() trap)')
  const c = await stations.action({ action: 'close' })
  assert.equal(c.ok, true)
  assert.equal(win.closed, true)
  assert.ok(frames.some((f) => f.t === 'station' && !f.open))
})

test('station manager: furnace put input+fuel, smelt, take output', async () => {
  const { ctx, bot, w } = makeStack()
  w.setBlock(-2, 64, 0, 'furnace')
  bot.setInventory([mkItem('oak_log', 8), mkItem('coal', 4)])
  const stations = createStationManager(ctx, () => {}, () => {})
  const r = await stations.open('furnace')
  assert.equal(r.ok, true, r.error)
  const win = bot.furnaceWindows[0]
  await stations.action({ action: 'put', role: 'input', name: 'oak_log', count: 2 })
  await stations.action({ action: 'put', role: 'fuel', name: 'coal', count: 1 })
  assert.equal(win.inputItem().name, 'oak_log')
  assert.equal(win.fuelItem().name, 'coal')
  // four fake smelt ticks -> one charcoal in the output slot
  for (let i = 0; i < 5; i++) win.smeltTick('charcoal')
  assert.equal(win.outputItem().name, 'charcoal')
  const t = await stations.action({ action: 'take', role: 'output' })
  assert.equal(t.ok, true, t.error)
  assert.equal(bot.inventory.items().find((i) => i.name === 'charcoal').count, 1)
})

test('station manager: villager trades through the window', async () => {
  const { ctx, bot } = makeStack()
  bot.entities[99] = {
    id: 99, name: 'villager', type: 'villager',
    position: new Vec3(1.5, 64, 0.5),
    trades: [{
      inputItem1: mkItem('wheat', 20),
      inputItem2: null,
      outputItem: mkItem('emerald', 1),
      tradeDisabled: false,
      nbTradeUses: 0,
      maximumNbTradeUses: 12
    }]
  }
  bot.setInventory([mkItem('wheat', 40)])
  const stations = createStationManager(ctx, () => {}, () => {})
  const r = await stations.open('villager', null, 99)
  assert.equal(r.ok, true, r.error)
  const tr = await stations.action({ action: 'trade', index: 0, times: 2 })
  assert.equal(tr.ok, true, tr.error)
  assert.equal(bot.inventory.items().find((i) => i.name === 'emerald').count, 2)
  assert.equal(bot.inventory.items().find((i) => i.name === 'wheat'), undefined)
})

test('station manager: errors are honest', async () => {
  const { ctx, bot, w } = makeStack()
  const stations = createStationManager(ctx, () => {}, () => {})
  // nothing nearby
  const none = await stations.open('chest')
  assert.equal(none.ok, false)
  assert.match(none.error, /no chest within 16/)
  // no station open
  const noAction = await stations.action({ action: 'deposit', name: 'dirt' })
  assert.equal(noAction.ok, false)
  assert.match(noAction.error, /no station is open/)
  // chest present but unknown item
  w.setBlock(2, 64, 0, 'chest')
  await stations.open('chest')
  const noItem = await stations.action({ action: 'deposit', name: 'diamond' })
  assert.equal(noItem.ok, false)
  assert.match(noItem.error, /no diamond/)
})

test('station manager: walking away closes the session', async () => {
  const { ctx, bot, w } = makeStack()
  w.setBlock(2, 64, 0, 'chest')
  const frames = []
  const stations = createStationManager(ctx, (f) => frames.push(f), () => {})
  await stations.open('chest')
  assert.ok(stations.isOpen())
  // teleport far beyond the 6-block hold
  bot.entity.position = new Vec3(40.5, 64, 40.5)
  await sleep(1300)
  assert.equal(stations.isOpen(), false)
  assert.ok(frames.some((f) => f.t === 'station' && !f.open))
})

// ------------------------------------------------------------ protocol

test('cockpit protocol: recipes rest + ws, station frames over ws', async () => {
  const { ctx, bot, w } = makeStack()
  w.setBlock(2, 64, 0, 'chest')
  bot.setInventory([mkItem('oak_planks', 10), mkItem('stick', 4)])
  const cockpit = createCockpitServer(ctx)
  const addr = await cockpit.listen(0, '127.0.0.1')
  const base = `http://127.0.0.1:${addr.port}`

  try {
    // rest recipes
    const res = await fetch(base + '/api/recipes?q=pickaxe')
    const j = await res.json()
    assert.equal(res.status, 200)
    assert.ok(j.recipes.some((e) => e.name === 'iron_pickaxe'))
    // availability on the wire
    const j2 = await (await fetch(base + '/api/recipes?q=crafting_table')).json()
    const table = j2.recipes.find((e) => e.name === 'crafting_table')
    assert.equal(table.craftable, true)

    // ws: recipes:get -> recipes frame; station:open -> station frames
    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`)
    const seen = []
    ws.on('message', (d) => seen.push(JSON.parse(String(d))))
    await new Promise((r) => ws.on('open', r))
    ws.send(JSON.stringify({ t: 'recipes:get', q: 'torch' }))
    await sleep(300)
    const recipesFrame = seen.find((m) => m.t === 'recipes')
    assert.ok(recipesFrame, 'recipes frame arrived')
    assert.ok(!recipesFrame.recipes.some((e) => e.craftable), 'torch not craftable without materials')
    ws.send(JSON.stringify({ t: 'station:open', kind: 'chest' }))
    await sleep(300)
    const stationFrame = seen.find((m) => m.t === 'station' && m.open)
    assert.ok(stationFrame, 'station open frame')
    assert.equal(stationFrame.kind, 'chest')
    // deposit through the ws, expect an updated frame + reply chat
    ws.send(JSON.stringify({ t: 'station:action', action: 'deposit', name: 'oak_planks', count: 4 }))
    await sleep(300)
    const chestWin = bot.chestWindows[0]
    assert.equal(chestWin.containerItems().find((i) => i.name === 'oak_planks').count, 4)
    assert.ok(seen.some((m) => m.t === 'chat' && /deposited 4 oak_planks/.test(m.text)))
    ws.send(JSON.stringify({ t: 'station:action', action: 'close' }))
    await sleep(200)
    assert.ok(seen.some((m) => m.t === 'station' && !m.open))
    ws.close()
  } finally {
    await cockpit.close()
  }
})
