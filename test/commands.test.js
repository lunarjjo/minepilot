'use strict'

// the command grammar and the mine process, offline.

const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')

const { parseCommand, COMMANDS, ALIASES, helpLines } = require('../src/commands')
const { materialClass, bestToolFor } = require('../src/autotool')
const { createDefaultSettings } = require('../src/settings')
const { Autopilot } = require('../src/autopilot')
const { FakeBot, VoxelWorld, mcData } = require('./helpers/fake')

// ---------------------------------------------------------------- grammar

test('commands: goto accepts coords, y-less coords and block names', () => {
  let r = parseCommand('goto 100 64 -200')
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.args.mode, 'coords')
  assert.strictEqual(r.args.x.value, 100)

  r = parseCommand('goto 100 -200')
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.args.y, null)
  assert.strictEqual(r.args.z.value, -200)

  r = parseCommand('goto diamond_ore')
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.args.mode, 'block')
  assert.strictEqual(r.args.block, 'diamond_ore')

  r = parseCommand('goto 1 2')
  assert.strictEqual(r.ok, true)
  r = parseCommand('goto a b c')
  assert.strictEqual(r.ok, false)
})

test('commands: relative coordinates survive the parser', () => {
  const r = parseCommand('build tower ~ 70 ~-5')
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.args.origin.x.rel, true)
  assert.strictEqual(r.args.origin.x.value, 0)
  assert.strictEqual(r.args.origin.y.value, 70)
  assert.strictEqual(r.args.origin.z.value, -5)
})

test('commands: mine accepts both baritone argument orders', () => {
  let r = parseCommand('mine 64 diamond_ore')
  assert.strictEqual(r.ok, true)
  assert.deepStrictEqual(r.args.blocks, ['diamond_ore'])
  assert.strictEqual(r.args.count, 64)

  r = parseCommand('mine diamond_ore iron_ore 12')
  assert.strictEqual(r.ok, true)
  assert.deepStrictEqual(r.args.blocks, ['diamond_ore', 'iron_ore'])
  assert.strictEqual(r.args.count, 12)

  r = parseCommand('mine dirt')
  assert.strictEqual(r.args.count, 1)

  r = parseCommand('mine 64')
  assert.strictEqual(r.ok, false) // a count alone is not a target
})

test('commands: follow grammar covers all baritone forms', () => {
  let r = parseCommand('follow player kasyaira')
  assert.strictEqual(r.args.kind, 'player')
  r = parseCommand('follow players')
  assert.strictEqual(r.args.kind, 'players')
  r = parseCommand('follow entity pig cow')
  assert.deepStrictEqual(r.args.types, ['pig', 'cow'])
  r = parseCommand('follow entities')
  assert.strictEqual(r.args.kind, 'entities')
  r = parseCommand('follow off')
  assert.strictEqual(r.args.kind, 'off')
  r = parseCommand('follow Steve')
  assert.strictEqual(r.args.kind, 'player')
  assert.deepStrictEqual(r.args.names, ['Steve'])
})

test('commands: goal variants including clear and y-only', () => {
  let r = parseCommand('goal 10 64 10')
  assert.strictEqual(r.args.mode, 'coords')
  r = parseCommand('goal 10 10')
  assert.strictEqual(r.args.mode, 'coords')
  assert.strictEqual(r.args.y, null)
  r = parseCommand('goal 11')
  assert.strictEqual(r.args.mode, 'ylevel')
  r = parseCommand('goal clear')
  assert.strictEqual(r.args.mode, 'clear')
  r = parseCommand('goal')
  assert.strictEqual(r.args.mode, 'feet')
})

test('commands: set grammar with modes and aliases', () => {
  let r = parseCommand('set')
  assert.strictEqual(r.args.mode, 'modified')
  r = parseCommand('set list')
  assert.strictEqual(r.args.mode, 'list')
  r = parseCommand('set allowBreak false')
  assert.strictEqual(r.args.mode, 'set')
  assert.strictEqual(r.args.key, 'allowBreak')
  r = parseCommand('set allowBreak')
  assert.strictEqual(r.args.mode, 'show')
  r = parseCommand('set reset allowParkour')
  assert.strictEqual(r.args.mode, 'reset')
  // aliases route through set
  r = parseCommand('modified')
  assert.strictEqual(r.name, 'set')
  assert.strictEqual(r.args.mode, 'modified')
  r = parseCommand('reset')
  assert.strictEqual(r.name, 'set')
  assert.strictEqual(r.args.mode, 'reset')
  r = parseCommand('reset allowParkour')
  assert.strictEqual(r.args.key, 'allowParkour')
  r = parseCommand('mod')
  assert.strictEqual(r.name, 'set')
})

test('commands: tunnel farm explore thisway axis surface', () => {
  let r = parseCommand('tunnel')
  assert.deepStrictEqual([r.args.height, r.args.width, r.args.depth], [2, 1, 32])
  r = parseCommand('tunnel 3 2 100')
  assert.deepStrictEqual([r.args.height, r.args.width, r.args.depth], [3, 2, 100])
  r = parseCommand('farm 64')
  assert.strictEqual(r.args.range, 64)
  r = parseCommand('farm 64 homebase')
  assert.strictEqual(r.args.waypoint, 'homebase')
  r = parseCommand('explore 100 200')
  assert.strictEqual(r.args.x, 100)
  r = parseCommand('explore 512')
  assert.strictEqual(r.args.radius, 512)
  r = parseCommand('thisway 1000')
  assert.strictEqual(r.args.distance, 1000)
  r = parseCommand('axis')
  assert.strictEqual(r.args.y, 120)
  r = parseCommand('axis 90')
  assert.strictEqual(r.args.y, 90)
})

test('commands: waypoints grammar with tags', () => {
  let r = parseCommand('wp save user coolbiome')
  assert.strictEqual(r.args.mode, 'save')
  assert.strictEqual(r.args.tag, 'user')
  assert.strictEqual(r.args.name, 'coolbiome')
  r = parseCommand('sethome')
  assert.strictEqual(r.name, 'waypoints')
  r = parseCommand('wp goal death')
  assert.strictEqual(r.args.mode, 'goal')
  r = parseCommand('home')
  assert.strictEqual(r.name, 'waypoints')
  r = parseCommand('wp list')
  assert.strictEqual(r.args.mode, 'list')
})

test('commands: sel grammar covers the baritone action set', () => {
  let r = parseCommand('sel pos1')
  assert.strictEqual(r.args.action, 'pos1')
  r = parseCommand('s p1 10 64 10')
  assert.strictEqual(r.name, 'sel')
  assert.strictEqual(r.args.action, 'pos1')
  assert.deepStrictEqual(r.args.coords, [10, 64, 10])
  r = parseCommand('sel fill dirt')
  assert.strictEqual(r.args.action, 'fill')
  r = parseCommand('sel walls cobblestone')
  assert.strictEqual(r.args.action, 'walls')
  r = parseCommand('sel sphere glass 4')
  assert.strictEqual(r.args.action, 'sphere')
  assert.strictEqual(r.args.radius, 4)
  r = parseCommand('sel hsphere glass 4')
  assert.strictEqual(r.args.hollow, true)
  r = parseCommand('sel cylinder stone 3 5')
  assert.strictEqual(r.args.action, 'cylinder')
  assert.strictEqual(r.args.radius, 3)
  assert.strictEqual(r.args.height, 5)
  r = parseCommand('sel cleararea')
  assert.strictEqual(r.args.action, 'cleararea')
  r = parseCommand('sel replace dirt stone')
  assert.strictEqual(r.args.action, 'replace')
  r = parseCommand('sel expand 5 north')
  assert.strictEqual(r.args.action, 'expand')
  r = parseCommand('sel contract 2')
  assert.strictEqual(r.args.action, 'contract')
  assert.strictEqual(r.args.dir, 'all')
  r = parseCommand('sel copy')
  assert.strictEqual(r.args.action, 'copy')
  r = parseCommand('sel paste')
  assert.strictEqual(r.args.action, 'paste')
})

test('commands: minepilot extras parse', () => {
  let r = parseCommand('excavate sel')
  assert.strictEqual(r.args.mode, 'selection')
  r = parseCommand('excavate 0 60 0 10 70 10')
  assert.deepStrictEqual(r.args.from, [0, 60, 0])
  r = parseCommand('attack zombie')
  assert.strictEqual(r.args.target, 'zombie')
  r = parseCommand('attack off')
  assert.strictEqual(r.args.target, null)
  r = parseCommand('craft chest 4')
  assert.strictEqual(r.args.item, 'chest')
  r = parseCommand('chest deposit cobblestone')
  assert.strictEqual(r.args.mode, 'deposit')
  r = parseCommand('say hello world')
  assert.strictEqual(r.args.message, 'hello world')
  r = parseCommand('drop all')
  assert.strictEqual(r.args.mode, 'all')
})

test('commands: damn daniel works, other words do not', () => {
  assert.strictEqual(parseCommand('damn daniel').ok, true)
  assert.strictEqual(parseCommand('damn').ok, false)
  assert.strictEqual(parseCommand('damn john').ok, false)
})

test('commands: unknown commands suggest, empty is rejected', () => {
  const r = parseCommand('etaa 1')
  assert.strictEqual(r.ok, false)
  assert.ok(r.error.includes('did you mean "eta"'), r.error)
  const r2 = parseCommand('xyzzy 1 2')
  assert.strictEqual(r2.ok, false)
  assert.strictEqual(parseCommand('').ok, false)
  // leading slash tolerated (console input)
  assert.strictEqual(parseCommand('/goto 1 2').ok, true)
})

test('commands: the registry covers the baritone command set', () => {
  const names = new Set(COMMANDS.map((c) => c.name))
  const baritoneCommands = ['help', 'set', 'goal', 'goto', 'path', 'proc', 'eta',
    'version', 'repack', 'build', 'litematica', 'come', 'axis', 'forcecancel',
    'gc', 'invert', 'tunnel', 'render', 'farm', 'follow', 'pickup',
    'explorefilter', 'reloadall', 'saveall', 'explore', 'blacklist', 'find',
    'mine', 'click', 'surface', 'thisway', 'waypoints', 'sel', 'elytra',
    'pause', 'resume', 'paused', 'cancel', 'stop', 'damn']
  for (const c of baritoneCommands) {
    assert.ok(names.has(c), `command #${c} is registered`)
  }
  assert.ok(Object.keys(ALIASES).length >= 10)
  assert.ok(helpLines().length >= 40)
})

// ---------------------------------------------------------------- autotool

test('autotool: material classes map to tool families', () => {
  assert.strictEqual(materialClass('stone'), 'pickaxe')
  assert.strictEqual(materialClass('diamond_ore'), 'pickaxe')
  assert.strictEqual(materialClass('oak_log'), 'axe')
  assert.strictEqual(materialClass('dirt'), 'shovel')
  assert.strictEqual(materialClass('white_wool'), 'shears')
  assert.strictEqual(materialClass('oak_leaves'), 'hoe')
  assert.strictEqual(materialClass('air'), null)
})

function item (name) {
  return { name, count: 1 }
}

test('autotool: ranks carried tools by tier', () => {
  const bot = { inventory: { items: () => [item('stone_pickaxe'), item('diamond_pickaxe'), item('iron_axe')] } }
  const best = bestToolFor(bot, 'deepslate')
  assert.strictEqual(best.name, 'diamond_pickaxe')
  const none = bestToolFor(bot, 'dirt')
  assert.strictEqual(none, null) // no shovel carried: hand is fine
  const empty = bestToolFor({ inventory: { items: () => [] } }, 'stone')
  assert.strictEqual(empty, null)
})

// ------------------------------------------------------------- mine process

function makePilot (world, items) {
  const bot = new FakeBot({ username: 'PilotBot', version: '1.21.4' }, world)
  bot.spawnAt(0, 64, 0)
  if (items) bot.setInventory(items.map(item))
  const settings = createDefaultSettings()
  const pilot = new Autopilot({ bot, deps: { Vec3 }, settings })
  return { bot, pilot, settings }
}

test('mine process: digs the vein including adjacent ores', async () => {
  const w = new VoxelWorld()
  w.ground(-6, -6, 6, 6, 63)
  // a small diamond vein: 3 connected ores
  w.setBlock(3, 63, 0, 'diamond_ore')
  w.setBlock(4, 63, 0, 'diamond_ore')
  w.setBlock(4, 63, 1, 'diamond_ore')
  w.setBlock(3, 62, 2, 'diamond_ore') // NOT adjacent: must survive
  const { pilot } = makePilot(w)
  const { runMine, digVein } = require('../src/processes/mine')
  // digVein directly: the executor walk is covered by engine tests; here we
  // prove the vein logic itself
  const dug = await digVein(pilot, { x: 3, y: 63, z: 0 }, () => true)
  assert.strictEqual(dug, 3, 'three connected ores broken')
  assert.strictEqual(w.blockAtXYZ(3, 62, 2).name, 'diamond_ore', 'the isolated ore survives')
  assert.strictEqual(w.blockAtXYZ(3, 63, 0).name, 'air')
})

test('mine process: never targets the column the bot stands in', async () => {
  const w = new VoxelWorld()
  w.ground(-6, -6, 6, 6, 63)
  w.setBlock(0, 63, 0, 'diamond_ore') // directly below the bot
  w.setBlock(5, 63, 5, 'diamond_ore')
  const { findNearest } = require('../src/processes/mine')
  const { pilot } = makePilot(w)
  const target = findNearest(pilot, ['diamond_ore'])
  assert.ok(target)
  assert.strictEqual(target.x, 5)
  assert.strictEqual(target.z, 5)
})

test('mine process: blacklisted cells are skipped', async () => {
  const w = new VoxelWorld()
  w.ground(-8, -8, 8, 8, 63)
  w.setBlock(2, 63, 2, 'iron_ore')
  w.setBlock(6, 63, 6, 'iron_ore')
  const { findNearest } = require('../src/processes/mine')
  const { pilot } = makePilot(w)
  const first = findNearest(pilot, ['iron_ore'])
  assert.deepStrictEqual([first.x, first.y, first.z], [2, 63, 2])
  pilot.mineBlacklist = new Set(['2,63,2'])
  const second = findNearest(pilot, ['iron_ore'])
  assert.deepStrictEqual([second.x, second.y, second.z], [6, 63, 6])
})

test('mine process: runMine completes a count and reports', async () => {
  const w = new VoxelWorld()
  // a THICK ground: digging a surface ore must not drop the bot into the void
  w.fill(-8, 58, -8, 8, 63, 8, 'grass_block')
  w.fill(-8, 64, -8, 8, 70, 8, 'air')
  w.setBlock(3, 63, 2, 'iron_ore')
  w.setBlock(-4, 63, -5, 'iron_ore')
  const { runMine } = require('../src/processes/mine')
  const { pilot, bot } = makePilot(w)
  const out = await runMine(pilot, ['iron_ore'], 2, () => true)
  assert.strictEqual(out.dug, 2)
  assert.strictEqual(w.blockAtXYZ(3, 63, 2).name, 'air')
  assert.strictEqual(w.blockAtXYZ(-4, 63, -5).name, 'air')
  bot.disposePhysics()
})

test('mine process: throws honestly when nothing is in range', async () => {
  const w = new VoxelWorld()
  w.ground(-4, -4, 4, 4, 63)
  const { runMine } = require('../src/processes/mine')
  const { pilot } = makePilot(w)
  await assert.rejects(() => runMine(pilot, ['diamond_ore'], 1, () => true),
    /no diamond_ore in range/)
})
