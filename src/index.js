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
const inventory = require('./inventory')
const VERSION = require('../package.json').version

function main () {
  const config = loadConfig()
  const settings = createDefaultSettings()
  const waypoints = new WaypointStore()
  const selection = new SelectionManager()

  let pilot = null
  let chat = null
  let autoEatTimer = null

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
      startAutoEat(bot)
      log(`minepilot ${VERSION} ready — type commands ("help") or chat "#help" in game`)
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
      if (chat) {
        try { chat.dispose() } catch (e) { /* ignore */ }
        chat = null
      }
      if (autoEatTimer) {
        clearInterval(autoEatTimer)
        autoEatTimer = null
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
  rl.on('close', () => shutdown())

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
