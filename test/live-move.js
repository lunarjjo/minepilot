'use strict'

// the focused live suite for the baritone-grade movement overhaul: each
// check maps to a field report from the owner — "tersangkut", "terjun
// bebas", "salah jalan", "tidak mengerti ketinggian", "break block
// terburu-buru", "full auto tidak bergerak". run with:
//
//   MINEPILOT_LIVE_E2E=1 MC_HOST=127.0.0.1 MC_PORT=25565 MC_VERSION=1.21.8 \
//     APP_PORT=3119 node test/live-move.js
//
// requires an op'd bot on the server (scripts/e2e-server.sh arranges it).
// each phase stages on its own far-apart X strip via /tp so nothing a
// phase builds can interfere with the next one.

const { spawn } = require('child_process')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const APP_PORT = Number(process.env.APP_PORT || 3119)
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
    console.log(`  FAIL  ${name}${detail ? ' — ' + String(detail).slice(0, 220) : ''}`)
  }
}

async function cmd (command) {
  const r = await post('/api/command', { command })
  return r.body
}

async function invCount (name) {
  const r = await get('/api/inventory')
  const it = (r.body.items || []).find((i) => i.name === name)
  return it ? it.count : 0
}

async function waitTaskIdle (ms) {
  return until(async () => {
    const r = await get('/api/status')
    return r.body.task && r.body.task.task === 'idle' ? r.body : null
  }, ms, 'the task to go idle').catch(() => null)
}

async function main () {
  if (process.env.MINEPILOT_LIVE_E2E !== '1') {
    console.log('MINEPILOT_LIVE_E2E != 1 — live-move suite skipped')
    return 0
  }
  console.log(`live-move e2e: bot -> ${MC_HOST}:${MC_PORT} (mc ${MC_VERSION}), cockpit on :${APP_PORT}`)

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
  child.stdout.on('data', (d) => {
    const text = String(d).trim()
    if (text) console.log('  [stack] ' + text)
  })
  child.stderr.on('data', (d) => console.error('  [stack!] ' + String(d).trim()))

  try {
    await until(async () => {
      try { return await get('/api/health') } catch (e) { return null }
    }, 30000, 'the cockpit to start')
    await until(async () => {
      const r = await get('/api/status')
      return r.body.connected ? r.body : null
    }, 90000, 'the bot to spawn')
    check('bot connects and spawns', true)

    const give = async (item, n) => cmd(`say /give ${BOT_NAME} ${item} ${n}`)
    // stage the bot on a strip of pristine superflat (feet level -60)
    const tp = async (x) => {
      await cmd(`say /tp ${BOT_NAME} ${x} -59.5 0`)
      await sleep(1500)
    }
    const st = async () => (await get('/api/status')).body.position

    // ---------------------------------------------------------- 1. speed
    // a 60-block flat goto: sprint + bunny-hop should land under the
    // walking pace ceiling (60 / 4.3 = 14s; sprint-jump pace ~7 m/s)
    await tp(100)
    const t0 = Date.now()
    const g1 = await cmd('goto 160 -60 0')
    check('goto 60 blocks accepted', g1.result.ok === true, (g1.lines || []).join(' | '))
    const arrived1 = await waitTaskIdle(60000)
    const secs = (Date.now() - t0) / 1000
    const p1 = await st()
    check('60-block goto arrives', !!arrived1 && Math.abs(p1.x - 160) < 3 && Math.abs(p1.z) < 3,
      `at ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} ${p1.z.toFixed(1)}`)
    check(`60 blocks in ${secs.toFixed(1)}s (walk pace would be 14s)`, secs < 14, `${secs.toFixed(1)}s`)

    // ------------------------------------------------------- 2. bridging
    // carve a trench on the 300 strip: 8 wide, through the full ground
    // column — crossing alive requires placed blocks
    await tp(300)
    await cmd('say /fill 304 -64 -2 311 -61 2 air')
    await sleep(1200)
    await give('cobblestone', 64)
    await until(async () => (await invCount('cobblestone')) >= 64, 20000, 'cobble').catch(() => null)
    const g2 = await cmd('goto 320 -60 0')
    check('goto across the trench accepted', g2.result.ok === true, (g2.lines || []).join(' | '))
    const arrived2 = await waitTaskIdle(120000)
    const p2 = await st()
    check('bridges the 8-wide trench', !!arrived2 && Math.abs(p2.x - 320) < 3 && Math.abs(p2.z) < 3 && p2.y > -61.5,
      `at ${p2.x.toFixed(1)} ${p2.y.toFixed(1)} ${p2.z.toFixed(1)}`)

    // ------------------------------------------------------- 3. climbing
    // a 3-high dirt hill on the 400 strip: pillar/ascendPlace/diagonal
    // ascend must put the bot on top — "tidak mengerti ketinggian"
    await tp(400)
    await cmd('say /fill 404 -60 -2 406 -58 2 dirt')
    await sleep(1200)
    const g3 = await cmd('goto 405 -57 0')
    check('goto onto the 3-high hill accepted', g3.result.ok === true, (g3.lines || []).join(' | '))
    const arrived3 = await waitTaskIdle(120000)
    const p3 = await st()
    check('climbs the 3-high hill (height-aware)', !!arrived3 && Math.abs(p3.x - 405) < 2.5 && p3.y >= -58.5,
      `at ${p3.x.toFixed(1)} ${p3.y.toFixed(1)} ${p3.z.toFixed(1)}`)

    // ------------------------------------------------------- 4. digging
    // dig straight down through the natural ground column (grass, 2 dirt)
    // to stand on bedrock — digFall, one block per break, no fall damage
    await tp(500)
    const g4 = await cmd('goto 504 -63 0')
    check('goto down the shaft accepted', g4.result.ok === true, (g4.lines || []).join(' | '))
    const arrived4 = await waitTaskIdle(90000)
    const p4 = await st()
    check('digs straight down to bedrock level', !!arrived4 && Math.abs(p4.x - 504) < 2 && p4.y <= -62.2,
      `at ${p4.x.toFixed(1)} ${p4.y.toFixed(1)} ${p4.z.toFixed(1)} (bedrock floor at -63)`)

    // ---------------------------------------- 5. full-auto + disconnect
    // THE owner report: after any disconnect, full-auto never moved again.
    // stock logs, start full-auto, verify it works, KICK the bot with a
    // same-name login, wait for the reconnect, and verify the brain is
    // still alive and producing on the clean 600 strip.
    await tp(600)
    await cmd('say /clear')
    await until(async () => (await get('/api/inventory')).body.items.length === 0, 20000, 'the clear').catch(() => null)
    // bread keeps the food reflex quiet so the TOOL ladder is the path
    // under test (a wandering cow would otherwise correctly win the
    // decision — hunting IS the right call on an empty stomach)
    await give('bread', 5)
    await give('oak_log', 8)
    await until(async () => (await invCount('oak_log')) >= 8, 20000, 'logs').catch(() => null)
    const autoOn = await cmd('auto on')
    check('auto on accepted', autoOn.result.ok === true, (autoOn.lines || []).join(' | '))
    const brainWorking = await until(async () => {
      const r = await get('/api/status')
      return r.body.task && r.body.task.task !== 'idle' ? r.body : null
    }, 90000, 'the brain to start working').catch(() => null)
    check('full-auto starts working', !!brainWorking, brainWorking ? brainWorking.task.task : 'never started')

    // the kick: a same-name second login displaces the stack's bot
    const kickBot = spawn(process.execPath, ['-e', `
      const mineflayer = require('mineflayer')
      const b = mineflayer.createBot({ host: '${MC_HOST}', port: ${MC_PORT}, username: '${BOT_NAME}', auth: 'offline', version: '${MC_VERSION}' })
      b.once('login', () => setTimeout(() => { try { b.quit() } catch (e) {} process.exit(0) }, 1500))
      setTimeout(() => process.exit(0), 15000)
    `], { cwd: ROOT, stdio: 'ignore' })
    await new Promise((resolve) => kickBot.on('exit', resolve))
    const reconnected = await until(async () => {
      const r = await get('/api/status')
      return r.body.connected ? r.body : null
    }, 90000, 'the bot to reconnect after the kick')
    check('bot reconnects after being kicked', !!reconnected)

    // the regression: the brain must STILL be alive after the reconnect.
    // the old code disposed it on 'end' — status showed ON forever while
    // the bot never moved again. logs in, planks/table/pickaxe out.
    await cmd(`say /tp ${BOT_NAME} 620 -59.5 0`)
    await sleep(1500)
    await give('bread', 5)
    await give('oak_log', 16)
    const produced = await until(async () => {
      const planks = await invCount('oak_planks')
      const table = await invCount('crafting_table')
      const pick = await invCount('wooden_pickaxe')
      return (planks + table + pick) > 0 ? { planks, table, pick } : null
    }, 180000, 'the brain to produce something after the reconnect').catch(() => null)
    const statusAfter = (await get('/api/status')).body
    check('full-auto STILL works after a disconnect', !!produced,
      produced ? `planks=${produced.planks} table=${produced.table} pick=${produced.pick}`
        : `task=${statusAfter.task && statusAfter.task.task} — the brain is dead`)
    const autoOff = await cmd('auto off')
    check('auto off accepted', autoOff.result.ok === true)
  } finally {
    child.kill('SIGINT')
    await sleep(1500)
    try { child.kill('SIGKILL') } catch (e) { /* gone */ }
  }

  console.log(`\nlive-move e2e: ${passed} passed, ${failed} failed`)
  return failed === 0 ? 0 : 1
}

main().then((code) => {
  process.exit(code)
}).catch((e) => {
  console.error('live-move e2e crashed:', e)
  process.exit(1)
})
