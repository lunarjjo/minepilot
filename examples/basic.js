'use strict'

// use minepilot as a library: drive one bot with the same autopilot the
// cockpit uses. run against any server:
//   MINEPILOT_HOST=127.0.0.1 node examples/basic.js

const { loadConfig } = require('../src/config')
const { createDefaultSettings } = require('../src/settings')
const { Autopilot } = require('../src/autopilot')
const { WaypointStore } = require('../src/waypoints')
const { SelectionManager } = require('../src/selection')
const { createBotSession } = require('../src/bot')
const { executeCommand } = require('../src/commandexec')
const { MapView } = require('../src/mapview')

const config = loadConfig()
const settings = createDefaultSettings()
const waypoints = new WaypointStore()
const selection = new SelectionManager()

let pilot = null

const ctx = {
  pilot: null,
  bot: null,
  settings,
  selection,
  waypoints,
  reply: (text) => console.log('[minepilot]', text),
  source: 'console',
  commander: null,
  exploreFilter: null,
  mapview: null
}

const session = createBotSession(config, {
  settings,
  log: (text) => console.log('[bot]', text),
  onSpawn (bot) {
    ctx.bot = bot
    ctx.mapview = new MapView(bot, settings)
    pilot = new Autopilot({ bot, deps: { Vec3: require('vec3') }, settings })
    ctx.pilot = pilot
    console.log(`spawned at ${JSON.stringify(pilot.node())} — commanding`)
    // drive it like the cockpit does:
    run()
  }
})

async function run () {
  await executeCommand('goto 20 ~ ~', ctx)
  await executeCommand('mine grass_block 3', ctx)
  await executeCommand('wp save user first_stop', ctx)
  const eta = await executeCommand('eta', ctx)
  console.log('eta:', eta)
  // the autopilot keeps running; stop the process when done:
  // session.stop(); process.exit(0)
}

process.on('SIGINT', () => {
  if (pilot) pilot.stop()
  session.stop()
  process.exit(0)
})
