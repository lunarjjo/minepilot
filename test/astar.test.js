'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { VoxelWorld } = require('./helpers/fake')
const { search } = require('../src/engine/astar')
const { generate, DEFAULTS } = require('../src/engine/moves')
const { GoalBlock, GoalNear, GoalXZ } = require('../src/engine/goals')
const { WorldView } = require('../src/engine/world')

function viewOf (world) {
  return new WorldView((x, y, z) => world.blockAtXYZ(x, y, z))
}

function flat (size = 40) {
  const w = new VoxelWorld()
  w.ground(-size, -size, size, size, 63)
  return w
}

function neighborsOf (v) {
  return (n) => generate(v, n, DEFAULTS)
}

test('astar: straight line on flat ground is optimal', () => {
  const v = viewOf(flat())
  const r = search({ x: 0, y: 64, z: 0 }, new GoalXZ(5, 0), neighborsOf(v))
  assert.strictEqual(r.status, 'found')
  assert.strictEqual(r.moves.length, 5)
  assert.ok(Math.abs(r.cost - 5) < 1e-9)
  const last = r.moves[r.moves.length - 1].to
  assert.strictEqual(last.x, 5)
  assert.strictEqual(last.z, 0)
})

test('astar: diagonal shortcut beats the L shape', () => {
  const v = viewOf(flat())
  const r = search({ x: 0, y: 64, z: 0 }, new GoalBlock(3, 64, 3), neighborsOf(v))
  assert.strictEqual(r.status, 'found')
  assert.ok(Math.abs(r.cost - 3 * Math.SQRT2) < 1e-9)
})

test('astar: detours around a wall instead of through it when digging is off', () => {
  const w = flat()
  // wall along x=1, z from -10..10, with a door at z=20 (far away)
  for (let z = -10; z <= 10; z++) {
    w.setBlock(1, 64, z, 'bedrock')
    w.setBlock(1, 65, z, 'air')
  }
  const noDig = Object.assign({}, DEFAULTS, { allowBreak: false })
  const v = viewOf(w)
  const r = search({ x: 0, y: 64, z: 0 }, new GoalBlock(4, 64, 0), (n) => generate(v, n, noDig))
  assert.strictEqual(r.status, 'found')
  assert.ok(r.cost > 4, 'the detour costs more than the straight line')
  assert.strictEqual(r.moves[r.moves.length - 1].to.x, 4)
})

test('astar: digs through a dirt wall when it is cheaper than detouring', () => {
  const w = flat()
  // a 4-high dirt wall: walking over needs 3 breaks, around costs 22+,
  // straight through only breaks the 2 cells the body occupies
  for (let z = -10; z <= 10; z++) {
    for (let y = 64; y <= 67; y++) w.setBlock(1, y, z, 'dirt')
  }
  const v = viewOf(w)
  const r = search({ x: 0, y: 64, z: 0 }, new GoalBlock(4, 64, 0), neighborsOf(v))
  assert.strictEqual(r.status, 'found')
  assert.strictEqual(r.moves[r.moves.length - 1].to.x, 4)
  assert.ok(r.moves.some((m) => m.toBreak.length > 0), 'the plan digs')
  const digs = r.moves.reduce((a, m) => a + m.toBreak.length, 0)
  assert.ok(digs <= 2, `through the wall only (${digs} breaks)`)
  // 2 dirt digs (0.75s * 4.3 b/s each + blockBreakAdditionalPenalty 2) + 4 walks
  assert.ok(r.cost > 9 && r.cost < 18, `dig-through stays cheapest (${r.cost})`)
})

test('astar: unreachable goal degrades to the best partial path', () => {
  const w = new VoxelWorld()
  // an island: 5x5 floor, nothing else known
  w.ground(-2, -2, 2, 2, 63)
  const v = viewOf(w)
  const r = search({ x: 0, y: 64, z: 0 }, new GoalXZ(30, 0), neighborsOf(v))
  assert.strictEqual(r.status, 'partial')
  assert.strictEqual(r.moves.length > 0, true)
  const end = r.moves[r.moves.length - 1].to
  assert.strictEqual(end.x, 2, 'walked to the last known block east')
})

test('astar: goal already met returns an empty found path', () => {
  const v = viewOf(flat())
  const r = search({ x: 3, y: 64, z: 3 }, new GoalNear(3, 64, 3, 1), neighborsOf(v))
  assert.strictEqual(r.status, 'found')
  assert.strictEqual(r.moves.length, 0)
})

test('astar: node budget caps the search and reports partial', () => {
  const w = new VoxelWorld()
  w.ground(-4, -4, 4, 4, 63) // small island
  const v = viewOf(w)
  const r = search({ x: 0, y: 64, z: 0 }, new GoalXZ(30, 0), neighborsOf(v), { maxNodes: 15 })
  assert.strictEqual(r.status, 'partial')
  assert.ok(r.expanded <= 15)
})

test('astar: finds a path over a staircase', () => {
  const w = new VoxelWorld()
  w.fill(-3, 55, -3, 3, 62, 3, 'stone') // solid base
  w.fill(-3, 63, -3, 3, 70, 3, 'air')
  // stairs climbing north: step at z=-1 top y=63, z=-2 top y=64, z=-3 top y=65
  w.setBlock(0, 63, -1, 'stone')
  w.setBlock(0, 64, -2, 'stone')
  w.setBlock(0, 65, -3, 'stone')
  const v = viewOf(w)
  const start = { x: 0, y: 63, z: 0 }
  const r = search(start, new GoalBlock(0, 66, -3), neighborsOf(v))
  assert.strictEqual(r.status, 'found')
  assert.strictEqual(r.moves[r.moves.length - 1].to.y, 66)
  assert.ok(r.moves.some((m) => m.type === 'ascend'), 'the climb uses ascends')
})

test('astar: prefers the cheap land bridge over swimming', () => {
  const w = new VoxelWorld()
  // start island, water gap of 2, goal island — with a 1-wide land bridge at z=5
  w.fill(-2, 62, 0, 2, 62, 2, 'grass_block')
  w.fill(-2, 63, 0, 2, 66, 2, 'air')
  w.fill(-2, 60, 5, 2, 60, 7, 'dirt') // pool bed
  w.fill(-2, 61, 3, 2, 61, 4, 'water')
  w.fill(-2, 62, 3, 2, 62, 4, 'water')
  w.fill(-2, 63, 3, 2, 66, 4, 'air')
  w.fill(-2, 62, 5, 2, 62, 5, 'grass_block') // the bridge
  w.fill(-2, 63, 5, 2, 66, 5, 'air')
  w.fill(-2, 62, 6, 2, 62, 8, 'grass_block')
  w.fill(-2, 63, 6, 2, 66, 8, 'air')
  // connect start to bridge row (z=2 -> z=5 needs land at z=2..5? bridge row is z=5)
  w.fill(-2, 62, 2, 2, 62, 5, 'grass_block')
  w.fill(-2, 63, 2, 2, 66, 5, 'air')
  const v = viewOf(w)
  const r = search({ x: 0, y: 63, z: 0 }, new GoalBlock(0, 63, 7), neighborsOf(v))
  assert.strictEqual(r.status, 'found')
  assert.ok(!r.moves.some((m) => m.type === 'swim'), 'the bridge beats swimming')
})

test('astar: falls are used when they are the cheapest route down', () => {
  const w = new VoxelWorld()
  w.fill(-2, 63, 0, 2, 63, 0, 'grass_block')
  w.fill(-2, 64, 0, 2, 68, 0, 'air')
  w.fill(-2, 60, -1, 2, 60, -1, 'grass_block')
  w.fill(-2, 61, -1, 2, 68, -1, 'air')
  w.fill(-2, 60, -2, 2, 60, -2, 'grass_block')
  w.fill(-2, 61, -2, 2, 68, -2, 'air')
  const v = viewOf(w)
  const r = search({ x: 0, y: 64, z: 0 }, new GoalBlock(0, 61, -2), neighborsOf(v))
  assert.strictEqual(r.status, 'found')
  assert.ok(r.moves.some((m) => m.type === 'fall' || m.type === 'descend'))
})
