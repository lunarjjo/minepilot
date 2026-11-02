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

    // 4. the map streams real chunks (viewport centered on the bot — a
    //    reused world may have it logged out far from spawn)
    const spawnNode = (await get('/api/status')).body.position
    const bcx = Math.floor(spawnNode.x / 16)
    const bcz = Math.floor(spawnNode.z / 16)
    ws.send(JSON.stringify({ t: 'viewport', cx0: bcx - 2, cz0: bcz - 2, cx1: bcx + 2, cz1: bcz + 2 }))
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
    // the build anchors on the bot's feet level, so the bot first walks to
    // the build column — fresh surface, not the bottom of a dig pit.
    let built = null
    if (process.env.MINEPILOT_LIVE_FAST === '1') {
      check('gather+build cycle (skipped in fast mode)', true)
    } else {
    for (let attempt = 1; attempt <= 3 && !built; attempt++) {
      await post('/api/command', { command: 'mine dirt 20' })
      await until(async () => {
        const r = await get('/api/status')
        return r.body.task.task === 'idle' ? 'done' : null
      }, 240000, `the dirt gather (attempt ${attempt})`).catch(() => null)
      const pos = (await get('/api/status')).body.position
      const bx = pos.x + 6
      const bz = pos.z + 6
      await post('/api/command', { command: `goto ${bx} ${bz}` })
      await until(async () => {
        const r = await get('/api/status')
        return r.body.task.task === 'idle' ? 'done' : null
      }, 120000, `the walk to the build site (attempt ${attempt})`).catch(() => null)
      await post('/api/command', { command: `build slab ${bx + 2} ${bz + 2}` })
      built = await until(() => msgs.find((m) => m.t === 'log' && /build complete: 9\/9/.test(m.text)), 240000, `the slab build (attempt ${attempt})`)
        .catch(() => null)
      if (!built) {
        await post('/api/command', { command: 'stop' })
        await sleep(2000)
      }
    }
    check('bot gathers materials and builds the blueprint', !!built, built ? built.text : 'no build-complete log across attempts')
    }

    // 14. the workstation gui layer: recipes, crafting, chest + furnace
    //    windows driven the way the cockpit drives them. /clear first —
    //    leftovers from the gather checks make the craft assertions
    //    nondeterministic (a full inventory refuses to craft)
    const give = async (item, n) => post('/api/command', { command: `say /give ${BOT_NAME} ${item} ${n}` })
    const invCount = async (name) => {
      const r = await get('/api/inventory')
      const it = r.body.items.find((i) => i.name === name)
      return it ? it.count : 0
    }
    // worldgen does not owe a blind cell pick an anchor face: a cell that
    // floats in the air has nothing solid to click against and the build
    // reports stuck with anchors=0. a player shifts to another patch of
    // ground and tries again — so does the test.
    const shiftSpot = async () => {
      const p = (await get('/api/status')).body.position
      await post('/api/command', { command: `goto ${p.x + 12} ${p.z}` })
      await until(async () => {
        const r = await get('/api/status')
        return r.body.task.task === 'idle' ? 'done' : null
      }, 120000, 'the walk to another spot').catch(() => null)
    }
    const fillCell = async (dx, kind, dz = 0) => {
      const p = (await get('/api/status')).body.position
      ws.send(JSON.stringify({ t: 'select', x0: p.x + dx, y0: p.y, z0: p.z + dz, x1: p.x + dx, y1: p.y, z1: p.z + dz }))
      await sleep(400)
      const r = await post('/api/command', { command: `sel fill ${kind}` })
      await until(async () => {
        const r2 = await get('/api/status')
        return r2.body.task.task === 'idle' ? 'done' : null
      }, 120000, `the ${kind} placement`).catch(() => null)
      await post('/api/command', { command: 'sel clear' })
      return r.body.result.ok === true
    }
    await post('/api/command', { command: 'say /clear' })
    await until(async () => (await get('/api/inventory')).body.items.length === 0, 20000, 'the clear').catch(() => null)
    await give('oak_log', 8)
    await until(async () => (await invCount('oak_log')) >= 8, 20000, 'oak logs to arrive').catch(() => null)
    check('op /give stocks the bot through the chat path', (await invCount('oak_log')) >= 8)

    const rp = await get('/api/recipes?q=planks')
    const planksEntry = rp.body.recipes.find((e) => e.name === 'oak_planks')
    check('recipes api lists oak_planks as craftable from logs', planksEntry && planksEntry.craftable === true,
      planksEntry ? JSON.stringify(planksEntry.ingredients) : 'not listed')

    const cr = await post('/api/command', { command: 'craft oak_planks 8' })
    check('craft command accepted', cr.body.result.ok === true, cr.body.lines.join(' | '))
    await until(async () => (await invCount('oak_planks')) >= 8, 60000, 'the planks craft').catch(() => null)
    check('bot crafts real planks from logs', (await invCount('oak_planks')) >= 8, `planks: ${await invCount('oak_planks')}`)

    const rp2 = await get('/api/recipes?q=crafting_table')
    const tableEntry = rp2.body.recipes.find((e) => e.name === 'crafting_table')
    check('crafting_table flips to craftable once planks exist', tableEntry && tableEntry.craftable === true)

    // a chest placed beside the bot on FRESH ground, driven through the
    // station protocol. (placement needs a solid anchor face — the dig pit
    // from the excavate check has none, so walk to untouched surface first,
    // exactly what a player would do)
    const fresh = await post('/api/command', { command: `goto ${(await get('/api/status')).body.position.x + 30} ${(await get('/api/status')).body.position.z + 6}` })
    check('walk to fresh ground accepted', fresh.body.result.ok === true, fresh.body.lines.join(' | '))
    await until(async () => {
      const r = await get('/api/status')
      return r.body.task.task === 'idle' ? 'done' : null
    }, 120000, 'the walk to fresh ground').catch(() => null)
    const pos1 = (await get('/api/status')).body.position
    await give('chest', 1)
    await until(async () => (await invCount('chest')) >= 1, 20000, 'the chest item').catch(() => null)
    // up to three patches of ground: the first pick may have no anchor face
    let fillChestOk = false
    let chestFrame = null
    for (let attempt = 0; attempt < 3 && !chestFrame; attempt++) {
      if (attempt > 0) await shiftSpot()
      fillChestOk = await fillCell(2, 'chest')
      ws.send(JSON.stringify({ t: 'station:open', kind: 'chest' }))
      chestFrame = await until(() => msgs.find((m) => m.t === 'station' && m.open && m.kind === 'chest'), 15000, 'the chest station frame')
        .catch(() => null)
    }
    check('sel fill places the chest', fillChestOk, 'command refused')
    check('chest opens through the station protocol', !!chestFrame, chestFrame ? 'opened' : 'no frame')
    if (chestFrame) {
      const dep = await post('/api/station', { action: 'deposit', name: 'oak_planks', count: 8 })
      check('deposit moves planks into the chest', dep.body.ok === true, JSON.stringify(dep.body))
      const chestNow = await until(async () => {
        const r = await get('/api/station')
        const it = (r.body.items || []).find((i) => i.name === 'oak_planks')
        return it && it.count >= 8 ? it : null
      }, 20000, 'the chest frame to show the planks').catch(() => null)
      check('chest frame shows the deposited stack', !!chestNow)
      // the live inventory view (through the open window) drops by 8
      const planksAfterDeposit = await invCount('oak_planks')
      const wd = await post('/api/station', { action: 'withdraw', name: 'oak_planks', count: 4 })
      check('withdraw pulls planks back', wd.body.ok === true, JSON.stringify(wd.body))
      await until(async () => (await invCount('oak_planks')) > planksAfterDeposit, 20000, 'the withdraw').catch(() => null)
      check('bot inventory reflects the withdrawal', (await invCount('oak_planks')) > planksAfterDeposit,
        `stuck at ${await invCount('oak_planks')} after deposit left ${planksAfterDeposit}`)
      await post('/api/station', { action: 'close' })
    }

    // a furnace: smelt a real log into charcoal with a real coal (logs were
    // consumed by the planks craft — restock)
    await give('oak_log', 4)
    await until(async () => (await invCount('oak_log')) >= 1, 20000, 'logs restocked').catch(() => null)
    const fresh2 = await post('/api/command', { command: `goto ${(await get('/api/status')).body.position.x - 30} ${(await get('/api/status')).body.position.z - 6}` })
    await until(async () => {
      const r = await get('/api/status')
      return r.body.task.task === 'idle' ? 'done' : null
    }, 120000, 'the walk to the furnace spot').catch(() => null)
    await give('furnace', 1)
    await give('coal', 4)
    await until(async () => (await invCount('furnace')) >= 1 && (await invCount('coal')) >= 4, 20000, 'the furnace + coal').catch(() => null)
    let fillFurnaceOk = false
    let furnaceFrame = null
    for (let attempt = 0; attempt < 3 && !furnaceFrame; attempt++) {
      if (attempt > 0) await shiftSpot()
      fillFurnaceOk = await fillCell(-2, 'furnace')
      ws.send(JSON.stringify({ t: 'station:open', kind: 'furnace' }))
      furnaceFrame = await until(() => msgs.find((m) => m.t === 'station' && m.open && m.kind === 'furnace'), 15000, 'the furnace station frame')
        .catch(() => null)
    }
    check('sel fill places the furnace', fillFurnaceOk, 'command refused')
    check('furnace opens through the station protocol', !!furnaceFrame)
    if (furnaceFrame) {
      const pi = await post('/api/station', { action: 'put', role: 'input', name: 'oak_log', count: 1 })
      const pf = await post('/api/station', { action: 'put', role: 'fuel', name: 'coal', count: 1 })
      check('furnace takes smelt + fuel items', pi.body.ok === true && pf.body.ok === true, JSON.stringify([pi.body, pf.body]))
      const cooked = await until(async () => {
        const r = await get('/api/station')
        return r.body.output && r.body.output.name === 'charcoal' ? r.body : null
      }, 180000, 'the log to smelt into charcoal').catch(() => null)
      check('furnace really smelts log -> charcoal', !!cooked, cooked ? 'charcoal out' : 'no output')
      if (cooked) {
        const tk = await post('/api/station', { action: 'take', role: 'output' })
        check('take output collects the charcoal', tk.body.ok === true, JSON.stringify(tk.body))
        await until(async () => (await invCount('charcoal')) >= 1, 25000, 'the charcoal').catch(() => null)
        check('charcoal lands in the inventory', (await invCount('charcoal')) >= 1,
          'inv: ' + JSON.stringify((await get('/api/inventory')).body.items) + ' station: ' + JSON.stringify(await get('/api/station')).slice(0, 200))
      }
      await post('/api/station', { action: 'close' })
    }

    // 15. advanced interactions: feed, breed, activate a lever, sleep
    const pos3 = (await get('/api/status')).body.position
    await post('/api/command', { command: 'say /summon cow ' + Math.floor(pos3.x + 2) + ' ' + Math.floor(pos3.y) + ' ' + Math.floor(pos3.z + 1) })
    await post('/api/command', { command: 'say /summon cow ' + Math.floor(pos3.x - 2) + ' ' + Math.floor(pos3.y) + ' ' + Math.floor(pos3.z - 1) })
    await give('wheat', 8)
    await until(async () => (await invCount('wheat')) >= 8, 20000, 'wheat').catch(() => null)
    const cowSeen = await until(() => msgs.find((m) => m.t === 'entities' && m.entities.some((e) => e.type === 'cow')), 20000, 'the cows to appear').catch(() => null)
    check('summoned cows appear in the entity feed', !!cowSeen)
    const feed = await post('/api/command', { command: 'feed cow' })
    check('feed accepted', feed.body.result.ok === true, feed.body.lines.join(' | '))
    await until(async () => (await invCount('wheat')) <= 7, 20000, 'the wheat to be eaten').catch(() => null)
    check('feeding consumes the breeding food', (await invCount('wheat')) <= 7, `wheat: ${await invCount('wheat')}`)
    const breed = await post('/api/command', { command: 'breed cow' })
    check('breed accepted', breed.body.result.ok === true, breed.body.lines.join(' | '))
    await until(async () => (await invCount('wheat')) <= 6, 20000, 'the breed feeds').catch(() => null)
    // one wheat per accepted feed: the standalone feed already put one
    // cow in love mode, so breed's first right-click on it is a vanilla
    // no-op — two feeds consumed in total is the correct outcome
    check('breeding reaches both cows', (await invCount('wheat')) <= 6, `wheat: ${await invCount('wheat')}`)

    // a lever placed and flipped through activate
    await give('lever', 1)
    await until(async () => (await invCount('lever')) >= 1, 20000, 'the lever item').catch(() => null)
    let fillLeverOk = false
    let leverSeen = false
    for (let attempt = 0; attempt < 3 && !leverSeen; attempt++) {
      if (attempt > 0) await shiftSpot()
      fillLeverOk = await fillCell(1, 'lever')
      const f = await post('/api/command', { command: 'find lever' })
      leverSeen = f.body.result.ok === true
    }
    check('sel fill places the lever', fillLeverOk && leverSeen, 'no lever near the bot')
    const act = await post('/api/command', { command: 'activate lever' })
    check('activate flips the lever', act.body.result.ok === true, act.body.lines.join(' | '))

    // sleep: a complete bed via /setblock (a bed item's two-cell placement
    // is its own adventure; the product path under test is walk + sleep),
    // turn the world to night, sleep, wake
    const pos5 = (await get('/api/status')).body.position
    const bx = Math.floor(pos5.x) + 1
    const bz = Math.floor(pos5.z)
    const by = Math.floor(pos5.y)
    await post('/api/command', { command: `say /setblock ${bx} ${by} ${bz} red_bed[part=foot,facing=east]` })
    await post('/api/command', { command: `say /setblock ${bx + 1} ${by} ${bz} red_bed[part=head,facing=east]` })
    await sleep(1000)
    const bedFound = await until(async () => {
      const r = await post('/api/command', { command: 'find red_bed' })
      return r.body.result.ok ? r.body : null
    }, 20000, 'the bed to exist').catch(() => null)
    check('bed placed via setblock', !!bedFound, bedFound ? bedFound.lines.join(' | ') : 'not found')
    await post('/api/command', { command: 'say /time set night' })
    await sleep(1000)
    const sleepCmd = await post('/api/command', { command: 'sleep' })
    check('sleep accepted at night', sleepCmd.body.result.ok === true,
      JSON.stringify(sleepCmd.body.result).slice(0, 160))
    if (sleepCmd.body.result.ok) {
      // dawn wakes a sleeper automatically — set the day AFTER asserting
      // sleep, and accept "not sleeping" from wake as "already up"
      const wakeCmd = await post('/api/command', { command: 'wake' })
      const up = wakeCmd.body.result.ok || /not sleeping/.test(wakeCmd.body.result.error || '')
      check('wake gets the bot up', up, JSON.stringify(wakeCmd.body.result).slice(0, 140))
      await post('/api/command', { command: 'say /time set day' })
      await sleep(1000)
    }

    // 16. full-auto: the survival brain takes the bot from logs to dinner
    await post('/api/command', { command: 'say /clear' })
    await until(async () => (await get('/api/inventory')).body.items.length === 0, 20000, 'the clear').catch(() => null)
    await give('oak_log', 16)
    await until(async () => (await invCount('oak_log')) >= 16, 20000, 'logs').catch(() => null)
    const autoOn = await post('/api/command', { command: 'auto on' })
    check('auto on accepted', autoOn.body.result.ok === true, autoOn.body.lines.join(' | '))
    const autoState = await until(async () => {
      const r = await get('/api/status')
      return r.body.task && r.body.task.task !== 'idle' ? r.body : null
    }, 60000, 'the brain to start working').catch(() => null)
    check('the brain takes over without commands', !!autoState, autoState ? autoState.task.task : 'never started')
    await until(async () => (await invCount('wooden_pickaxe')) >= 1, 240000, 'the wooden pickaxe').catch(() => null)
    check('full-auto: logs -> planks -> table -> wooden pickaxe', (await invCount('wooden_pickaxe')) >= 1,
      'inv: ' + JSON.stringify((await get('/api/inventory')).body.items.map((i) => i.name + 'x' + i.count)))
    // stock the furnace phase: cobble + coal + raw meat, then let it cook
    await give('cobblestone', 20)
    await give('coal', 4)
    await give('raw_beef', 3)
    await until(async () => (await invCount('cooked_beef')) >= 1, 300000, 'the cooked beef').catch(() => null)
    check('full-auto: crafts a furnace and cooks raw beef', (await invCount('cooked_beef')) >= 1,
      'inv: ' + JSON.stringify((await get('/api/inventory')).body.items.map((i) => i.name + 'x' + i.count)).slice(0, 200))
    const autoOff = await post('/api/command', { command: 'auto off' })
    check('auto off accepted', autoOff.body.result.ok === true)

    // 17. the in-game command grammar through the chat path
    const chatCmd = await post('/api/command', { command: 'say hello from minepilot' })
    check('say works', chatCmd.body.result.ok === true)

    // 18. clean shutdown
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
