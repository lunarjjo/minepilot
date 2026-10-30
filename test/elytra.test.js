'use strict'

// the elytra glide controller math — steering angles, boost decisions and
// equipment checks (the packet layer runs against real servers).

const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')

const { aimPitch, wantsBoost, hasElytraEquipped, terrainFloor } = require('../src/processes/elytra')
const { createDefaultSettings } = require('../src/settings')
const { Autopilot } = require('../src/autopilot')
const { FakeBot, VoxelWorld } = require('./helpers/fake')

test('elytra: pitch trades altitude for distance, bounded by a stall floor', () => {
  const shallow = aimPitch(200, 500) // high and far
  const steep = aimPitch(30, 500)
  const flattening = aimPitch(10, 500) // near the floor: stretches the glide
  assert.ok(shallow < 0 && steep < 0 && flattening < 0, 'all pitches look down')
  assert.ok(shallow <= steep, 'higher altitude aims no steeper than low altitude')
  assert.ok(flattening >= steep, 'near the floor the glide flattens (closer to level)')
  assert.ok(aimPitch(50, 20) >= -20 * Math.PI / 180, 'never dives steeper than ~-20 degrees on short hops')
  assert.ok(aimPitch(150, 500) <= aimPitch(30, 500), 'very high gains a diving bonus')
})

test('elytra: boost fires when the altitude budget runs out', () => {
  const s = createDefaultSettings()
  s.set('elytraFireworkBoost', true)
  assert.strictEqual(wantsBoost(6, 200, -0.5, s), true, 'low over the ground, far away')
  assert.strictEqual(wantsBoost(60, 200, -0.5, s), false, 'plenty of altitude left')
  assert.strictEqual(wantsBoost(6, 10, -0.5, s), false, 'basically arrived')
  assert.strictEqual(wantsBoost(6, 200, -1.2, s), true, 'sinking hard mid flight')
  s.set('elytraFireworkBoost', false)
  assert.strictEqual(wantsBoost(6, 200, -0.5, s), false, 'boosting disabled')
})

test('elytra: equipment detection sees the chestplate elytra', () => {
  const w = new VoxelWorld()
  const bot = new FakeBot({ username: 'E', version: '1.21.4' }, w)
  bot.spawnAt(0, 64, 0)
  assert.strictEqual(hasElytraEquipped(bot), false)
  bot.armor = [null, null, { name: 'elytra', count: 1 }, null]
  assert.strictEqual(hasElytraEquipped(bot), true)
  bot.armor = [null, null, { name: 'diamond_chestplate', count: 1 }, null]
  assert.strictEqual(hasElytraEquipped(bot), false)
  bot.disposePhysics()
})

test('elytra: terrain floor scans the loaded column below', () => {
  const w = new VoxelWorld()
  w.fill(-2, 40, -2, 2, 63, 2, 'stone')
  w.fill(-2, 64, -2, 2, 90, 2, 'air')
  const bot = new FakeBot({ username: 'E', version: '1.21.4' }, w)
  bot.spawnAt(0, 80, 0)
  const settings = createDefaultSettings()
  const pilot = new Autopilot({ bot, deps: { Vec3 }, settings })
  assert.strictEqual(terrainFloor(pilot, 0, 0, 80), 64)
  // below the surface: the column is solid, floor sits above the scan start
  assert.ok(terrainFloor(pilot, 0, 0, 50) >= 51)
  // unknown column: fog stops the scan, floor stays at the bottom
  assert.strictEqual(terrainFloor(pilot, 50, 50, 80), -64)
  bot.disposePhysics()
})
