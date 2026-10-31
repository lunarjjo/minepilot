'use strict'

// the interaction layer: feed / breed / sleep / wake / activate — grammar
// and behavior against the fake bot.

const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')

const { parseCommand } = require('../src/commands')
const { executeCommand } = require('../src/commandexec')
const { createDefaultSettings } = require('../src/settings')
const { Autopilot } = require('../src/autopilot')
const { WaypointStore } = require('../src/waypoints')
const { SelectionManager } = require('../src/selection')
const { FakeBot, VoxelWorld, mkItem } = require('./helpers/fake')
const os = require('os')
const path = require('path')

function makeStack () {
  const w = new VoxelWorld()
  w.fill(-16, 58, -16, 16, 63, 16, 'grass_block')
  w.fill(-16, 64, -16, 16, 120, 16, 'air')
  const bot = new FakeBot({ username: 'InteractBot', version: '1.21.4' }, w)
  bot.spawnAt(0.5, 64, 0.5)
  const settings = createDefaultSettings()
  const pilot = new Autopilot({ bot, deps: { Vec3 }, settings })
  const waypoints = new WaypointStore(path.join(os.tmpdir(), 'minepilot-int-' + Date.now() + '-' + Math.floor(Math.random() * 1e6) + '.json'))
  const selection = new SelectionManager()
  const replies = []
  const ctx = {
    pilot, bot, settings, selection, waypoints,
    reply: (t) => replies.push(t), source: 'console', commander: null, exploreFilter: null
  }
  ctx.mapview = { stats: () => ({ chunks: 0, dirty: 0 }), viewport: () => [], drainDirty: () => [], topOf: () => null, chunkPayload: () => null, cache: { clear () {} } }
  return { ctx, bot, w, replies }
}

const cow = (id, x, z) => ({
  id, name: 'cow', type: 'cow', position: new Vec3(x, 64, z), velocity: new Vec3(0, 0, 0), yaw: 0
})

// ------------------------------------------------------------------ grammar

test('interaction grammar: feed / breed / sleep / wake / activate parse', () => {
  assert.deepEqual(parseCommand('feed cow'), { ok: true, name: 'feed', args: { entity: 'cow', item: null } })
  assert.deepEqual(parseCommand('feed cow wheat'), { ok: true, name: 'feed', args: { entity: 'cow', item: 'wheat' } })
  assert.equal(parseCommand('feed').ok, false)
  assert.equal(parseCommand('feed cow wheat extra').ok, false)
  assert.deepEqual(parseCommand('breed pig'), { ok: true, name: 'breed', args: { entity: 'pig' } })
  assert.equal(parseCommand('breed').ok, false)
  assert.deepEqual(parseCommand('activate lever'), { ok: true, name: 'activate', args: { block: 'lever' } })
  assert.deepEqual(parseCommand('sleep'), { ok: true, name: 'sleep', args: {} })
  assert.deepEqual(parseCommand('wake'), { ok: true, name: 'wake', args: {} })
})

// ---------------------------------------------------------------- behavior

test('feed: equips the right food and right-clicks the animal', async () => {
  const { ctx, bot, replies } = makeStack()
  bot.entities[10] = cow(10, 1.5, 0.5)
  bot.setInventory([mkItem('wheat', 5), mkItem('stone', 3)])
  const r = await executeCommand('feed cow', ctx)
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.deepEqual(bot.activatedEntities, ['cow'])
  assert.equal(bot.equips.includes('wheat'), true, 'wheat was equipped')
  // one wheat consumed by the server-side feed
  assert.equal(bot.inventory.items().find((i) => i.name === 'wheat').count, 4)
  assert.ok(replies.some((t) => /fed the cow with wheat/.test(t)))
})

test('feed: explicit item beats the default table', async () => {
  const { ctx, bot } = makeStack()
  bot.entities[10] = cow(10, 1.5, 0.5)
  bot.setInventory([mkItem('carrot', 2)])
  const r = await executeCommand('feed cow carrot', ctx)
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(bot.heldItem.name, 'carrot')
})

test('feed: honest errors — no animal, no food', async () => {
  const { ctx, bot } = makeStack()
  const none = await executeCommand('feed cow', ctx)
  assert.equal(none.ok, false)
  assert.match(none.error, /no cow within 16/)
  bot.entities[10] = cow(10, 1.5, 0.5)
  bot.setInventory([mkItem('stone', 3)])
  const noFood = await executeCommand('feed cow', ctx)
  assert.equal(noFood.ok, false)
  assert.match(noFood.error, /no breeding food for cow/)
  // an entity that cannot be fed at all
  bot.entities[11] = { id: 11, name: 'armor_stand', type: 'armor_stand', position: new Vec3(1.5, 64, 0.5) }
  bot.setInventory([mkItem('wheat', 5)])
  const cant = await executeCommand('feed armor_stand', ctx)
  assert.equal(cant.ok, false)
  assert.match(cant.error, /cannot be fed|no armor_stand/)
})

test('breed: feeds two animals of the kind', async () => {
  const { ctx, bot, replies } = makeStack()
  bot.entities[10] = cow(10, 1.5, 0.5)
  bot.entities[11] = cow(11, -1.5, 0.5)
  bot.setInventory([mkItem('wheat', 6)])
  const r = await executeCommand('breed cow', ctx)
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.deepEqual(bot.activatedEntities, ['cow', 'cow'])
  assert.equal(bot.inventory.items().find((i) => i.name === 'wheat').count, 4)
  assert.ok(replies.some((t) => /baby is on the way/.test(t)))
  // only one animal nearby -> refuse
  const { ctx: ctx2, bot: bot2 } = makeStack()
  bot2.entities[10] = cow(10, 1.5, 0.5)
  bot2.setInventory([mkItem('wheat', 6)])
  const few = await executeCommand('breed cow', ctx2)
  assert.equal(few.ok, false)
  assert.match(few.error, /need two cows/)
})

test('sleep + wake round trip on a real bed block', async () => {
  const { ctx, bot, w } = makeStack()
  w.setBlock(2, 64, 0, 'red_bed')
  bot.setInventory([])
  const s = await executeCommand('sleep', ctx)
  assert.equal(s.ok, true, JSON.stringify(s))
  assert.equal(bot.isSleeping, true)
  const wk = await executeCommand('wake', ctx)
  assert.equal(wk.ok, true)
  assert.equal(bot.isSleeping, false)
  // no bed in range
  const { ctx: ctx2 } = makeStack()
  const none = await executeCommand('sleep', ctx2)
  assert.equal(none.ok, false)
  assert.match(none.error, /no bed within 16/)
  // wake without sleeping
  const { ctx: ctx3 } = makeStack()
  const notAsleep = await executeCommand('wake', ctx3)
  assert.equal(notAsleep.ok, false)
  assert.match(notAsleep.error, /not sleeping/)
})

test('activate: right-clicks the nearest named block', async () => {
  const { ctx, bot, w } = makeStack()
  w.setBlock(2, 64, 0, 'lever')
  const r = await executeCommand('activate lever', ctx)
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.deepEqual(bot.activatedBlocks, ['lever'])
  const none = await executeCommand('activate button', ctx)
  assert.equal(none.ok, false)
  assert.match(none.error, /no button within 16/)
})
