'use strict'

// movement on ROUGH terrain — the owner's standing rule: a bot validated
// only on superflat worlds has never met a mountain. every fixture here
// is a hill, a cliff, a chasm or a river; arrival (and survival) is the
// assertion. seeded randomness keeps the rugged worlds deterministic.

const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')

const { executeCommand } = require('../src/commandexec')
const { createDefaultSettings } = require('../src/settings')
const { Autopilot } = require('../src/autopilot')
const { FakeBot, VoxelWorld, mkItem } = require('./helpers/fake')

// deterministic rugged heightmap: value noise via a seeded LCG
function rng (seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

function makeCtx (world, items) {
  const bot = new FakeBot({ username: 'TerrainBot', version: '1.21.4' }, world)
  bot.spawnAt(0.5, 64, 0.5)
  if (items) bot.setInventory(items.map((i) => (i.name ? i : mkItem(i))))
  const settings = createDefaultSettings()
  const pilot = new Autopilot({ bot, deps: { Vec3 }, settings })
  const lines = []
  const ctx = {
    pilot, bot, settings, selection: { hasSelection: () => false, volume: () => 0 },
    waypoints: { list: () => [] },
    reply: (t) => lines.push(t),
    source: 'console', commander: null
  }
  return { ctx, lines, bot, pilot, world }
}

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// a world whose ground height is a function of (x, z): walls filled down
// to a base so slopes are solid, air cleared above
function heightWorld (baseY, heightAt, x0, z0, x1, z1) {
  const w = new VoxelWorld()
  for (let x = x0; x <= x1; x++) {
    for (let z = z0; z <= z1; z++) {
      const h = heightAt(x, z)
      w.fill(x, baseY - 24, z, x, h, z, h > baseY ? 'stone' : 'grass_block')
      w.fill(x, h + 1, z, x, h + 8, z, 'air')
    }
  }
  return w
}

// ------------------------------------------------------------- the mountain

test('terrain: a staircase mountain is climbed to the peak', { timeout: 90000 }, async () => {
  // one step up per cell along +x, ten steps: the classic steady hill
  const w = heightWorld(64, (x) => 63 + Math.max(0, Math.min(10, x)), -6, -6, 24, 6)
  const { ctx, bot, pilot } = makeCtx(w)
  const r = await executeCommand('goto 10 74 0', ctx)
  assert.strictEqual(r.ok, true, r.error || 'goto started')
  assert.ok(await waitIdlePilot(pilot, 60000), 'the climb finished in budget')
  const p = bot.entity.position
  assert.ok(Math.abs(p.x - 10.5) < 1.2 && Math.abs(p.y - 74) < 1.3, `stood on the peak (x=${p.x.toFixed(1)} y=${p.y.toFixed(1)})`)
  bot.disposePhysics()
})

test('terrain: a rugged hillside is crossed without drama', { timeout: 120000 }, async () => {
  // seeded choppy terrain: heights 0..3 above the base in blobs — ascends,
  // descends, digs and the occasional place all get their turn. the spawn
  // and goal columns are pinned to the base so both ends stand clean.
  const rand = rng(20261103)
  const heights = new Map()
  for (let x = -10; x <= 46; x++) {
    for (let z = -8; z <= 8; z++) {
      if ((x === 0 || x === 40) && z === 0) { heights.set(`${x},${z}`, 63); continue }
      const blob = Math.floor(rand() * 4) * Math.floor(rand() * 2 + 1)
      heights.set(`${x},${z}`, 63 + Math.min(3, blob))
    }
  }
  const w = heightWorld(64, (x, z) => heights.get(`${x},${z}`) ?? 63, -10, -8, 46, 8)
  const { ctx, bot, pilot } = makeCtx(w)
  const r = await executeCommand('goto 40 64 0', ctx)
  assert.strictEqual(r.ok, true, r.error || 'goto started')
  assert.ok(await waitIdlePilot(pilot, 90000), 'the crossing finished in budget')
  const p = bot.entity.position
  assert.ok(p.x > 38.5, `reached the far side (x=${p.x.toFixed(1)})`)
  assert.ok(p.y > 60, `stayed on the surface (y=${p.y.toFixed(1)})`)
  bot.disposePhysics()
})

// ---------------------------------------------------------------- the cliff

test('terrain: a sheer cliff is descended safely, never dropped', { timeout: 120000 }, async () => {
  // flat top, then a 6-deep sheer wall (beyond the 3-block no-damage
  // budget), flat floor beyond — the only safe route down is placing a
  // staircase (bridge forward + step down), never walking off the edge
  const w = new VoxelWorld()
  w.fill(-8, 57, -8, 30, 63, 8, 'grass_block') // the valley floor at y63
  w.fill(-8, 64, -8, 30, 70, 8, 'air')
  w.fill(-8, 57, -8, -1, 69, 8, 'stone') // the cliff body: top at y69, feet at 70
  w.fill(-8, 70, -8, -1, 70, 8, 'air') // wait: carve the standing surface
  w.fill(-8, 69, -8, -1, 69, 8, 'stone')
  w.fill(-8, 70, -8, -1, 75, 8, 'air')
  // bot spawns on the cliff top: ground at y69, feet at y70
  const { ctx, bot, pilot } = makeCtx(w, [{ name: 'cobblestone', count: 64 }])
  bot.entity.position = new Vec3(-6.5, 70, 0.5)
  const r = await executeCommand('goto 12 64 0', ctx)
  assert.strictEqual(r.ok, true, r.error || 'goto started')
  assert.ok(await waitIdlePilot(pilot, 90000), 'the descent finished in budget')
  const p = bot.entity.position
  assert.ok(p.x > 10.5 && Math.abs(p.y - 64) < 1.3, `stood on the valley floor (x=${p.x.toFixed(1)} y=${p.y.toFixed(1)})`)
  assert.ok(bot.health === 20, `no fall damage taken (health=${bot.health})`)
  bot.disposePhysics()
})

// ---------------------------------------------------------------- the chasm

test('terrain: a wide chasm is bridged across', { timeout: 120000 }, async () => {
  // two plateaus, a 5-wide chasm between them with lava at the bottom:
  // falling is death, bridging is the only route
  const w = new VoxelWorld()
  w.fill(-8, 60, -8, 30, 63, 8, 'grass_block')
  w.fill(-8, 64, -8, 30, 70, 8, 'air')
  w.fill(3, 50, -8, 7, 51, 8, 'lava') // the chasm floor burns
  w.fill(3, 52, -8, 7, 63, 8, 'air') // the chasm shaft
  const { ctx, bot, pilot } = makeCtx(w, [{ name: 'cobblestone', count: 64 }])
  const r = await executeCommand('goto 12 64 0', ctx)
  assert.strictEqual(r.ok, true, r.error || 'goto started')
  assert.ok(await waitIdlePilot(pilot, 90000), 'the crossing finished in budget')
  const p = bot.entity.position
  assert.ok(p.x > 10.5 && Math.abs(p.y - 64) < 1.3, `stood on the far plateau (x=${p.x.toFixed(1)} y=${p.y.toFixed(1)})`)
  assert.ok(bot.health === 20, `the lava never touched the bot (health=${bot.health})`)
  // the bridge is real: cobblestone spans the chasm at foot level somewhere
  // along the crossing (the planner may drift z mid-bridge — that is legal)
  let spanned = 0
  for (let x = 3; x <= 7; x++) {
    for (let z = -2; z <= 2; z++) {
      if (w.blockAtXYZ(x, 63, z).name === 'cobblestone') spanned++
    }
  }
  assert.ok(spanned >= 3, `the bridge actually spans the gap (${spanned} cobblestone cells at y63)`)
  bot.disposePhysics()
})

// ----------------------------------------------------------------- the river

test('terrain: a river is swum across', { timeout: 120000 }, async () => {
  const w = new VoxelWorld()
  w.fill(-8, 60, -8, 30, 63, 8, 'grass_block')
  w.fill(-8, 64, -8, 30, 70, 8, 'air')
  w.fill(3, 62, -8, 12, 63, 8, 'water') // 10-wide river, surface at y63
  w.fill(3, 64, -8, 12, 65, 8, 'air')
  const { ctx, bot, pilot } = makeCtx(w)
  const r = await executeCommand('goto 20 64 0', ctx)
  assert.strictEqual(r.ok, true, r.error || 'goto started')
  assert.ok(await waitIdlePilot(pilot, 90000), 'the crossing finished in budget')
  const p = bot.entity.position
  assert.ok(p.x > 18.5 && Math.abs(p.y - 64) < 1.3, `dried off on the far bank (x=${p.x.toFixed(1)} y=${p.y.toFixed(1)})`)
  bot.disposePhysics()
})

// ------------------------------------------------------------- the parkour ridge

test('terrain: one-wide gaps are cleared with sprint jumps', { timeout: 90000 }, async () => {
  // a ridge of pillars separated by one-wide gaps at the same height —
  // with parkour on, the planner should prefer the jump over bridging
  const w = new VoxelWorld()
  w.fill(-6, 60, -2, 30, 63, 2, 'grass_block')
  w.fill(-6, 64, -2, 30, 70, 2, 'air')
  for (const gx of [2, 5, 8, 11, 14]) {
    w.fill(gx, 60, -2, gx, 63, 2, 'air') // the gap: no floor, but land below
    w.fill(gx, 57, -2, gx, 59, 2, 'stone') // a safe-ish floor 4 down
  }
  const { ctx, bot, pilot } = makeCtx(w)
  ctx.settings.set('allowParkour', true)
  const r = await executeCommand('goto 20 64 0', ctx)
  assert.strictEqual(r.ok, true, r.error || 'goto started')
  assert.ok(await waitIdlePilot(pilot, 60000), 'the run finished in budget')
  const p = bot.entity.position
  assert.ok(p.x > 18.5 && Math.abs(p.y - 64) < 1.3, `cleared every gap (x=${p.x.toFixed(1)} y=${p.y.toFixed(1)})`)
  bot.disposePhysics()
})

// ------------------------------------------------------- the broken staircase

test('terrain: a missing stair is rebuilt on the fly', { timeout: 90000 }, async () => {
  // a staircase slope with holes in it: the planner must place the
  // missing steps (ascendPlace) instead of tunneling the whole hill
  const w = heightWorld(64, (x) => 63 + Math.max(0, Math.min(8, x)), -6, -6, 24, 6)
  // punch holes into the slope: remove the support at every other step
  for (const x of [1, 3, 5, 7]) w.fill(x, 63 + x, -6, x, 63 + x, 6, 'air')
  const { ctx, bot, pilot } = makeCtx(w, [{ name: 'cobblestone', count: 64 }])
  const r = await executeCommand('goto 8 72 0', ctx)
  assert.strictEqual(r.ok, true, r.error || 'goto started')
  assert.ok(await waitIdlePilot(pilot, 60000), 'the climb finished in budget')
  const p = bot.entity.position
  assert.ok(Math.abs(p.x - 8.5) < 1.2 && Math.abs(p.y - 72) < 1.3, `topped the broken stair (x=${p.x.toFixed(1)} y=${p.y.toFixed(1)})`)
  // the holes were filled with carried cobble somewhere along the way
  let placed = 0
  for (const b of w.blocks.values()) if (b.name === 'cobblestone') placed++
  assert.ok(placed >= 1, `the missing steps were rebuilt (${placed} cobblestone in the world)`)
  bot.disposePhysics()
})
