'use strict'

// minepilot — one mineflayer bot, full control.
//
//   node src/index.js [--host 127.0.0.1] [--port 25565] [--name Minepilot]
//                     [--version 1.21.8] [--auth offline] [--app-port 3000]
//
// boots the bot session, wires the autopilot + managers + chat control,
// and reads commands from stdin until Ctrl-C. the web console lands with
// the server phase and will share the exact same command executor.

const { loadConfig } = require('./config')
const { createDefaultSettings } = require('./settings')
const { Autopilot } = require('./autopilot')
const { WaypointStore } = require('./waypoints')
const { SelectionManager } = require('./selection')
const { createBotSession } = require('./bot')
const { createChatControl } = require('./chatcontrol')
const { executeCommand } = require('./commandexec')
const { MapView } = require('./mapview')
const { createCockpitServer } = require('./server')
const { createBrain } = require('./brain')
const inventory = require('./inventory')
const VERSION = require('../package.json').version

const HOSTILES = /zombie|skeleton|creeper|spider|cave_spider|enderman|witch|blaze|ghast|slime|magma_cube|pillager|vindicator|evoker|ravager|phantom|drowned|husk|stray|wither_skeleton|piglin|hoglin|zoglin|warden|breeze|bogged/

function main () {
  const config = loadConfig()
  const settings = createDefaultSettings()
  const waypoints = new WaypointStore()
  const selection = new SelectionManager()

  let pilot = null
  let chat = null
  let autoEatTimer = null
  let mapview = null

  const log = (text) => {
    const t = new Date().toISOString().slice(11, 19)
    console.log(`[${t}] ${text}`)
  }

  const ctx = {
    pilot: null,
    bot: null,
    settings,
    selection,
    waypoints,
    reply: (text) => log(text),
    source: 'console',
    commander: null,
    exploreFilter: null
  }

  // ------------------------------------------------------------- web console
  // the mapview rides on ctx: it is created when the bot spawns and
  // swapped out on disconnect (the cockpit reads ctx.mapview lazily)
  ctx.mapview = {
    stats: () => ({ chunks: 0, dirty: 0 }),
    viewport: () => [],
    drainDirty: () => [],
    topOf: () => null,
    chunkPayload: () => null,
    cache: { clear () {} }
  }
  const cockpit = createCockpitServer(ctx)
  cockpit.listen(config.appPort).then((addr) => {
    log(`web cockpit: http://127.0.0.1:${addr.port}`)
  }).catch((e) => log(`web cockpit failed to start: ${e.message}`))

  // the full-auto survival brain — one instance for the whole session;
  // it reads ctx.bot / ctx.pilot lazily so respawns just work
  const brain = createBrain(ctx, { log })
  ctx.brain = brain
  brain.start(1200)
  if (settings.get('autoSurvival')) brain.setEnabled(true)

  const session = createBotSession(config, {
    settings,
    log,
    onSpawn (bot) {
      ctx.bot = bot
      if (pilot) {
        try { pilot.dispose() } catch (e) { /* ignore */ }
      }
      pilot = new Autopilot({ bot, deps: { Vec3: require('vec3') }, settings })
      ctx.pilot = pilot
      pilot.on('log', (text) => log(text))
      pilot.on('task', () => {
        // quiet: the web console and #proc expose the live state
      })
      if (chat) {
        try { chat.dispose() } catch (e) { /* ignore */ }
      }
      chat = createChatControl(ctx)
      try { if (mapview) mapview.dispose() } catch (e) { /* ignore */ }
      mapview = new MapView(bot, settings)
      ctx.mapview = mapview
      cockpit.wireBot(bot)
      startAutoEat(bot)
      startAutoDefend()
      if (settings.get('autoSurvival') && !brain.status().on) brain.setEnabled(true)
      log(`minepilot ${VERSION} ready — type commands ("help") or chat "#help" in game`)
      log(`cockpit map: left click = goto, drag = selection, wheel = zoom`)
      if (settings.get('autoSurvival')) log(`full-auto is ON (#auto off to stop)`)
    },
    onDeath (bot) {
      if (settings.get('deathWaypoints') && bot.entity && bot.entity.position) {
        const p = bot.entity.position
        waypoints.death({ x: p.x, y: p.y, z: p.z })
        log('death waypoint saved')
      }
    },
    onEnd () {
      if (pilot) {
        try { pilot.dispose() } catch (e) { /* ignore */ }
        pilot = null
        ctx.pilot = null
      }
      if (ctx.stations) {
        try { ctx.stations.reset() } catch (e) { /* ignore */ }
      }
      try { brain.dispose() } catch (e) { /* ignore */ }
      if (chat) {
        try { chat.dispose() } catch (e) { /* ignore */ }
        chat = null
      }
      if (autoEatTimer) {
        clearInterval(autoEatTimer)
        autoEatTimer = null
      }
      if (autoDefendTimer) {
        clearInterval(autoDefendTimer)
        autoDefendTimer = null
      }
    }
  })

  function startAutoEat (bot) {
    if (autoEatTimer) clearInterval(autoEatTimer)
    autoEatTimer = setInterval(async () => {
      if (!settings.get('autoEat')) return
      if (!ctx.bot || !ctx.bot.food || ctx.bot.food > settings.get('autoEatThreshold')) return
      const r = await inventory.eatOnce(ctx.bot)
      if (r.ok) log(r.reply)
    }, 4000)
    if (autoEatTimer.unref) autoEatTimer.unref()
  }

  // autoDefend: slimes happen. a hostile within sword reach interrupts
  // whatever is running (a dead bot loses the task anyway).
  let defendBusy = false
  function startAutoDefend () {
    if (autoDefendTimer) clearInterval(autoDefendTimer)
    autoDefendTimer = setInterval(async () => {
      if (!settings.get('autoDefend')) return
      if (!ctx.bot || !ctx.pilot || defendBusy) return
      const p = ctx.bot.entity && ctx.bot.entity.position
      if (!p) return
      let threat = null
      let bestD = Infinity
      try {
        for (const e of Object.values(ctx.bot.entities || {})) {
          if (!e || !e.position || e === ctx.bot.entity) continue
          const n = String(e.name || e.type || '')
          if (!HOSTILES.test(n)) continue
          const d = e.position.distanceTo(p)
          if (d < bestD) { bestD = d; threat = e }
        }
      } catch (e) { return }
      if (!threat || bestD > 4.5) return
      defendBusy = true
      const target = threat.name || threat.type
      log(`autoDefend: ${target} at ${bestD.toFixed(1)} blocks — fighting back`)
      try {
        const { runCombat } = require('./processes/combat')
        await runCombat(ctx.pilot, target, () => true)
      } catch (e) { /* it died or vanished */ }
      defendBusy = false
    }, 1500)
    if (autoDefendTimer.unref) autoDefendTimer.unref()
  }
  let autoDefendTimer = null

  // ---------------------------------------------------------------- stdin
  const readline = require('readline')
  const rl = readline.createInterface({ input: process.stdin, prompt: 'minepilot> ' })
  rl.on('line', (line) => {
    const text = line.trim()
    if (text === '') return
    if (text === 'quit' || text === 'exit') {
      shutdown()
      return
    }
    if (!ctx.bot || !ctx.pilot) {
      log('not connected yet — commands will work once the bot spawns')
      return
    }
    executeCommand(text, ctx)
      .then((r) => { if (r && r.ok && r.reply) log(r.reply) })
      .catch((e) => log(`command error: ${String(e.message || e).slice(0, 100)}`))
  })
  // Ctrl-D on a real terminal quits. a closed stdin that was never a tty
  // (CI runners, nohup, systemd, spawn pipes) must NOT kill the stack —
  // the cockpit and the bot are services, not the stdin's dependents.
  rl.on('close', () => {
    if (process.stdin.isTTY) {
      shutdown()
      return
    }
    log('stdin closed — the cockpit keeps running (Ctrl-C stops everything)')
  })

  function shutdown () {
    log('shutting down…')
    if (pilot) {
      try { pilot.stop() } catch (e) { /* ignore */ }
    }
    session.stop()
    waypoints.save()
    process.exit(0)
  }

  process.on('SIGINT', () => shutdown())
  process.on('SIGTERM', () => shutdown())

  log(`minepilot ${VERSION} — connecting to ${config.host}:${config.port} as ${config.username}`)
  rl.prompt()
}

if (require.main === module) {
  main()
}

module.exports = { main }
