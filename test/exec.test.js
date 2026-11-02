'use strict'

// the command executor and the managers behind it, offline.

const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')

const { executeCommand, hostileName } = require('../src/commandexec')
const { search } = require('../src/engine/astar')
const { generate, DEFAULTS } = require('../src/engine/moves')
const { GoalXZ } = require('../src/engine/goals')
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

test('exec: come awaits the async plan and replies properly', async () => {
  const { ctx, lines } = makeCtx(flatWorld)
  ctx.commander = { name: 'Kasyaira', entity: { position: new Vec3(0, 64, 0) } }
  const r = await executeCommand('come', ctx)
  assert.strictEqual(r.ok, true)
  // the reply used to be "undefined": the result promise was consumed
  // synchronously before the async migration
  assert.ok(lines.some((l) => typeof l === 'string' && l.includes('heading to Kasyaira')),
    `replied with: ${JSON.stringify(lines)}`)
  assert.ok(!lines.some((l) => String(l) === 'undefined'), 'no undefined reply')
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

// ------------------------------------------------- baritone-grade movement

function waitIdlePilot (pilot, ms) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const iv = setInterval(() => {
      if (!pilot.executor.running || Date.now() - t0 > (ms || 30000)) {
        clearInterval(iv)
        resolve(!pilot.executor.running || Date.now() - t0 <= (ms || 30000))
      }
    }, 150)
  })
}

test('movement: bridging a gap finishes without a splice storm', { timeout: 90000 }, async () => {
  const w = new VoxelWorld()
  // shelf x<=0 at floor 63; a 7-wide known-air gap; far shelf x>=8
  w.fill(-6, 63, -2, 0, 63, 2, 'grass_block')
  w.fill(-6, 64, -2, 0, 69, 2, 'air')
  w.fill(1, 40, -2, 7, 69, 2, 'air') // the gap: known air, nothing below
  w.fill(8, 63, -2, 14, 63, 2, 'grass_block')
  w.fill(8, 64, -2, 14, 69, 2, 'air')
  const { ctx, bot, pilot } = makeCtx(() => w)
  bot.setInventory([{ name: 'cobblestone', count: 64, slot: -1, type: 3 }])
  let splices = 0
  pilot.on('splice', () => { splices++ })
  const r = await executeCommand('goto 9 64 0', ctx)
  assert.strictEqual(r.ok, true, r.error || 'goto started')
  await waitIdlePilot(pilot, 60000)
  const p = bot.entity.position
  assert.ok(Math.abs(p.x - 9.5) < 1.2 && Math.abs(p.z - 0.5) < 1.2 && Math.abs(p.y - 64) < 1.3,
    `arrived across the bridge at ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}`)
  assert.ok(w.blockAtXYZ(2, 63, 0).name === 'cobblestone', 'the bridge is really placed')
  // the regression: chained bridges used to invalidate their own lookahead
  // and replan forever without placing anything
  assert.ok(splices <= 1, `bridge chain must not splice-storm (got ${splices})`)
  bot.disposePhysics()
})

test('movement: digging through a wall equips the best tool', { timeout: 90000 }, async () => {
  const w = new VoxelWorld()
  // a floor-to-ceiling stone wall: tunneling is the only route (climbing
  // over it is impossible — the wall reaches the world's air ceiling)
  w.fill(-3, 63, -2, 20, 63, 2, 'grass_block')
  w.fill(-3, 64, -2, 20, 69, 2, 'air')
  w.fill(3, 64, -20, 4, 69, 20, 'stone')
  const { ctx, bot, pilot } = makeCtx(() => w)
  bot.setInventory([{ name: 'iron_pickaxe', count: 1, slot: -1, type: 4 }])
  const r = await executeCommand('goto 7 64 0', ctx)
  assert.strictEqual(r.ok, true, r.error || 'goto started')
  await waitIdlePilot(pilot, 60000)
  const p = bot.entity.position
  assert.ok(Math.abs(p.x - 7.5) < 1.2 && Math.abs(p.y - 64) < 1.3, `tunneled through at x=${p.x.toFixed(1)}`)
  assert.ok(bot.equips.includes('iron_pickaxe'), 'the dig swung the pickaxe, not bare hands')
  // the tunnel opened the wall at whatever z the planner chose (diagonal
  // routes through the 2-deep wall are legal) — assert at the bot's own z
  const z = Math.round(p.z)
  assert.ok(['air', 'cave_air'].includes(w.blockAtXYZ(3, 64, z).name) ||
    ['air', 'cave_air'].includes(w.blockAtXYZ(4, 64, z).name),
    'the wall is opened along the tunnel')
  bot.disposePhysics()
})

test('movement: long flat straights sprint (and hop)', { timeout: 90000 }, async () => {
  const w = new VoxelWorld()
  w.fill(-10, 63, -3, 40, 63, 3, 'grass_block')
  w.fill(-10, 64, -3, 40, 69, 3, 'air')
  const { ctx, bot, pilot } = makeCtx(() => w)
  let sawSprint = false
  let sawHop = false
  const iv = setInterval(() => {
    if (bot.controls.sprint) sawSprint = true
    if (bot.controls.sprint && bot.controls.jump) sawHop = true
  }, 60)
  const t0 = Date.now()
  const r = await executeCommand('goto 25 64 0', ctx)
  assert.strictEqual(r.ok, true, r.error || 'goto started')
  await waitIdlePilot(pilot, 60000)
  clearInterval(iv)
  const secs = (Date.now() - t0) / 1000
  const p = bot.entity.position
  assert.ok(Math.abs(p.x - 25.5) < 1.2 && Math.abs(p.y - 64) < 1.3, `ran the straight at x=${p.x.toFixed(1)}`)
  assert.ok(sawSprint, 'sprint engaged on the long straight')
  assert.ok(sawHop, 'the bunny hop engaged (sprint + jump)')
  // 25 blocks: walking takes ~5.8s, sprinting ~4.5s, sprint-jumping faster.
  // the fake runs at sprint speed 5.6 with no jump boost, so the ceiling
  // is generous — the point is it must not be WALKING pace (5.9s+)
  assert.ok(secs < 6.5, `covered 25 blocks in ${secs.toFixed(1)}s`)
  bot.disposePhysics()
})

test('movement: digging straight down reaches a lower floor safely', { timeout: 90000 }, async () => {
  const w = new VoxelWorld()
  // thick diggable ground over a stone floor: the goal sits 6 below the
  // grass, dead below the bot — digdown is the only route
  w.fill(-4, 50, -2, 6, 57, 2, 'stone')
  w.fill(-4, 58, -2, 6, 62, 2, 'dirt')
  w.fill(-4, 63, -2, 6, 63, 2, 'grass_block')
  w.fill(-4, 64, -2, 6, 75, 2, 'air')
  const { ctx, bot, pilot } = makeCtx(() => w)
  const r = await executeCommand('goto 0 58 0', ctx)
  assert.strictEqual(r.ok, true, r.error || 'goto started')
  await waitIdlePilot(pilot, 60000)
  const p = bot.entity.position
  assert.ok(Math.abs(p.y - 58) < 1.3 && Math.abs(p.x - 0.5) < 1.2, `dug down to y=${p.y.toFixed(1)}`)
  assert.strictEqual(w.blockAtXYZ(0, 57, 0).name, 'stone', 'landed on the stone floor')
  bot.disposePhysics()
})

test('movement: a wall mid-plan trims to the valid prefix, then replanwait', { timeout: 30000 }, async () => {
  const { bot, pilot, world } = makeCtx(flatWorld)
  // a straight 10-block plan along +x, computed against the untouched world
  const plan = search({ x: 0, y: 64, z: 0 }, new GoalXZ(10, 0), (n) => generate(pilot.view, n, DEFAULTS))
  assert.strictEqual(plan.status, 'found')
  const wallAt = plan.moves.findIndex((m) => m.to.x === 6 && m.to.z === 0)
  assert.ok(wallAt > 2, 'the straight plan crosses x=6')

  let splicedAt = null
  let lastProgress = -1
  let walled = false
  const seen = []
  pilot.executor.on('splice', (e) => { splicedAt = e.at })
  pilot.executor.on('progress', (p) => {
    lastProgress = p.index
    // drop the wall once the bot is a few moves in: inside the lookahead
    // by the next validator pass, with valid ground still ahead of it
    if (!walled && p.index >= 2) {
      walled = true
      world.setBlock(6, 64, 0, 'stone')
    }
  })
  pilot.executor.on('replanwait', () => seen.push('replanwait'))
  pilot.executor.on('arrived', () => seen.push('arrived'))

  pilot.executor.run(plan.moves)
  await waitIdlePilot(pilot, 20000)

  assert.ok(walled, 'the wall dropped mid-run')
  assert.ok(splicedAt !== null, 'the executor spliced')
  assert.strictEqual(splicedAt, wallAt, 'the splice points at the walled move')
  assert.ok(!pilot.executor.running, 'the walk finished the trimmed prefix')
  assert.ok(pilot.executor.awaitingReplan, 'the goal is still owed a replan')
  assert.ok(lastProgress >= wallAt - 1, `kept walking past the splice (reached move ${lastProgress})`)
  const p = bot.entity.position
  assert.ok(p.x > 3.5, `walked the valid prefix to x=${p.x.toFixed(1)}`)
  assert.deepStrictEqual(seen, ['replanwait'], 'replanwait, never a premature arrived')
  bot.disposePhysics()
})
