'use strict'

// the cockpit server: rest endpoints, the websocket protocol and the map
// view — against the fake bot, no network beyond loopback.

const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const WebSocket = require('ws')

const { createDefaultSettings } = require('../src/settings')
const { Autopilot } = require('../src/autopilot')
const { WaypointStore } = require('../src/waypoints')
const { SelectionManager } = require('../src/selection')
const { MapView } = require('../src/mapview')
const { createCockpitServer } = require('../src/server')
const { FakeBot, VoxelWorld } = require('./helpers/fake')
const os = require('os')
const path = require('path')

function makeStack () {
  const w = new VoxelWorld()
  w.fill(-16, 58, -16, 16, 63, 16, 'grass_block')
  w.fill(-16, 64, -16, 16, 120, 16, 'air')
  const bot = new FakeBot({ username: 'PilotBot', version: '1.21.4' }, w)
  bot.spawnAt(0, 64, 0)
  const settings = createDefaultSettings()
  const pilot = new Autopilot({ bot, deps: { Vec3 }, settings })
  const waypoints = new WaypointStore(path.join(os.tmpdir(), 'minepilot-srv-' + Date.now() + '.json'))
  const selection = new SelectionManager()
  const ctx = {
    pilot, bot, settings, selection, waypoints,
    reply: () => {}, source: 'console', commander: null, exploreFilter: null
  }
  ctx.mapview = new MapView(bot, settings)
  return { ctx, bot, w }
}

// a ws client that buffers every message from the start, so nothing is
// lost while tests attach listeners late
function wsTap (ws) {
  const buffer = []
  const listeners = []
  ws.on('message', (data) => {
    let m
    try { m = JSON.parse(String(data)) } catch (e) { return }
    buffer.push(m)
    for (const l of [...listeners]) l(m)
  })
  return {
    buffered: (t) => buffer.filter((m) => m.t === t),
    waitFor (want, match, timeoutMs) {
      if (typeof match === 'number') { timeoutMs = match; match = null }
      const ok = (m) => m.t === want && (!match || match(m))
      const hit = buffer.find(ok)
      if (hit) return Promise.resolve(hit)
      return new Promise((resolve, reject) => {
        const to = setTimeout(() => {
          const i = listeners.indexOf(fn)
          if (i >= 0) listeners.splice(i, 1)
          reject(new Error(`timed out waiting for ${want} (got ${buffer.map((m) => m.t).join(',')})`))
        }, timeoutMs || 4000)
        const fn = (m) => {
          if (ok(m)) {
            clearTimeout(to)
            const i = listeners.indexOf(fn)
            if (i >= 0) listeners.splice(i, 1)
            resolve(m)
          }
        }
        listeners.push(fn)
      })
    }
  }
}

test('server: rest endpoints serve health, status and commands', async () => {
  const { ctx } = makeStack()
  const cockpit = createCockpitServer(ctx)
  const addr = await cockpit.listen(0, '127.0.0.1')
  const base = `http://127.0.0.1:${addr.port}`
  try {
    let r = await fetch(base + '/api/health')
    assert.strictEqual(r.status, 200)
    let body = await r.json()
    assert.strictEqual(body.ok, true)
    assert.strictEqual(body.bot, 'PilotBot')

    r = await fetch(base + '/api/status')
    body = await r.json()
    assert.ok(body.position)
    assert.strictEqual(body.task.task, 'idle')

    r = await fetch(base + '/api/command', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'damn daniel' })
    })
    body = await r.json()
    assert.strictEqual(body.result.ok, true)
    assert.ok(body.lines.some((l) => l.includes('white vans')))

    r = await fetch(base + '/api/settings')
    body = await r.json()
    assert.ok(body.settings.length > 60)

    r = await fetch(base + '/')
    const html = await r.text()
    assert.ok(html.includes('minepilot'))
  } finally {
    cockpit.close()
  }
})

test('server: ws hello -> viewport chunks -> commands broadcast', async () => {
  const { ctx, bot } = makeStack()
  const cockpit = createCockpitServer(ctx)
  cockpit.wireBot(bot)
  const addr = await cockpit.listen(0, '127.0.0.1')
  const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`)
  const tap = wsTap(ws)
  try {
    await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject) })

    const hello = await tap.waitFor('hello')
    assert.strictEqual(hello.username, 'PilotBot')
    assert.ok(hello.settings.length > 60)
    assert.ok(hello.waypoints)

    // ask for the viewport around the bot (chunk 0,0)
    ws.send(JSON.stringify({ t: 'viewport', cx0: -1, cz0: -1, cx1: 1, cz1: 1 }))
    const chunks = await tap.waitFor('chunks')
    assert.ok(chunks.chunks.length >= 1)
    const first = chunks.chunks[0]
    assert.ok(first.cols.length === 256)
    const solid = first.cols.filter(Boolean)
    assert.ok(solid.length > 200, 'the superflat chunk is mostly solid')
    assert.strictEqual(solid[0].n, 'grass_block')
    assert.ok(solid[0].c.startsWith('#') || solid[0].c.startsWith('rgb'))

    // a command runs and broadcasts the reply as chat
    ws.send(JSON.stringify({ t: 'command', text: 'where' }))
    const chat = await tap.waitFor('chat', (m) => m.text.includes('i am at'))
    assert.ok(chat.text.includes('0 64 0'))

    // a state tick arrives with position + task
    const st = await tap.waitFor('state', 6000)
    assert.deepStrictEqual(st.node, { x: 0, y: 64, z: 0 })
    assert.strictEqual(st.task.task, 'idle')

    // map click walks: click sends a goto command
    ws.send(JSON.stringify({ t: 'click', x: 5, z: 5, y: 64, button: 'left' }))
    const clickChat = await tap.waitFor('chat', (m) => m.text.includes('moving to'))
    assert.ok(clickChat.text.includes('moving to'), clickChat.text)

    // a selection drag sets pos1/pos2 and broadcasts it
    ws.send(JSON.stringify({ t: 'select', x0: 0, z0: 0, x1: 3, z1: 3, y0: 64, y1: 64 }))
    const sel = await tap.waitFor('selection')
    assert.ok(sel.selection.pos1)
    assert.ok(sel.selection.pos2)
    assert.strictEqual(ctx.selection.volume(), 16)
  } finally {
    ws.close()
    cockpit.close()
  }
})

test('server: mapview scans the topmost block per column', () => {
  const { ctx, w } = makeStack()
  const mv = ctx.mapview
  // a tower on the flat ground
  w.setBlock(8, 80, 8, 'stone')
  const top = mv.topOf(8, 8, 110)
  assert.strictEqual(top.name, 'stone')
  assert.strictEqual(top.y, 80)
  const flat = mv.topOf(4, 4, 110)
  assert.strictEqual(flat.name, 'grass_block')
  assert.strictEqual(flat.y, 63)
  // unknown space beyond the world: fog
  assert.strictEqual(mv.topOf(400, 400, 110), null)
  // a chunk payload has colors and names
  const payload = mv.chunkPayload(0, 0)
  assert.strictEqual(payload.cols.length, 256)
  const idx = 8 * 16 + 8
  assert.strictEqual(payload.cols[idx].n, 'stone')
  // viewport bounds respected
  const vp = mv.viewport(0, 0, 0, 0)
  assert.strictEqual(vp.length, 1)
  assert.strictEqual(mv.viewport(500, 500, 510, 510).length, 0, 'fog chunks skipped')
})

test('server: block updates invalidate the cached column', () => {
  const { ctx, w, bot } = makeStack()
  const mv = ctx.mapview
  const before = mv.chunkPayload(0, 0)
  const idx = 2 * 16 + 2
  assert.strictEqual(before.cols[idx].n, 'grass_block')
  // place a tower block -> blockUpdate fires -> cache drops
  w.setBlock(2, 88, 2, 'gold_block')
  bot.emit('blockUpdate', null, { position: new Vec3(2, 88, 2), name: 'gold_block' })
  assert.ok(mv.drainDirty().includes('0,0'))
  const after = mv.chunkPayload(0, 0)
  assert.strictEqual(after.cols[idx].n, 'gold_block')
  assert.strictEqual(after.cols[idx].y, 88)
})
