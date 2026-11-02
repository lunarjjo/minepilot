'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { VoxelWorld } = require('./helpers/fake')
const { search, searchAsync } = require('../src/engine/astar')
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

function island (half = 30) {
  const w = new VoxelWorld()
  w.ground(-half, -half, half, half, 63)
  return w
}

function neighborsOf (v) {
  return (n) => generate(v, n, DEFAULTS)
}

test('astar async: parity with the synchronous search on flat ground', async () => {
  const v = viewOf(flat())
  const goal = new GoalXZ(5, 0)
  const n = neighborsOf(v)
  const start = { x: 0, y: 64, z: 0 }
  const sync = search(start, goal, n)
  const sliced = await searchAsync(start, goal, n, { sliceNodes: 7 })
  assert.strictEqual(sliced.status, sync.status)
  assert.strictEqual(sliced.moves.length, sync.moves.length)
  assert.strictEqual(sliced.cost, sync.cost)
  assert.strictEqual(sliced.expanded, sync.expanded)
  assert.deepStrictEqual(sliced.nodes, sync.nodes)
  assert.deepStrictEqual(sliced.moves, sync.moves)
})

test('astar async: parity on a dig-through plan', async () => {
  const w = flat()
  for (let z = -10; z <= 10; z++) {
    for (let y = 64; y <= 67; y++) w.setBlock(1, y, z, 'dirt')
  }
  const v = viewOf(w)
  const goal = new GoalBlock(4, 64, 0)
  const n = neighborsOf(v)
  const start = { x: 0, y: 64, z: 0 }
  const sync = search(start, goal, n)
  const sliced = await searchAsync(start, goal, n, { sliceNodes: 3 })
  assert.strictEqual(sync.status, 'found')
  assert.strictEqual(sliced.status, 'found')
  assert.strictEqual(sliced.cost, sync.cost)
  assert.strictEqual(sliced.expanded, sync.expanded)
  assert.deepStrictEqual(sliced.moves, sync.moves)
})

test('astar async: finds the goal when it is reachable', async () => {
  const v = viewOf(flat())
  const r = await searchAsync({ x: 0, y: 64, z: 0 }, new GoalNear(3, 64, 3, 1), neighborsOf(v), { sliceNodes: 7 })
  assert.strictEqual(r.status, 'found')
  assert.ok(r.moves.length > 0)
  const last = r.moves[r.moves.length - 1].to
  assert.ok(Math.abs(last.x - 3) <= 1 && Math.abs(last.z - 3) <= 1)
})

test('astar async: the event loop stays live while a long search runs', async () => {
  const v = viewOf(island(30))
  const goal = new GoalXZ(100, 0) // unreachable — the whole island gets expanded
  let ticks = 0
  const timer = setInterval(() => ticks++, 5)
  const r = await searchAsync({ x: 0, y: 64, z: 0 }, goal, neighborsOf(v), { sliceNodes: 50 })
  clearInterval(timer)
  assert.strictEqual(r.status, 'partial')
  assert.ok(r.expanded > 500, `the search actually ran long (${r.expanded} expanded)`)
  assert.ok(ticks >= 20, `the loop ticked mid-search (${ticks} times)`)
})

test('astar async: alive() aborts a superseded search without a partial', async () => {
  const v = viewOf(island(30))
  const goal = new GoalXZ(100, 0)
  let calls = 0
  const r = await searchAsync({ x: 0, y: 64, z: 0 }, goal, neighborsOf(v), {
    sliceNodes: 50,
    alive: () => (calls++) < 2
  })
  assert.strictEqual(r.status, 'aborted')
  assert.strictEqual(r.partial, false)
  assert.ok(r.expanded > 0)
})

test('astar async: unreachable far goal still degrades to the best partial', async () => {
  const v = viewOf(island(2))
  const r = await searchAsync({ x: 0, y: 64, z: 0 }, new GoalXZ(30, 0), neighborsOf(v), { sliceNodes: 7 })
  assert.strictEqual(r.status, 'partial')
  assert.ok(r.moves.length > 0)
  const end = r.moves[r.moves.length - 1].to
  assert.strictEqual(end.x, 2, 'walked to the last known block east')
})

test('astar async: timeout parity — both entries report the identical timeout', async () => {
  const v = viewOf(flat())
  const goal = new GoalXZ(30, 0)
  const n = neighborsOf(v)
  const start = { x: 0, y: 64, z: 0 }

  // a controllable clock: the FIRST read seeds t0, every later read sits
  // 100ms in the future — the timeout probe fires on the very first loop
  // pass (expanded === 0) in both entry points. that pins the timeout path
  // deterministically instead of racing a wall clock against a fixture
  const withFakeClock = (fn) => {
    const realNow = Date.now
    let calls = 0
    Date.now = () => (calls++ === 0 ? realNow() : realNow() + 100)
    try { return fn() } finally { Date.now = realNow }
  }

  const sync = withFakeClock(() => search(start, goal, n, { timeoutMs: 10 }))
  const sliced = await withFakeClock(() => searchAsync(start, goal, n, { timeoutMs: 10, sliceNodes: 7 }))

  assert.strictEqual(sync.status, 'timeout')
  assert.strictEqual(sync.expanded, 0, 'the clock fired before the first expansion')
  assert.strictEqual(sync.partial, true, 'a timeout is reported as partial')
  assert.deepStrictEqual(sliced, sync, 'async timeout is byte-identical to the sync oracle')
})
