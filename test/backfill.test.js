'use strict'

// the backfill process and the legitMine visibility filter — the two
// baritone parity gaps this phase closed.

const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')

const { recordDig, takeDugCells, runBackfill } = require('../src/processes/backfill')
const { findNearest } = require('../src/processes/mine')
const { createDefaultSettings } = require('../src/settings')
const { Autopilot } = require('../src/autopilot')
const { FakeBot, VoxelWorld } = require('./helpers/fake')

function world () {
  const w = new VoxelWorld()
  w.fill(-8, 58, -8, 8, 63, 8, 'grass_block')
  w.fill(-8, 64, -8, 8, 120, 8, 'air')
  return w
}

function makePilot (w, settings) {
  const bot = new FakeBot({ username: 'B', version: '1.21.4' }, w)
  bot.spawnAt(0, 64, 0)
  bot.setInventory([{ name: 'cobblestone', count: 64 }])
  return { bot, pilot: new Autopilot({ bot, deps: { Vec3 }, settings }) }
}

test('backfill: dug cells are recorded only when the setting is on', () => {
  const s = createDefaultSettings()
  const w = world()
  const { bot, pilot } = makePilot(w, s)
  // off by default
  recordDig(pilot, 1, 63, 0)
  assert.strictEqual(takeDugCells(pilot).length, 0)
  // on: cells accumulate, deduped
  s.set('backfill', true)
  recordDig(pilot, 1, 63, 0)
  recordDig(pilot, 1, 63, 0)
  recordDig(pilot, 2, 63, 0)
  const cells = takeDugCells(pilot)
  assert.strictEqual(cells.length, 2)
  // and the log drains
  assert.strictEqual(takeDugCells(pilot).length, 0)
  bot.disposePhysics()
})

test('backfill: fills recorded holes with throwaway blocks', { timeout: 30000 }, async () => {
  const s = createDefaultSettings()
  const w = world()
  // a dug tunnel through a wall
  w.setBlock(1, 64, 0, 'stone')
  w.setBlock(2, 64, 0, 'stone')
  w.setBlock(3, 64, 0, 'stone')
  w.removeBlock(2, 64, 0)
  w.removeBlock(3, 64, 0)
  const { bot, pilot } = makePilot(w, s)
  const out = await runBackfill(pilot, [{ x: 2, y: 64, z: 0 }, { x: 3, y: 64, z: 0 }], () => true)
  assert.strictEqual(out.filled, 2)
  assert.strictEqual(w.blockAtXYZ(2, 64, 0).name, 'cobblestone', 'throwaway block placed')
  assert.strictEqual(w.blockAtXYZ(3, 64, 0).name, 'cobblestone')
  bot.disposePhysics()
})

test('mine: legitMine refuses buried ores, accepts exposed ones', () => {
  const s = createDefaultSettings()
  const w = world()
  // a buried ore (no adjacent air) and an exposed one at the surface
  w.setBlock(2, 60, 1, 'diamond_ore') // deep inside solid ground, not our column
  w.setBlock(5, 63, 5, 'diamond_ore') // surface: air above
  const { bot, pilot } = makePilot(w, s)

  s.set('legitMine', false)
  const any = findNearest(pilot, ['diamond_ore'])
  assert.ok(any, 'x-ray mode sees the buried ore')
  assert.strictEqual(any.x, 2)
  assert.strictEqual(any.y, 60)

  s.set('legitMine', true)
  const legit = findNearest(pilot, ['diamond_ore'])
  assert.ok(legit, 'the exposed surface ore is visible')
  assert.strictEqual(legit.x, 5)
  assert.strictEqual(legit.y, 63)
  bot.disposePhysics()
})
