'use strict'

// the command executor and the managers behind it, offline.

const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')

const { executeCommand, hostileName } = require('../src/commandexec')
const { createDefaultSettings } = require('../src/settings')
const { Autopilot } = require('../src/autopilot')
const { WaypointStore } = require('../src/waypoints')
const { SelectionManager, normCuboid, cellsOf } = require('../src/selection')
const { sliceCells, facingCardinal } = require('../src/processes/tunnel')
const { remaining } = require('../src/processes/excavate')
const { findTarget } = require('../src/processes/combat')
const { FakeBot, VoxelWorld } = require('./helpers/fake')
const fs = require('fs')
const path = require('path')
const os = require('os')

function makeCtx (worldBuilder) {
  const world = worldBuilder()
  const bot = new FakeBot({ username: 'PilotBot', version: '1.21.4' }, world)
  bot.spawnAt(0, 64, 0)
  const settings = createDefaultSettings()
  const pilot = new Autopilot({ bot, deps: { Vec3 }, settings })
  const selection = new SelectionManager()
  const waypoints = new WaypointStore(path.join(os.tmpdir(), 'minepilot-wp-test-' + Date.now() + '.json'))
  const lines = []
  const ctx = {
    pilot, bot, settings, selection, waypoints,
    reply: (t) => lines.push(t),
    source: 'console',
    commander: null
  }
  return { ctx, lines, bot, pilot, world }
}

function flatWorld () {
  const w = new VoxelWorld()
  w.fill(-10, 58, -10, 10, 63, 10, 'grass_block')
  w.fill(-10, 64, -10, 10, 70, 10, 'air')
  return w
}

// ------------------------------------------------------------ dispatcher

test('exec: help lists the command set', async () => {
  const { ctx, lines } = makeCtx(flatWorld)
  await executeCommand('help', ctx)
  assert.ok(lines.some((l) => l.includes('goto')), 'help mentions goto')
  assert.ok(lines.length > 40, 'the full list is long')
})

test('exec: set/get settings through the dispatcher', async () => {
  const { ctx, lines } = makeCtx(flatWorld)
  await executeCommand('set allowParkour true', ctx)
  assert.ok(lines.at(-1).includes('allowParkour'))
  assert.strictEqual(ctx.settings.get('allowParkour'), true)
  const s = ctx.pilot.s
  assert.strictEqual(s.allowParkour, true, 'engine settings synced')
  await executeCommand('set allowParkour', ctx)
  assert.ok(lines.at(-1).includes('sprint-jump'), 'show includes the description')
  await executeCommand('set nope 1', ctx)
  assert.ok(lines.at(-1).includes('unknown setting'))
  await executeCommand('reset allowParkour', ctx)
  assert.strictEqual(ctx.settings.get('allowParkour'), false)
})

test('exec: where and status report position', async () => {
  const { ctx, lines } = makeCtx(flatWorld)
  await executeCommand('where', ctx)
  assert.ok(lines.at(-1).includes('0 64 0'))
  await executeCommand('status', ctx)
  assert.ok(lines.some((l) => l.includes('pos 0 64 0')))
})

test('exec: goto with relative coordinates resolves against the feet', async () => {
  const { ctx, pilot } = makeCtx(flatWorld)
  await executeCommand('goto ~ ~ ~', ctx)
  // goal already met: (0,64,0) — launch reports it
  assert.strictEqual(pilot.goal.label(), 'block 0 64 0')
  await executeCommand('goto ~5 ~ ~-3', ctx)
  assert.strictEqual(pilot.goal.label(), 'block 5 64 -3')
})

test('exec: goal sets without moving, path then walks', async () => {
  const { ctx, pilot } = makeCtx(flatWorld)
  await executeCommand('goal 4 64 4', ctx)
  assert.ok(pilot.goal)
  assert.strictEqual(pilot.task, 'idle', 'goal alone does not move')
  const r = await executeCommand('path', ctx)
  assert.strictEqual(r.ok, true)
  assert.strictEqual(pilot.task, 'goto')
})

test('exec: damn daniel answers properly', async () => {
  const { ctx, lines } = makeCtx(flatWorld)
  await executeCommand('damn daniel', ctx)
  assert.ok(lines.at(-1).includes('white vans'))
})

test('exec: version reports minepilot + minecraft', async () => {
  const { ctx, lines } = makeCtx(flatWorld)
  await executeCommand('version', ctx)
  assert.ok(lines.at(-1).includes('minepilot'))
  assert.ok(lines.at(-1).includes('1.21.4'))
})

// ------------------------------------------------------------- waypoints

test('waypoints: save, resolve by name and tag, delete, persist', async () => {
  const file = path.join(os.tmpdir(), 'minepilot-wp-' + Date.now() + '.json')
  const wp = new WaypointStore(file)
  wp.saveWaypoint('user', 'coolbiome', { x: 10, y: 64, z: -20 })
  wp.saveWaypoint('home', 'base', { x: 0, y: 64, z: 0 })
  wp.bed({ x: 5, y: 64, z: 5 })
  assert.strictEqual(wp.list().length, 3)
  assert.strictEqual(wp.resolve('coolbiome').kind, 'name')
  assert.strictEqual(wp.resolve('home').kind, 'tag')
  assert.strictEqual(wp.resolve('home').list.length, 2, 'base + bed under the home tag')
  assert.strictEqual(wp.resolve('nothing'), null)
  wp.save()
  const wp2 = new WaypointStore(file)
  assert.strictEqual(wp2.list().length, 3, 'persisted to disk')
  assert.strictEqual(wp2.delete('home').deleted, 2)
  assert.strictEqual(wp2.list().length, 1)
  wp2.clear()
  assert.strictEqual(wp2.list().length, 0)
})

test('exec: wp save + wp goal via the dispatcher', async () => {
  const { ctx, pilot } = makeCtx(flatWorld)
  await executeCommand('wp save user base', ctx)
  assert.strictEqual(ctx.waypoints.list().length, 1)
  await executeCommand('wp goal base', ctx)
  assert.ok(pilot.goal)
  assert.strictEqual(pilot.goal.label(), 'block 0 64 0')
  await executeCommand('home', ctx) // goal home: resolves the tag
  assert.ok(pilot.goal)
})

// ------------------------------------------------------------- selection

test('selection: pos1/pos2, undo, volume and transforms', () => {
  const sel = new SelectionManager()
  assert.strictEqual(sel.hasSelection(), false)
  sel.setPos1({ x: 0, y: 60, z: 0 })
  sel.setPos2({ x: 9, y: 64, z: 9 })
  assert.strictEqual(sel.volume(), 10 * 5 * 10)
  sel.transform('expand', 2, 'east')
  const c = sel.cuboid()
  assert.strictEqual(c.maxX, 11)
  sel.transform('contract', 1, 'up')
  assert.strictEqual(sel.cuboid().maxY, 63)
  sel.undo()
  assert.strictEqual(sel.cuboid().maxY, 64)
  sel.undo()
  assert.strictEqual(sel.cuboid().maxX, 9)
  sel.clear()
  assert.strictEqual(sel.hasSelection(), false)
})

test('selection: shape blueprints cover the cuboid correctly', () => {
  const sel = new SelectionManager()
  sel.setPos1({ x: 0, y: 60, z: 0 })
  sel.setPos2({ x: 3, y: 62, z: 3 })
  // the cuboid is 4 x 3 x 4 = 48 cells
  const fill = sel.fillBlueprint('dirt')
  assert.strictEqual(fill.blueprint.placements.length, 48)
  const walls = sel.wallsBlueprint('stone')
  assert.strictEqual(walls.blueprint.placements.length, 48 - 2 * 3 * 2, '48 minus the 2x3x2 interior')
  const shell = sel.shellBlueprint('glass')
  assert.strictEqual(shell.blueprint.placements.length, 48 - 2 * 1 * 2, 'same interior removed')
  const sphere = sel.sphereBlueprint('glass', 3, false)
  assert.ok(sphere.blueprint.placements.length > 100)
  const hsphere = sel.sphereBlueprint('glass', 3, true)
  assert.ok(hsphere.blueprint.placements.length < sphere.blueprint.placements.length)
  const cyl = sel.cylinderBlueprint('stone', 3, 2, false)
  assert.ok(cyl.blueprint.placements.length > 20)
})

test('selection: copy snapshots the world into a blueprint', () => {
  const sel = new SelectionManager()
  const w = new VoxelWorld()
  w.fill(0, 63, 0, 2, 63, 2, 'stone')
  sel.setPos1({ x: 0, y: 63, z: 0 })
  sel.setPos2({ x: 2, y: 63, z: 2 })
  const r = sel.copy({
    name: (x, y, z) => (w.blockAtXYZ(x, y, z) ? w.blockAtXYZ(x, y, z).name : null)
  })
  assert.strictEqual(r.cells, 9)
  assert.strictEqual(sel.clipboard.placements.filter((p) => p.block === 'stone').length, 9)
})

test('exec: sel pos1/pos2 through the dispatcher', async () => {
  const { ctx } = makeCtx(flatWorld)
  const selection = ctx.selection
  await executeCommand('sel pos1 0 64 0', ctx)
  await executeCommand('s p2 4 64 4', ctx)
  assert.strictEqual(selection.volume(), 25)
  await executeCommand('sel expand 2 east', ctx)
  assert.strictEqual(selection.cuboid().maxX, 6)
})

// ------------------------------------------------------------- tunnel math

test('tunnel: slice cells form the right cross-section', () => {
  // facing east (dx=1, dz=0), 2 high x 1 wide at depth 1
  const slice = sliceCells(0, 64, 0, 1, 0, 1, 2, 1)
  assert.deepStrictEqual(slice.map((c) => [c.x, c.y, c.z]).sort(),
    [[1, 64, 0], [1, 65, 0]].sort())
  // 3 wide: perpendicular is z when facing east
  const wide = sliceCells(0, 64, 0, 1, 0, 1, 2, 3)
  assert.strictEqual(wide.length, 6)
  assert.ok(wide.some((c) => c.z === -1) && wide.some((c) => c.z === 1))
  // facing south (dz=1): perpendicular is x
  const south = sliceCells(0, 64, 0, 0, 1, 1, 1, 3)
  assert.ok(south.some((c) => c.x === -1) && south.some((c) => c.x === 1))
})

test('tunnel: facing cardinal snaps yaw to a direction', () => {
  const world = flatWorld()
  const bot = new FakeBot({ username: 'T', version: '1.21.4' }, world)
  bot.spawnAt(0, 64, 0)
  // mineflayer yaw 0 = north (-z)
  bot.entity.yaw = 0
  assert.deepStrictEqual(facingCardinal({ bot }), { dx: 0, dz: -1 })
  bot.entity.yaw = Math.PI // south
  assert.deepStrictEqual(facingCardinal({ bot }), { dx: 0, dz: 1 })
  bot.entity.yaw = -Math.PI / 2 // east (+x): facing = (-sin,-cos) = (1, 0)
  assert.deepStrictEqual(facingCardinal({ bot }), { dx: 1, dz: 0 })
  bot.disposePhysics()
})

// ------------------------------------------------------------- excavate

test('excavate: remaining counts breakable non-air cells', () => {
  const world = flatWorld()
  world.setBlock(2, 64, 2, 'stone')
  world.setBlock(2, 65, 2, 'bedrock')
  const { ctx } = makeCtx(() => world)
  const cells = remaining(ctx.pilot, normCuboid({ x: -5, y: 63, z: -5 }, { x: 5, y: 66, z: 5 }))
  const names = cells.map((c) => c.name)
  assert.ok(names.includes('grass_block'))
  assert.ok(!names.includes('bedrock'), 'bedrock refuses')
  assert.ok(!names.includes('air'))
})

test('exec: excavate digs a small cuboid to air', { timeout: 60000 }, async () => {
  const w = flatWorld()
  w.setBlock(1, 63, 0, 'stone')
  w.setBlock(2, 63, 0, 'stone')
  w.setBlock(3, 63, 0, 'stone')
  const { ctx, bot } = makeCtx(() => w)
  const r = await executeCommand('excavate 1 63 0 3 63 0', ctx)
  assert.strictEqual(r.ok, true)
  // wait for the job to finish
  for (let i = 0; i < 100 && ctx.pilot.task !== 'idle'; i++) {
    await new Promise((res) => setTimeout(res, 200))
  }
  assert.strictEqual(w.blockAtXYZ(1, 63, 0).name, 'air')
  assert.strictEqual(w.blockAtXYZ(2, 63, 0).name, 'air')
  assert.strictEqual(w.blockAtXYZ(3, 63, 0).name, 'air')
  bot.disposePhysics()
})

// ------------------------------------------------------------- combat

test('combat: hostile classification and target finding', () => {
  assert.strictEqual(hostileName({ name: 'zombie' }), 'zombie')
  assert.strictEqual(hostileName({ name: 'cow' }), null)
  const world = flatWorld()
  const bot = new FakeBot({ username: 'T', version: '1.21.4' }, world)
  bot.spawnAt(0, 64, 0)
  bot.entities[1] = { name: 'zombie', position: new Vec3(3, 64, 3) }
  bot.entities[2] = { name: 'cow', position: new Vec3(1, 64, 1) }
  const settings = createDefaultSettings()
  const pilot = new Autopilot({ bot, deps: { Vec3 }, settings })
  const target = findTarget(pilot, 'zombie')
  assert.ok(target)
  assert.strictEqual(target.name, 'zombie')
  assert.strictEqual(findTarget(pilot, 'creeper'), null)
  bot.disposePhysics()
})

// ------------------------------------------------------------- inventory

test('inventory: drop modes choose the right stacks', async () => {
  const inv = require('../src/inventory')
  const world = flatWorld()
  const bot = new FakeBot({ username: 'T', version: '1.21.4' }, world)
  bot.spawnAt(0, 64, 0)
  bot.tossed = []
  bot.tossStack = async (item) => { bot.tossed.push(item.name); return true }
  bot.setInventory([
    { name: 'cobblestone', count: 64 },
    { name: 'diamond', count: 5 },
    { name: 'dirt', count: 32 }
  ])
  const r = await inv.drop(bot, { mode: 'stack' })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(bot.tossed[0], 'cobblestone', 'throwaways first')
  const r2 = await inv.drop(bot, { mode: 'item', item: 'diamond' })
  assert.strictEqual(r2.ok, true)
  assert.strictEqual(bot.tossed[1], 'diamond')
  bot.disposePhysics()
})

test('inventory: best food prefers low-quality decent food', () => {
  const inv = require('../src/inventory')
  const world = flatWorld()
  const bot = new FakeBot({ username: 'T', version: '1.21.4' }, world)
  bot.spawnAt(0, 64, 0)
  bot.setInventory([
    { name: 'bread', count: 3 },
    { name: 'golden_apple', count: 2 },
    { name: 'cooked_beef', count: 4 }
  ])
  const food = inv.bestFood(bot)
  assert.strictEqual(food.name, 'bread', 'eat bread before the golden apples')
  bot.disposePhysics()
})
