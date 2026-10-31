'use strict'

// the bot session — connection lifecycle for one mineflayer bot:
// connect with backoff reconnect, auto-respawn, and honest logging.
// version-compat is required BEFORE mineflayer so its protocol overlay
// patches land before any version list or protocol is read.

const versionCompat = require('./version-compat')
const mineflayer = require('mineflayer')
const { Vec3 } = require('vec3')

const BACKOFF_BASE_MS = 2000
const BACKOFF_MAX_MS = 30000

function createBotSession (opts, hooks) {
  const h = hooks || {}
  const log = h.log || (() => {})
  const settings = h.settings || null
  let bot = null
  let stopped = false
  let attempts = 0
  let connectTimer = null

  const wantReconnect = () => (settings ? settings.get('reconnect') : true)
  const backoffCap = () => (settings ? settings.get('reconnectMaxDelayMs') : BACKOFF_MAX_MS)
  let refusalHintShown = false

  function botOpts () {
    const o = {
      host: opts.host,
      port: opts.port,
      username: opts.username,
      auth: opts.auth,
      version: opts.version || false
    }
    if (opts.password) o.password = opts.password
    return o
  }

  function connect () {
    if (stopped) return
    attempts++
    try {
      bot = mineflayer.createBot(botOpts())
    } catch (e) {
      log(`createBot failed: ${String(e.message || e).slice(0, 100)}`)
      scheduleReconnect()
      return
    }
    versionCompat.applyClientCompat(bot, opts.version || null)

    bot.on('spawn', () => {
      attempts = 0
      log(`spawned as ${bot.username} (${bot.version || opts.version || 'auto'})`)
      if (h.onSpawn) h.onSpawn(bot)
    })

    bot.on('end', (reason) => {
      log(`disconnected: ${String(reason || 'no reason').slice(0, 80)}`)
      if (h.onEnd) h.onEnd(bot, reason)
      scheduleReconnect()
    })

    bot.on('kicked', (reason) => {
      log(`kicked: ${String(reason).slice(0, 80)}`)
    })

    bot.on('error', (err) => {
      log(`connection error: ${String(err.message || err).slice(0, 80)}`)
      // refused once means no server is there at all — say what to do
      // about it instead of just backing off in silence. once per session:
      // the hint stays true while the backoff retries.
      if (err && err.code === 'ECONNREFUSED' && !refusalHintShown) {
        refusalHintShown = true
        const local = !opts.host || opts.host === '127.0.0.1' || opts.host === 'localhost'
        log(`  nothing is listening at ${opts.host}:${opts.port} — npm start only connects, it does not boot a server.`)
        if (local) {
          log(`  want a local demo? ./run.sh demo downloads and starts a vanilla server, then joins it.`)
        }
        log(`  pointing at your server? MINEPILOT_HOST=<ip> MINEPILOT_PORT=<port> ./run.sh connect`)
      }
    })

    bot.on('death', () => {
      if (h.onDeath) h.onDeath(bot)
      if (settings ? settings.get('autoRespawn') : true) {
        setTimeout(() => {
          try { bot.respawn() } catch (e) { /* already gone */ }
        }, 1500)
      }
    })
    return bot
  }

  function scheduleReconnect () {
    if (stopped || !wantReconnect()) return
    if (connectTimer) return
    const delay = Math.min(backoffCap(), BACKOFF_BASE_MS * Math.pow(2, Math.min(attempts, 6)))
    log(`reconnecting in ${Math.round(delay / 1000)}s (attempt ${attempts + 1})`)
    connectTimer = setTimeout(() => {
      connectTimer = null
      connect()
    }, delay)
    if (connectTimer.unref) connectTimer.unref()
  }

  function stop () {
    stopped = true
    if (connectTimer) {
      clearTimeout(connectTimer)
      connectTimer = null
    }
    if (bot) {
      try { bot.quit() } catch (e) { /* ignore */ }
    }
  }

  connect()

  return {
    get bot () { return bot },
    connect,
    stop
  }
}

module.exports = { createBotSession, BACKOFF_BASE_MS, BACKOFF_MAX_MS, Vec3 }
