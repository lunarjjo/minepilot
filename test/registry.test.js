'use strict'

// the minepilot layer over the ported engine: the new baritone goal
// types, the settings registry, and the world rule set (block
// avoidance / break vetoes / break penalties).

const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')

const {
  GoalBlock, GoalNear, GoalXZ, GoalTwoBlocks, GoalAxis,
  GoalStrictDirection, GoalGetToBlock, GoalComposite, GoalCompositeAnd,
  SPRINT_FACTOR
} = require('../src/engine/goals')
const { createDefaultSettings } = require('../src/settings')
const { WorldView, rulesFromSettings } = require('../src/engine/world')
const { generate, DEFAULTS } = require('../src/engine/moves')
const { search } = require('../src/engine/astar')
const { VoxelWorld } = require('./helpers/fake')

// ---------------------------------------------------------------- goals

test('goal twoblocks: feet or head level both satisfy', () => {
  const g = new GoalTwoBlocks(10, 65, 10)
  assert.strictEqual(g.isMet(10, 65, 10), true) // feet in the cell
  assert.strictEqual(g.isMet(10, 64, 10), true) // head in the cell
  assert.strictEqual(g.isMet(10, 66, 10), false)
  assert.strictEqual(g.isMet(11, 65, 10), false)
  // heuristic is a lower bound at both levels
  assert.ok(g.heuristic(10, 65, 10) === 0)
  assert.ok(g.heuristic(10, 64, 10) === 0)
  assert.ok(g.heuristic(14, 64, 14) >= 0)
})

test('goal axis: nearest axis line satisfies, any y unless pinned', () => {
  const g = new GoalAxis()
  assert.strictEqual(g.isMet(0, 70, 12), true)
  assert.strictEqual(g.isMet(12, 70, 0), true)
  assert.strictEqual(g.isMet(12, 70, 12), false)
  const gy = new GoalAxis(64)
  assert.strictEqual(gy.isMet(0, 64, 12), true)
  assert.strictEqual(gy.isMet(0, 70, 12), false)
  // heuristic: min(|x|,|z|) is admissible, sprint-priced
  assert.strictEqual(g.heuristic(5, 64, 9), 5 * SPRINT_FACTOR)
})

test('goal strict direction: past the origin along the ray', () => {
  const east = new GoalStrictDirection(0, null, 0, { x: 1, z: 0 })
  assert.strictEqual(east.isMet(5, 64, 0), true)
  assert.strictEqual(east.isMet(5, 64, 1), false) // a block off the line
  assert.strictEqual(east.isMet(-1, 64, 0), false) // behind the origin
  const diag = new GoalStrictDirection(0, null, 0, { x: 1, z: 1 })
  assert.strictEqual(diag.isMet(4, 64, 4), true)
  assert.strictEqual(diag.isMet(4, 64, 5), false)
})

test('goal get to block: baritone adjacency semantics', () => {
  const g = new GoalGetToBlock(0, 64, 0)
  assert.strictEqual(g.isMet(1, 64, 0), true) // feet beside it
  assert.strictEqual(g.isMet(1, 63, 0), true) // one below, head beside it
  assert.strictEqual(g.isMet(2, 64, 0), false)
  assert.strictEqual(g.isMet(1, 65, 0), false) // above it: |dy| counts fully
  assert.strictEqual(g.heuristic(1, 64, 0), 1 * SPRINT_FACTOR)
  assert.strictEqual(g.heuristic(1, 63, 0), 1 * SPRINT_FACTOR)
})

test('goal composite and: every sub-goal must be met', () => {
  const g = new GoalCompositeAnd(new GoalXZ(0, 0), new GoalXZ(10, 10))
  assert.strictEqual(g.isMet(0, 64, 0), false)
  // an impossible and-goal never lies about being met
  const near = new GoalCompositeAnd(new GoalNear(0, 64, 0, 1))
  assert.strictEqual(near.isMet(0, 64, 0), true)
  // the heuristic is the max of the sub-heuristics (the farther goal
  // dominates; the sum could overestimate)
  assert.strictEqual(g.heuristic(0, 64, 0), 10 * Math.SQRT2 * SPRINT_FACTOR)
})

test('goal composite or: still the any() semantics', () => {
  const g = new GoalComposite(new GoalXZ(0, 0), new GoalXZ(10, 10))
  assert.strictEqual(g.isMet(0, 64, 0), true)
  assert.strictEqual(g.heuristic(0, 64, 0), 0)
  assert.strictEqual(g.heuristic(5, 64, 5), 5 * Math.SQRT2 * SPRINT_FACTOR)
})

// ------------------------------------------------------------- settings

test('settings: defaults, get and typed set', () => {
  const s = createDefaultSettings()
  assert.strictEqual(s.get('allowBreak'), true)
  assert.strictEqual(s.get('maxNodes'), 150000)
  assert.ok(Array.isArray(s.get('blocksToDisallowBreaking')))
  assert.ok(s.get('blocksToDisallowBreaking').includes('chest'))

  assert.strictEqual(s.set('allowBreak', 'false').ok, true)
  assert.strictEqual(s.get('allowBreak'), false)
  assert.strictEqual(s.set('maxNodes', 'x').ok, false)
  assert.strictEqual(s.set('maxNodes', 900000000).ok, false) // over the cap
  assert.strictEqual(s.set('nope', 1).ok, false) // unknown key with suggestion
  assert.ok(s.set('nope', 1).error.includes('unknown setting'))
})

test('settings: list types parse comma separated names', () => {
  const s = createDefaultSettings()
  const r = s.set('blocksToAvoid', 'magma_block, honey_block, magma_block')
  assert.strictEqual(r.ok, true)
  assert.deepStrictEqual(s.get('blocksToAvoid'), ['magma_block', 'honey_block'])
  assert.strictEqual(s.set('blocksToAvoid', 'not a name!').ok, false)
  assert.strictEqual(s.set('blocksToAvoid', 'none').ok, true)
  assert.deepStrictEqual(s.get('blocksToAvoid'), [])
})

test('settings: map type parses a=b pairs and merges', () => {
  const s = createDefaultSettings()
  const r = s.set('buildSubstitutes', 'oak_planks=spruce_planks, oak_planks=birch_planks')
  assert.strictEqual(r.ok, true)
  assert.deepStrictEqual(s.get('buildSubstitutes').oak_planks, ['spruce_planks', 'birch_planks'])
})

test('settings: modified tracking, reset and snapshots', () => {
  const s = createDefaultSettings()
  s.set('allowParkour', true)
  s.set('mineScanRadius', 96)
  const mods = s.modifiedList().map((m) => m.key).sort()
  assert.deepStrictEqual(mods, ['allowParkour', 'mineScanRadius'])
  const snap = s.snapshot()
  assert.deepStrictEqual(Object.keys(snap).sort(), ['allowParkour', 'mineScanRadius'])
  assert.strictEqual(s.reset('allowParkour').ok, true)
  assert.strictEqual(s.get('allowParkour'), false) // back to default
  const s2 = createDefaultSettings()
  s2.applySnapshot(snap)
  assert.strictEqual(s2.get('mineScanRadius'), 96)
  assert.strictEqual(s.reset(null).ok, true)
  assert.strictEqual(s.modifiedList().length, 0)
})

test('settings: categories cover every defined key', () => {
  const s = createDefaultSettings()
  const total = s.list().length
  const byCat = s.categories().reduce((a, c) => a + c.count, 0)
  assert.strictEqual(total, byCat)
  assert.ok(total >= 60, `a full registry (${total} settings)`)
})

// ------------------------------------------------------------ world rules

function viewOf (world, rules) {
  return new WorldView((x, y, z) => world.blockAtXYZ(x, y, z), {
    registry: world.registry,
    rules: rules || null
  })
}

test('rules: blocksToAvoid never counts as support', () => {
  const w = new VoxelWorld()
  w.ground(-2, -2, 2, 2, 63)
  w.setBlock(0, 63, 1, 'magma_block')
  const plain = viewOf(w)
  assert.strictEqual(plain.standable(0, 63, 1), true)
  const s = createDefaultSettings()
  s.set('blocksToAvoid', 'magma_block')
  const guarded = viewOf(w, rulesFromSettings(s))
  assert.strictEqual(guarded.standable(0, 63, 1), false)
})

test('rules: blocksToDisallowBreaking vetoes the dig', () => {
  const w = new VoxelWorld()
  w.ground(-2, -2, 2, 2, 63)
  w.setBlock(1, 64, 0, 'chest')
  const s = createDefaultSettings()
  s.set('blocksToDisallowBreaking', 'chest')
  const v = viewOf(w, rulesFromSettings(s))
  assert.strictEqual(v.breakInfo(1, 64, 0).breakable, false)
  // unless allowBreakAnyway speaks up
  s.set('allowBreakAnyway', 'chest')
  assert.strictEqual(viewOf(w, rulesFromSettings(s)).breakInfo(1, 64, 0).breakable, true)
})

test('rules: blocksToAvoidBreaking is priced, not vetoed', () => {
  const w = new VoxelWorld()
  w.ground(-2, -2, 2, 2, 63)
  w.setBlock(1, 64, 0, 'diamond_ore')
  const s = createDefaultSettings()
  const v = viewOf(w, rulesFromSettings(s))
  const info = v.breakInfo(1, 64, 0)
  assert.strictEqual(info.breakable, true)
  assert.strictEqual(info.avoided, true)
  assert.ok(info.avoidMultiplier > 0)
  // the move exists but carries the extra penalty
  const moves = generate(v, { x: 0, y: 64, z: 0 }, Object.assign({}, DEFAULTS))
  const traverse = moves.find((m) => m.type === 'traverse' && m.to.x === 1)
  assert.ok(traverse)
  assert.ok(traverse.toBreak.some((b) => b.avoided))
})

test('rules: chest walls route around when digging is the only other option', () => {
  const w = new VoxelWorld()
  w.ground(-3, -3, 3, 3, 63)
  for (let y = 64; y <= 67; y++) w.setBlock(1, y, 0, 'chest')
  const s = createDefaultSettings()
  const v = viewOf(w, rulesFromSettings(s))
  const r = search({ x: 0, y: 64, z: 0 }, new GoalBlock(3, 64, 0),
    (n) => generate(v, n, Object.assign({}, DEFAULTS)), { maxNodes: 50000 })
  assert.strictEqual(r.status, 'found')
  assert.strictEqual(r.moves.some((m) => m.toBreak.some((b) => b.name === 'chest')), false,
    'the plan never digs the chest')
})
