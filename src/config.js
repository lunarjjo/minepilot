'use strict'

// runtime configuration — environment first, CLI flags second, one shape.
//   MINEPILOT_HOST, MINEPILOT_PORT, MINEPILOT_USERNAME, MINEPILOT_VERSION,
//   MINEPILOT_AUTH (offline|microsoft), MINEPILOT_PASSWORD, APP_PORT
// flags: --host x --port n --name bot --version 1.21.8 --auth offline
//        --app-port n

function parseArgs (argv) {
  const out = {}
  const args = argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = args[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next
      i++
    } else {
      out[key] = true
    }
  }
  return out
}

function loadConfig (env, argv) {
  const e = env || process.env
  const flags = parseArgs(argv || process.argv)

  const config = {
    host: flags.host || e.MINEPILOT_HOST || '127.0.0.1',
    port: Number(flags.port || e.MINEPILOT_PORT || 25565),
    username: flags.name || e.MINEPILOT_USERNAME || e.BOT_USERNAME || 'Minepilot',
    version: flags.version || e.MINEPILOT_VERSION || e.MC_VERSION || null,
    auth: flags.auth || e.MINEPILOT_AUTH || 'offline',
    password: flags.password || e.MINEPILOT_PASSWORD || null,
    appPort: Number(flags['app-port'] || e.APP_PORT || 3000),
    dataDir: e.MINEPILOT_DATA_DIR || process.cwd()
  }
  if (!Number.isFinite(config.port) || config.port < 1 || config.port > 65535) config.port = 25565
  if (!Number.isFinite(config.appPort) || config.appPort < 1 || config.appPort > 65535) config.appPort = 3000
  if (config.username === true) config.username = 'Minepilot'
  config.username = String(config.username).slice(0, 16)
  if (config.version === true) config.version = null
  if (config.auth !== 'offline' && config.auth !== 'microsoft') config.auth = 'offline'
  return config
}

module.exports = { loadConfig, parseArgs }
