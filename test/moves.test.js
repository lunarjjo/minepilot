'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { VoxelWorld } = require('./helpers/fake')
const { generate, digSeconds, digCost, DEFAULTS } = require('../src/engine/moves')

function viewOf (world) {
  // a view over the voxel world with null for unknown cells — the same
  // contract as a real mineflayer world (unloaded chunk -> null)
  const { WorldView } = require('../src/engine/world')
  return new WorldView((x, y, z) => world.blockAtXYZ(x, y, z))
}

function flat (size = 30) {
  const w = new VoxelWorld()
  w.ground(-size, -size, size, size, 63)
  return w
}

test('moves: flat traverse exists in all four cardinals', () => {
  const v = viewOf(flat())
  const ms = generate(v, { x: 0, y: 64, z: 0 }, DEFAULTS)
  const walks = ms.filter((m) => m.type === 'traverse')
  assert.strictEqual(walks.length, 4)
  for (const m of walks) assert.strictEqual(m.cost, 1)
  assert.ok(walks.every((m) => m.to.y === 64 && m.toBreak.length === 0))
})

test('moves: diagonal costs sqrt2 and respects the corner rule', () => {
  const w = flat()
  const v = viewOf(w)
  let ms = generate(v, { x: 0, y: 64, z: 0 }, DEFAULTS)
  assert.strictEqual(ms.filter((m) => m.type === 'diagonal').length, 4)
  assert.ok(ms.find((m) => m.type === 'diagonal').cost - Math.SQRT2 < 1e-9)

  // wall one corner: without digging, diagonals through it disappear;
  // with digging, the corner block is paid for as a break
  w.setBlock(1, 64, 0, 'stone')
  const noDig = Object.assign({}, DEFAULTS, { allowBreak: false })
  ms = generate(v, { x: 0, y: 64, z: 0 }, noDig)
  const diags = ms.filter((m) => m.type === 'diagonal')
  assert.ok(diags.every((m) => !(m.to.x === 1 && m.to.z === -1)))
  assert.ok(diags.some((m) => m.to.x === -1 && m.to.z === -1)) // far corner still open

  ms = generate(v, { x: 0, y: 64, z: 0 }, DEFAULTS)
  const cut = ms.find((m) => m.type === 'diagonal' && m.to.x === 1 && m.to.z === -1)
  assert.ok(cut, 'with digging, the corner can be cleared')
  assert.ok(cut.toBreak.some((b) => b.x === 1 && b.y === 64 && b.z === 0))
  assert.ok(cut.cost > Math.SQRT2)
})

test('moves: ascend appears when the neighbor is one higher', () => {
  const w = flat()
  w.setBlock(0, 64, -1, 'stone') // a step up to the north
  const v = viewOf(w)
  const ms = generate(v, { x: 0, y: 64, z: 0 }, DEFAULTS)
  const up = ms.find((m) => m.type === 'ascend' && m.to.x === 0 && m.to.z === -1)
  assert.ok(up, 'ascend movement should exist')
  assert.strictEqual(up.to.y, 65)
  assert.ok(up.cost >= 2)
})

test('moves: descend and fall with damage rules', () => {
  const w = new VoxelWorld()
  // a shelf world: ground strip at z=0 (floor 63, feet 64), a ledge one
  // lower at z=-1 (floor 62, feet 63), and the bottom at z=-2 (floor 60)
  w.fill(-5, 63, 0, 5, 63, 0, 'grass_block')
  w.fill(-5, 64, 0, 5, 68, 0, 'air')
  w.fill(-5, 62, -1, 5, 62, -1, 'grass_block')
  w.fill(-5, 63, -1, 5, 67, -1, 'air')
  w.fill(-5, 60, -2, 5, 60, -2, 'grass_block')
  w.fill(-5, 61, -2, 5, 67, -2, 'air')
  const v = viewOf(w)
  const s = Object.assign({}, DEFAULTS)

  const ms = generate(v, { x: 0, y: 64, z: 0 }, s)
  const desc = ms.find((m) => m.type === 'descend' && m.to.z === -1)
  assert.ok(desc, 'descend to the ledge exists')
  assert.strictEqual(desc.to.y, 63)

  // from the ledge: a 2-block drop to the bottom (no damage, allowed)
  const ms2 = generate(v, { x: 0, y: 63, z: -1 }, s)
  const fall2 = ms2.find((m) => m.type === 'fall' && m.to.z === -2)
  assert.ok(fall2, 'fall off the ledge exists')
  assert.strictEqual(fall2.to.y, 61)

  // damage guard: a 6-block drop is refused without allowFallDamage
  const w2 = new VoxelWorld()
  w2.fill(-3, 63, 0, 3, 63, 0, 'grass_block')
  w2.fill(-3, 64, 0, 3, 70, 0, 'air')
  w2.fill(-3, 63, -1, 3, 63, -1, 'grass_block') // ledge at z=-1, feet 64
  w2.fill(-3, 64, -1, 3, 70, -1, 'air')
  w2.fill(-3, 57, -2, 3, 57, -2, 'grass_block') // bottom 6 lower, feet 58
  w2.fill(-3, 58, -2, 3, 70, -2, 'air')
  const v2 = viewOf(w2)
  const fromLedge = { x: 0, y: 64, z: -1 }
  const safe = generate(v2, fromLedge, s).filter((m) => m.type === 'fall')
  assert.ok(safe.length === 0, '6-block drop rejected without damage allowed')
  const brave = Object.assign({}, DEFAULTS, { allowFallDamage: true, maxFallWithDamage: 8 })
  const risky = generate(v2, fromLedge, brave).filter((m) => m.type === 'fall')
  assert.ok(risky.length > 0, '6-block drop allowed when damage is allowed')
  assert.ok(risky[0].cost > 1)
})

test('moves: breakable walls add dig cost, or vanish when digging is off', () => {
  const w = flat()
  w.setBlock(0, 64, -1, 'dirt') // a dirt block in the way at feet level
  w.setBlock(0, 65, -1, 'air')
  const v = viewOf(w)
  const s = Object.assign({}, DEFAULTS)
  const ms = generate(v, { x: 0, y: 64, z: 0 }, s)
  const through = ms.find((m) => m.to.x === 0 && m.to.z === -1 && m.to.y === 64)
  assert.ok(through, 'movement through the wall exists (dig)')
  assert.strictEqual(through.toBreak.length, 1)
  assert.strictEqual(through.toBreak[0].name, 'dirt')
  assert.ok(through.cost > 1, 'digging costs more than walking')

  const noDig = Object.assign({}, DEFAULTS, { allowBreak: false })
  const ms2 = generate(v, { x: 0, y: 64, z: 0 }, noDig)
  assert.ok(!ms2.find((m) => m.to.x === 0 && m.to.z === -1 && m.to.y === 64))
})

test('moves: unbreakable and unknown cells are hard walls', () => {
  const w = flat()
  // a two-high bedrock wall: no walking through, no stepping over
  w.setBlock(0, 64, -1, 'bedrock')
  w.setBlock(0, 65, -1, 'bedrock')
  w.setBlock(0, 66, -1, 'air')
  let v = viewOf(w)
  const ms = generate(v, { x: 0, y: 64, z: 0 }, DEFAULTS)
  assert.ok(!ms.find((m) => m.to.x === 0 && m.to.z === -1), 'bedrock is impassable')

  // unknown (null) block: treated as impassable, never pathed into
  const w2 = new VoxelWorld()
  w2.ground(-3, 1, 3, 3, 63) // known floor only for z >= 1
  v = viewOf(w2)
  const ms2 = generate(v, { x: 0, y: 64, z: 1 }, DEFAULTS)
  assert.ok(!ms2.find((m) => m.to.z === 0 && m.to.x === 0 && m.to.y === 64), 'unknown cells are walls')
})

test('moves: water is entered by a step down and swum at a higher cost', () => {
  const w = new VoxelWorld()
  w.fill(-3, 63, 0, -1, 63, 0, 'grass_block')
  w.fill(-3, 64, 0, -1, 68, 0, 'air')
  w.fill(0, 62, 0, 5, 62, 0, 'dirt') // pond bed
  w.fill(0, 63, 0, 5, 63, 0, 'water')
  w.fill(0, 64, 0, 5, 67, 0, 'air')
  w.fill(6, 63, 0, 8, 63, 0, 'grass_block')
  w.fill(6, 64, 0, 8, 67, 0, 'air')
  const v = viewOf(w)

  // stepping in from the bank: a one block descend into the surface cell
  const ms = generate(v, { x: -1, y: 64, z: 0 }, DEFAULTS)
  const enter = ms.find((m) => m.to.x === 0 && m.to.z === 0)
  assert.ok(enter)
  assert.strictEqual(enter.to.y, 63) // feet inside the water block

  // moving through the pond: swim movements at swim cost
  const ms2 = generate(v, { x: 0, y: 63, z: 0 }, DEFAULTS)
  const swim = ms2.find((m) => m.type === 'swim' && m.to.x === 1 && m.to.z === 0)
  assert.ok(swim)
  assert.ok(swim.cost > 1)

  // climbing out the far bank
  const ms3 = generate(v, { x: 5, y: 63, z: 0 }, DEFAULTS)
  const out = ms3.find((m) => m.to.x === 6 && m.to.z === 0)
  assert.ok(out)
  assert.strictEqual(out.to.y, 64)

  // or forbidden entirely
  const dry = Object.assign({}, DEFAULTS, { allowWater: false })
  const ms4 = generate(v, { x: 0, y: 63, z: 0 }, dry)
  assert.ok(!ms4.find((m) => m.type === 'swim'))
})

test('moves: ladders climb up and down', () => {
  const w = flat()
  // a ladder hanging on a wall at z=-2, with air below it: entering it
  // from the ground must generate a climb, not a traverse
  w.setBlock(0, 63, -1, 'air') // open the floor under the ladder column
  w.setBlock(0, 62, -1, 'air')
  for (const y of [64, 65, 66]) w.setBlock(0, y, -1, 'ladder')
  w.setBlock(0, 67, -1, 'air')
  const v = viewOf(w)
  const ms = generate(v, { x: 0, y: 64, z: 0 }, DEFAULTS)
  const climb = ms.find((m) => m.type === 'climb' && m.to.x === 0 && m.to.z === -1)
  assert.ok(climb, 'entering the ladder generates a climb')
  assert.ok(climb.to.y >= 65)

  // standing inside the ladder column: straight up and down
  const ms2 = generate(v, { x: 0, y: 65, z: -1 }, DEFAULTS)
  assert.ok(ms2.find((m) => m.type === 'climb' && m.to.y === 66 && m.to.x === 0 && m.to.z === -1))
  assert.ok(ms2.find((m) => m.type === 'climb' && m.to.y === 64 && m.to.x === 0 && m.to.z === -1))
})

test('moves: parkour is generated only when opted in', () => {
  const w = new VoxelWorld()
  // a 1-gap: solid at z=0 and z=-2, hole at z=-1
  w.fill(-2, 63, 0, 2, 63, 0, 'grass_block')
  w.fill(-2, 64, 0, 2, 68, 0, 'air')
  w.fill(-2, 63, -2, 2, 63, -2, 'grass_block')
  w.fill(-2, 64, -2, 2, 68, -2, 'air')
  w.fill(-2, 60, -1, 2, 68, -1, 'air') // the gap: bottomless
  const v = viewOf(w)
  const off = generate(v, { x: 0, y: 64, z: 0 }, DEFAULTS)
  assert.ok(!off.find((m) => m.type === 'parkour'))
  const on = generate(v, { x: 0, y: 64, z: 0 }, Object.assign({}, DEFAULTS, { allowParkour: true }))
  const jump = on.find((m) => m.type === 'parkour')
  assert.ok(jump)
  assert.strictEqual(jump.to.z, -2)
  assert.strictEqual(jump.to.y, 64)
})

test('moves: pillar is on by default and can be turned off', () => {
  const w = flat()
  const v = viewOf(w)
  // default: pillar exists — the live-anchor + solid-verify placement made
  // it safe, and climbing cliffs without it is impossible
  const def = generate(v, { x: 0, y: 64, z: 0 }, Object.assign({}, DEFAULTS))
  assert.ok(def.find((m) => m.type === 'pillar'), 'pillar by default')
  const off = generate(v, { x: 0, y: 64, z: 0 }, Object.assign({}, DEFAULTS, { allowPillar: false, allowPlace: false }))
  assert.ok(!off.find((m) => m.type === 'pillar'))
  // the pillar move places into the feet cell and gains exactly one block
  const on = generate(v, { x: 0, y: 64, z: 0 }, Object.assign({}, DEFAULTS, { allowPillar: true }))
  const p = on.find((m) => m.type === 'pillar')
  assert.ok(p)
  assert.strictEqual(p.to.y, 65)
  assert.deepStrictEqual(p.toPlace, [{ x: 0, y: 64, z: 0 }])
})

test('moves: diagonal ascent climbs slopes instead of tunneling them', () => {
  const w = new VoxelWorld()
  // a 45 degree dirt slope heading north-east: floor at 63 under (0,0),
  // the diagonal cell (1,-1) has its support at y=64 (one higher)
  w.fill(-2, 62, -2, 2, 62, 2, 'grass_block')
  w.setBlock(0, 63, 0, 'grass_block') // under our feet: feet at 64
  w.setBlock(1, 64, -1, 'grass_block') // the step up, diagonal NE
  w.fill(-2, 64, -2, 2, 70, 2, 'air')
  w.setBlock(0, 63, 0, 'grass_block')
  w.setBlock(1, 64, -1, 'grass_block')
  const v = viewOf(w)
  const s = Object.assign({}, DEFAULTS)
  const ms = generate(v, { x: 0, y: 64, z: 0 }, s)
  const up = ms.find((m) => m.type === 'diagonal' && m.to.x === 1 && m.to.z === -1)
  assert.ok(up, 'diagonal ascent to the step exists')
  assert.strictEqual(up.to.y, 65)
  assert.ok(!up.toBreak.some((b) => b.x === 1 && b.y === 64 && b.z === -1),
    'the support block itself is never broken')
  // opting out: no diagonal ascent
  const no = generate(v, { x: 0, y: 64, z: 0 }, Object.assign({}, DEFAULTS, { allowDiagonalAscend: false }))
  assert.ok(!no.find((m) => m.type === 'diagonal' && m.to.x === 1 && m.to.z === -1 && m.to.y === 65))
})

test('moves: ascendPlace staircases up a ledge with no support', () => {
  const w = new VoxelWorld()
  // we stand on a floor at 63 (feet 64). ahead east the ground breaks:
  // a shelf sits at (1,63) but the step above it is missing — no support
  // at (1,64), so the only way up is placing a block there and stepping
  // onto it (the shelf below doubles as the placement anchor)
  w.fill(-3, 63, -1, 0, 63, 1, 'grass_block')
  w.fill(-3, 64, -1, 0, 69, 1, 'air')
  w.setBlock(1, 63, 0, 'grass_block') // shelf — anchor, not support
  w.fill(1, 64, -1, 4, 69, 1, 'air')
  const v = viewOf(w)
  const ms = generate(v, { x: 0, y: 64, z: 0 }, DEFAULTS)
  const stair = ms.find((m) => m.type === 'ascendPlace' && m.to.x === 1 && m.to.z === 0)
  assert.ok(stair, 'ascendPlace movement exists')
  assert.strictEqual(stair.to.y, 65)
  assert.deepStrictEqual(stair.toPlace, [{ x: 1, y: 64, z: 0 }])
  // without placing, the move is not offered
  const noPlace = generate(v, { x: 0, y: 64, z: 0 }, Object.assign({}, DEFAULTS, { allowPlace: false }))
  assert.ok(!noPlace.find((m) => m.type === 'ascendPlace'))
})

test('moves: a drop too deep bridges down instead of falling', () => {
  const w = new VoxelWorld()
  // shelf at feet 64 ending at x=0; the floor ahead sits 7 lower (a lethal
  // drop without fall damage), so the bridge staircase is the only route
  w.fill(-3, 63, -1, 0, 63, 1, 'grass_block')
  w.fill(-3, 64, -1, 0, 70, 1, 'air')
  w.fill(1, 56, -1, 6, 56, 1, 'grass_block')
  w.fill(1, 57, -1, 6, 70, 1, 'air')
  const v = viewOf(w)
  const ms = generate(v, { x: 0, y: 64, z: 0 }, DEFAULTS)
  const bridge = ms.find((m) => m.type === 'bridge' && m.to.x === 1 && m.to.z === 0)
  assert.ok(bridge, 'bridge move exists over the lethal drop')
  assert.strictEqual(bridge.to.y, 64)
  assert.ok(bridge.toPlace.length === 1)
  // no plain fall may be offered at the same time
  assert.ok(!ms.find((m) => m.type === 'fall' && m.to.x === 1 && m.to.z === 0))
})

test('moves: dig cost follows the carried tools, not bare hands', () => {
  const s = Object.assign({}, DEFAULTS, {
    toolMults: { pickaxe: 6, axe: 1, shovel: 1, hoe: 1 }
  })
  const stone = { name: 'stone', hardness: 1.5 }
  const hand = digCost(stone, Object.assign({}, DEFAULTS))
  const pick = digCost(stone, s)
  assert.ok(pick < hand / 4, 'an iron pickaxe slashes stone dig cost')
  // oak log (axe class): the pickaxe mults do not help
  const log = { name: 'oak_log', hardness: 2 }
  assert.ok(digCost(log, s) === digCost(log, Object.assign({}, DEFAULTS)), 'unrelated tool classes are untouched')
})

test('moves: bridge appears over bottomless gaps when placing is allowed', () => {
  const w = new VoxelWorld()
  // a shelf ending at x=0 (feet 64); ahead of it: known air over nothing
  w.fill(-3, 63, -2, 0, 63, 2, 'grass_block')
  w.fill(-3, 64, -2, 0, 68, 2, 'air')
  w.fill(1, 64, -2, 3, 68, 2, 'air') // the gap is KNOWN air (not fog)
  const v = viewOf(w)
  const s = DEFAULTS // allowPlace defaults true now
  const ms = generate(v, { x: 0, y: 64, z: 0 }, s)
  const bridge = ms.find((m) => m.type === 'bridge' && m.to.x === 1)
  assert.ok(bridge, 'bridge movement exists toward the known gap')
  assert.strictEqual(bridge.to.y, 64)
  assert.deepStrictEqual(bridge.toPlace, [{
    x: 1, y: 63, z: 0, ref: { x: 0, y: 63, z: 0 }, face: { x: 1, y: 0, z: 0 }
  }])
  assert.ok(bridge.cost > 1, 'placing costs more than walking')

  // without allowPlace there is no bridge
  const noPlace = Object.assign({}, DEFAULTS, { allowPlace: false })
  assert.ok(!generate(v, { x: 0, y: 64, z: 0 }, noPlace).some((m) => m.type === 'bridge'))

  // when the far side has ground it is a traverse, not a bridge
  w.fill(1, 63, -2, 3, 63, 2, 'grass_block')
  const ms2 = generate(v, { x: 0, y: 64, z: 0 }, s)
  assert.ok(!ms2.some((m) => m.type === 'bridge'), 'landing exists -> no bridge')

  // over lava (known, deadly, no landing) the bridge is the way across
  const w2 = new VoxelWorld()
  w2.fill(-3, 63, -2, 0, 63, 2, 'grass_block')
  w2.fill(-3, 64, -2, 0, 68, 2, 'air')
  w2.fill(1, 55, -2, 3, 63, 2, 'lava')
  w2.fill(1, 64, -2, 3, 68, 2, 'air')
  const v2 = viewOf(w2)
  const over = generate(v2, { x: 0, y: 64, z: 0 }, s).find((m) => m.type === 'bridge')
  assert.ok(over, 'bridge spans a lava channel')
})

test('moves: dig cost follows the hand-dig formula', () => {
  assert.strictEqual(digSeconds(0.5), 0.75) // dirt-like
  assert.strictEqual(digSeconds(1.5), 7.5) // stone-like, tool-gated
  assert.strictEqual(digSeconds(-1), Infinity) // unbreakable
})

test('moves: fall into deep water is allowed and lands in the water', () => {
  const w = new VoxelWorld()
  w.fill(-2, 63, 0, 2, 63, 0, 'grass_block')
  w.fill(-2, 64, 0, 2, 68, 0, 'air')
  // a loaded pool: air above the surface, water below, dirt at the bottom
  w.fill(-2, 51, -1, 2, 68, -1, 'air')
  w.fill(-2, 40, -1, 2, 50, -1, 'water')
  w.fill(-2, 39, -1, 2, 39, -1, 'dirt')
  const v = viewOf(w)
  const ms = generate(v, { x: 0, y: 64, z: 0 }, DEFAULTS)
  const fall = ms.find((m) => m.type === 'fall' && m.to.z === -1)
  assert.ok(fall, 'water landing exists')
  assert.strictEqual(fall.to.y, 50) // feet inside the top water block
  assert.ok(fall.cost < 5, 'a cushioned drop is cheap')
})
