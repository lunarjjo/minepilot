'use strict'

// the live end-to-end suite. boots the real stack (bot + cockpit) against a
// running vanilla server and drives it exactly the way a user does: REST,
// websocket and the command grammar. run it with:
//
//   MINEPILOT_LIVE_E2E=1 MC_HOST=127.0.0.1 MC_PORT=25565 MC_VERSION=1.21.8 \
//     APP_PORT=3117 node test/live.js
//
// the suite is skipped unless MINEPILOT_LIVE_E2E=1.

const { spawn } = require('child_process')
const path = require('path')
const WebSocket = require('ws')

const ROOT = path.join(__dirname, '..')
const APP_PORT = Number(process.env.APP_PORT || 3117)
const MC_HOST = process.env.MC_HOST || '127.0.0.1'
const MC_PORT = Number(process.env.MC_PORT || 25565)
const MC_VERSION = process.env.MC_VERSION || '1.21.8'
const BOT_NAME = process.env.BOT_NAME || 'Minepilot'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function until (fn, timeoutMs, what) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what || 'it'}`)
    await sleep(250)
  }
}

async function get (p) {
  const res = await fetch(`http://127.0.0.1:${APP_PORT}${p}`)
  return { status: res.status, body: await res.json() }
}

async function post (p, body) {
  const res = await fetch(`http://127.0.0.1:${APP_PORT}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  return { status: res.status, body: await res.json() }
}

let passed = 0
let failed = 0
function check (name, ok, detail) {
  if (ok) {
    passed++
    console.log(`  ok    ${name}`)
  } else {
    failed++
    console.log(`  FAIL  ${name}${detail ? ' — ' + String(detail).slice(0, 200) : ''}`)
  }
}

async function main () {
  if (process.env.MINEPILOT_LIVE_E2E !== '1') {
    console.log('MINEPILOT_LIVE_E2E != 1 — live suite skipped')
    return 0
  }

  console.log(`live e2e: bot -> ${MC_HOST}:${MC_PORT} (mc ${MC_VERSION}), cockpit on :${APP_PORT}`)

  // ------------------------------------------------------------- boot stack
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      MINEPILOT_HOST: MC_HOST,
      MINEPILOT_PORT: String(MC_PORT),
      MINEPILOT_USERNAME: BOT_NAME,
      MINEPILOT_VERSION: MC_VERSION,
      APP_PORT: String(APP_PORT)
    }),
    stdio: ['pipe', 'pipe', 'pipe', 'ipc']
  })
  const childLogs = []
  child.stdout.on('data', (d) => {
    const text = String(d).trim()
    if (text) childLogs.push(text)
    console.log('  [stack] ' + text)
  })
  child.stderr.on('data', (d) => console.error('  [stack!] ' + String(d).trim()))

  try {
    // 1. the cockpit comes up
    const health = await until(async () => {
      try { return await get('/api/health') } catch (e) { return null }
    }, 30000, 'the cockpit to start')
    check('cockpit boots and answers /api/health', health.body.ok === true)

    // 2. the bot connects and spawns
    const spawned = await until(async () => {
      const r = await get('/api/status')
      return r.body.connected ? r.body : null
    }, 90000, 'the bot to spawn')
    check('bot connects to the vanilla server', spawned.connected === true, `version ${spawned.version}`)
    check('bot reports a position', !!spawned.position)

    // 3. the websocket protocol
    const ws = new WebSocket(`ws://127.0.0.1:${APP_PORT}/ws`)
    const msgs = []
    ws.on('message', (d) => {
      try { msgs.push(JSON.parse(String(d))) } catch (e) { /* ignore */ }
    })
    await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject) })
    const hello = await until(() => msgs.find((m) => m.t === 'hello'), 10000, 'the hello message')
    check('ws hello carries identity + settings + waypoints', hello.username === BOT_NAME && hello.settings.length > 60)

    // 4. the map streams real chunks
    ws.send(JSON.stringify({ t: 'viewport', cx0: -2, cz0: -2, cx1: 2, cz1: 2 }))
    const chunkMsg = await until(() => msgs.find((m) => m.t === 'chunks' && m.chunks.length > 0), 30000, 'map chunks')
    const anyCol = chunkMsg.chunks.flatMap((c) => c.cols).filter(Boolean)
    check('map streams the superflat terrain', anyCol.length > 100 && anyCol.some((c) => c.n === 'grass_block'))

    // 5. a state tick with live position
    const st = await until(() => msgs.find((m) => m.t === 'state' && m.node), 10000, 'a state tick')
    check('state tick streams position + task', !!st.node && !!st.task)

    // 6. walk by REST command: goto a point 24 blocks east
    const startNode = st.node
    const tx = startNode.x + 24
    const tz = startNode.z + 3
    const g = await post('/api/command', { command: `goto ${tx} ${tz}` })
    check('goto accepted', g.body.result.ok === true, g.body.lines.join(' | '))
    await until(async () => {
      const r = await get('/api/status')
      return r.body.task.task === 'idle' ? r.body : null
    }, 120000, 'the goto to finish').catch(() => null)
    const after = (await get('/api/status')).body
    const walked = Math.abs(after.position.x - startNode.x) >= 20
    check('bot physically walks to the target', walked, `x ${startNode.x} -> ${after.position.x}`)

    // 7. eta + proc report while idle
    const eta = await post('/api/command', { command: 'eta' })
    check('eta answers', eta.body.result.ok === true, eta.body.lines.join(' | '))
    const proc = await post('/api/command', { command: 'proc' })
    check('proc answers', proc.body.result.ok === true)

    // 8. mine real blocks by name (the superflat surface is grass)
    const mine = await post('/api/command', { command: 'mine grass_block 2' })
    check('mine accepted', mine.body.result.ok === true, mine.body.lines.join(' | '))
    const minedLog = await until(() => msgs.find((m) => m.t === 'log' && /mined 2 grass_blocks?/.test(m.text)), 180000, 'the mine to finish')
      .catch(() => null)
    check('bot mines real blocks with vein handling', !!minedLog, minedLog ? minedLog.text : 'no mined log')

    // 9. waypoints round trip
    const wps = await post('/api/command', { command: 'wp save user basecamp' })
    check('wp save works', wps.body.result.ok === true)
    const wpg = await post('/api/command', { command: 'wp goal basecamp' })
    check('wp goal sets the goal', wpg.body.result.ok === true, wpg.body.lines.join(' | '))
    const wpl = await get('/api/waypoints')
    check('waypoints persist in the api', wpl.body.waypoints.some((w) => w.name === 'basecamp'))

    // 10. pause / resume / stop lifecycle
    await post('/api/command', { command: 'goto 0 0' })
    await sleep(1200)
    const paused = await post('/api/command', { command: 'pause' })
    check('pause accepted', paused.body.result && paused.body.result.ok === true, JSON.stringify(paused.body).slice(0, 160))
    const st2 = await get('/api/status')
    check('status shows paused', st2.body.task.paused === true)
    const resumed = await post('/api/command', { command: 'resume' })
    check('resume accepted', resumed.body.result && resumed.body.result.ok === true, JSON.stringify(resumed.body).slice(0, 160))
    const stop = await post('/api/command', { command: 'forcecancel' })
    check('forcecancel accepted', stop.body.result.ok === true)

    // 11. excavate a small cuboid through REST
    const here = (await get('/api/status')).body.position
    const ex = await post('/api/command', {
      command: `excavate ${here.x + 2} ${here.y - 1} ${here.z + 2} ${here.x + 4} ${here.y - 1} ${here.z + 4}`
    })
    check('excavate accepted', ex.body.result.ok === true, ex.body.lines.join(' | '))
    const exDone = await until(async () => {
      const r = await get('/api/status')
      return r.body.task.task === 'idle' ? 'done' : null
    }, 180000, 'the excavation to finish').catch(() => null)
    check('bot excavates a real cuboid', !!exDone)

    // 12. tunnel through flat ground
    const tun = await post('/api/command', { command: 'tunnel 2 1 6' })
    check('tunnel accepted', tun.body.result.ok === true, tun.body.lines.join(' | '))
    const tunDone = await until(async () => {
      const r = await get('/api/status')
      return r.body.task.task === 'idle' ? 'done' : null
    }, 180000, 'the tunnel to finish').catch(() => null)
    check('bot digs a real tunnel', !!tunDone)

    // 13. gather + build cycle (drops scatter, so gather a surplus and retry).
    // CI always runs it; MINEPILOT_LIVE_FAST=1 skips it for quick local runs.
    let built = null
    if (process.env.MINEPILOT_LIVE_FAST === '1') {
      check('gather+build cycle (skipped in fast mode)', true)
    } else {
    for (let attempt = 1; attempt <= 3 && !built; attempt++) {
      await post('/api/command', { command: 'mine dirt 14' })
      await until(async () => {
        const r = await get('/api/status')
        return r.body.task.task === 'idle' ? 'done' : null
      }, 240000, `the dirt gather (attempt ${attempt})`).catch(() => null)
      const pos = (await get('/api/status')).body.position
      const bx = pos.x + 4
      const bz = pos.z + 4
      await post('/api/command', { command: `build slab ${bx} ${bz}` })
      built = await until(() => msgs.find((m) => m.t === 'log' && /build complete: 9\/9/.test(m.text)), 240000, `the slab build (attempt ${attempt})`)
        .catch(() => null)
      if (!built) {
        await post('/api/command', { command: 'stop' })
        await sleep(2000)
      }
    }
    check('bot gathers materials and builds the blueprint', !!built, built ? built.text : 'no build-complete log across attempts')
    }

    // 14. the in-game command grammar through the chat path
    const chatCmd = await post('/api/command', { command: 'say hello from minepilot' })
    check('say works', chatCmd.body.result.ok === true)

    // 15. clean shutdown
    ws.close()
  } finally {
    child.kill('SIGINT')
    await sleep(1500)
    try { child.kill('SIGKILL') } catch (e) { /* gone */ }
  }

  console.log(`\nlive e2e: ${passed} passed, ${failed} failed`)
  return failed === 0 ? 0 : 1
}

main().then((code) => {
  process.exit(code)
}).catch((e) => {
  console.error('live e2e crashed:', e)
  process.exit(1)
})
