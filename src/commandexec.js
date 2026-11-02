'use strict'

// the command executor — dispatches parsed commands onto the autopilot,
// the processes and the managers. one function, one place, both input
// paths (in-game chat and the web console) share it.
//
// ctx = {
//   pilot,      the Autopilot
//   bot,        the mineflayer bot
//   settings,   the settings registry
//   selection,  the SelectionManager
//   waypoints,  the WaypointStore
//   reply(text) send a response line to whoever asked
//   source      'chat' | 'console' | 'map'
//   commander   { name, entity } for chat-sourced commands
// }

const { parseCommand, COMMANDS, helpLines } = require('./commands')
const { createDefaultSettings } = require('./settings')
const {
  GoalBlock, GoalXZ, GoalYLevel, GoalRunAway
} = require('./engine/goals')
const { runCombat } = require('./processes/combat')
const { runPickup } = require('./processes/pickup')
const { runTunnel } = require('./processes/tunnel')
const { runExcavate } = require('./processes/excavate')
const { runGetToBlock, runClick, findNearestBlock } = require('./processes/gotoblock')
const { parseBlueprint, loadBlueprintFile } = require('./util/blueprints')
const { loadSchematicFile } = require('./util/schematics')
const { loadExplorefilter } = require('./util/explorefilter')
const { normCuboid } = require('./selection')

const VERSION = require('../package.json').version

function resolveCoord (c, anchor) {
  if (!c) return null
  const v = c.rel ? Math.floor(anchor + c.value) : Math.floor(c.value)
  return v
}

function playerEntity (bot, name) {
  try {
    const p = bot.players && bot.players[name]
    if (p) return p
  } catch (e) { /* ignore */ }
  return null
}

function playerPosition (bot, name) {
  const p = playerEntity(bot, name)
  if (p && p.entity && p.entity.position) return p.entity.position
  return null
}

// every living entity in range, classified
function nearbyEntities (bot) {
  const out = []
  try {
    for (const e of Object.values(bot.entities || {})) {
      if (!e || !e.position || e === bot.entity) continue
      out.push(e)
    }
  } catch (e) { /* ignore */ }
  return out
}

function hostileName (e) {
  const hostiles = ['zombie', 'skeleton', 'creeper', 'spider', 'cave_spider',
    'enderman', 'witch', 'blaze', 'ghast', 'slime', 'magma_cube', 'pillager',
    'vindicator', 'evoker', 'ravager', 'phantom', 'drowned', 'husk',
    'stray', 'wither_skeleton', 'piglin_brute', 'hoglin', 'zoglin', 'warden',
    'breeze', 'bogged']
  const n = String(e.name || (e.type) || '')
  return hostiles.some((h) => n.includes(h)) ? n : null
}

async function executeCommand (raw, ctx) {
  const parsed = parseCommand(raw)
  if (!parsed.ok) {
    ctx.reply(parsed.error)
    return { ok: false, error: parsed.error }
  }
  // commands either reply() themselves or return { ok, reply }; unify
  // the two so every input path (chat, console, map, rest) hears the same
  // answer. run the dispatch through an inner reply-capturing context.
  const { name, args } = parsed
  // a human took the controls: the survival brain's goals stand down for
  // the hold window (reflexes keep running — safety is never suspended)
  if (ctx.brain && name !== 'auto' && ctx.source !== 'brain') {
    try { ctx.brain.noteUserCommand() } catch (e) { /* ignore */ }
  }
  const { pilot, bot, settings, selection, waypoints } = ctx
  const node = () => pilot.node() || { x: 0, y: 64, z: 0 }
  let replies = 0
  const inner = { ...ctx, reply: (text) => { replies++; ctx.reply(text) } }

  const r = await dispatchCommand(name, args, inner, { pilot, bot, settings, selection, waypoints, node, ctx })
  if (r && r.reply && replies === 0) ctx.reply(r.reply)
  return r
}

async function dispatchCommand (name, args, ctx, refs) {
  const { pilot, bot, settings, selection, waypoints, node } = refs
  const { reply } = ctx

  switch (name) {
    // ------------------------------------------------------------ help
    case 'help': {
      if (args.command) {
        const c = COMMANDS.find((x) => x.name === args.command)
        reply(c ? `${c.name} ${c.args} — ${c.help}` : `unknown command "${args.command}"`)
        return { ok: true }
      }
      reply('commands (baritone parity + minepilot extras):')
      for (const line of helpLines()) reply('  ' + line)
      return { ok: true }
    }

    // ---------------------------------------------------------- settings
    case 'set': {
      if (args.mode === 'list') {
        for (const cat of settings.categories()) {
          reply(`${cat.name} — ${cat.blurb} (${cat.count})`)
        }
        reply('use "set <key>" for one setting, "set <key> <value>" to change it')
        return { ok: true }
      }
      if (args.mode === 'modified') {
        const mods = settings.modifiedList()
        if (mods.length === 0) {
          reply('no settings modified from defaults')
          return { ok: true }
        }
        for (const m of mods) reply(`${m.key} = ${JSON.stringify(m.value)} (default ${JSON.stringify(m.default)})`)
        return { ok: true }
      }
      if (args.mode === 'reset') {
        const r = settings.reset(args.key)
        if (!r.ok) { reply(r.error); return r }
        pilot.syncFromSettings()
        reply(args.key ? `reset ${args.key}` : 'all settings reset')
        return { ok: true }
      }
      if (args.mode === 'show') {
        if (!settings.has(args.key)) {
          const r = settings.set(args.key, 'true') // triggers the suggest error
          reply(r.error)
          return r
        }
        const s = settings.list().find((x) => x.key === args.key)
        reply(`${s.key} = ${JSON.stringify(s.value)} — ${s.description}`)
        return { ok: true }
      }
      // mode === 'set'
      const r = settings.set(args.key, args.value)
      if (!r.ok) { reply(`${args.key}: ${r.error}`); return r }
      pilot.syncFromSettings()
      reply(`${args.key} = ${JSON.stringify(r.value)}`)
      return { ok: true }
    }

    // ------------------------------------------------------------- goals
    case 'goal': {
      if (args.mode === 'clear') {
        pilot.goal = null
        pilot.goalLabel = ''
        pilot.emit('task')
        reply('goal cleared')
        return { ok: true }
      }
      if (args.mode === 'feet') {
        const n = node()
        return pilot.setGoal(new GoalBlock(n.x, n.y, n.z))
      }
      if (args.mode === 'ylevel') {
        return pilot.setGoal(new GoalYLevel(args.y))
      }
      const n = node()
      const x = resolveCoord(args.x, n.x)
      const z = resolveCoord(args.z, n.z)
      const goal = args.y === null
        ? new GoalXZ(x, z)
        : new GoalBlock(x, resolveCoord(args.y, n.y), z)
      return pilot.setGoal(goal)
    }

    case 'goto': {
      if (args.mode === 'block') {
        pilot.startJob('goto', `goto ${args.block}`, async (alive) => {
          const target = await runGetToBlock(pilot, args.block, alive)
          pilot.emit('log', target ? `arrived beside the ${args.block} at ${target.x} ${target.y} ${target.z}` : 'superseded')
          return target
        })
        return { ok: true, reply: `heading to the nearest ${args.block}` }
      }
      const n = node()
      const x = resolveCoord(args.x, n.x)
      const z = resolveCoord(args.z, n.z)
      const y = args.y === null ? null : resolveCoord(args.y, n.y)
      return pilot.goto(x, y, z)
    }

    case 'path': {
      return pilot.path()
    }

    // -------------------------------------------------------- reporting
    case 'proc': {
      const info = pilot.info()
      reply(`task: ${info.task}${info.process ? ` (process ${info.process})` : ''}`)
      reply(`goal: ${info.goal || 'none'}${info.partial ? ' (partial)' : ''}${info.paused ? ' [PAUSED]' : ''}`)
      reply(`progress: ${info.progress}/${info.total} moves, replans ${info.replans}, stuck ${info.stuck}`)
      return { ok: true }
    }

    case 'eta': {
      const e = pilot.eta()
      if (!e.ok) { reply(e.error); return e }
      reply(e.arrived
        ? 'goal is met'
        : `${e.blocks} blocks to go, roughly ${Math.floor(e.seconds / 60)}m${e.seconds % 60}s (task ${e.task})`)
      return { ok: true, eta: e }
    }

    case 'version': {
      const mf = require('mineflayer/package.json').version
      reply(`minepilot ${VERSION} | mineflayer ${mf} | minecraft ${bot.version}`)
      return { ok: true }
    }

    case 'gc': {
      if (global.gc) global.gc()
      const mu = process.memoryUsage()
      reply(`heap ${(mu.heapUsed / 1048576).toFixed(1)}/${(mu.heapTotal / 1048576).toFixed(1)} MiB, rss ${(mu.rss / 1048576).toFixed(1)} MiB${global.gc ? ' (gc run)' : ' (start node with --expose-gc to force gc)'}`)
      return { ok: true }
    }

    case 'where': {
      const n = node()
      reply(`i am at ${n.x} ${n.y} ${n.z} (task: ${pilot.task})`)
      return { ok: true, node: n }
    }

    case 'status': {
      const n = node()
      const e = pilot.eta()
      reply(`pos ${n.x} ${n.y} ${n.z} | health ${bot.health ?? '?'} food ${bot.food ?? '?'} | task ${pilot.task}${pilot.paused ? ' [PAUSED]' : ''}`)
      reply(`goal ${pilot.goalLabel || 'none'}${e.ok && !e.arrived ? ` | ${e.blocks} blocks to go` : ''} | selection ${selection.hasSelection() ? selection.volume() + ' cells' : 'none'} | waypoints ${waypoints.list().length}`)
      return { ok: true }
    }

    // -------------------------------------------------------- lifecycle
    case 'pause': {
      return pilot.pause(ctx.source)
    }
    case 'resume': {
      return pilot.resume()
    }
    case 'paused': {
      reply(pilot.paused ? `paused by ${pilot.pausedBy}` : 'not paused')
      return { ok: true, paused: pilot.paused }
    }
    case 'cancel':
    case 'stop': {
      pilot.stop()
      reply('stopped')
      return { ok: true }
    }
    case 'forcecancel': {
      pilot.stop()
      try { bot.clearControlStates() } catch (e) { /* ignore */ }
      reply('force cancelled: goal, processes and controls')
      return { ok: true }
    }

    // ------------------------------------------------------ movement
    case 'come': {
      let pos = null
      let who = 'the commander'
      if (args.player) {
        pos = playerPosition(bot, args.player)
        who = args.player
        if (!pos) { reply(`i cannot see ${args.player}`); return { ok: false, error: 'player not visible' } }
      } else if (ctx.commander && ctx.commander.entity && ctx.commander.entity.position) {
        pos = ctx.commander.entity.position
        who = ctx.commander.name
      } else {
        reply('come needs a player caller — use goto <x> <z> instead')
        return { ok: false, error: 'no commander' }
      }
      const r = await pilot.come(pos)
      if (r.ok) reply(`heading to ${who}`)
      else reply(r.error)
      return r
    }

    case 'axis': {
      const y = args.y === null ? settings.get('axisHeight') : args.y
      return pilot.axis(y)
    }

    case 'surface': {
      return pilot.surface()
    }

    case 'thisway': {
      return pilot.thisway(args.distance)
    }

    case 'invert': {
      return pilot.invert()
    }

    case 'spawn': {
      const sp = bot.spawnPoint || (bot.world && bot.world.spawnPoint)
      if (!sp) { reply('spawn point unknown'); return { ok: false, error: 'no spawn point' } }
      return pilot.goto(Math.floor(sp.x), Math.floor(sp.y), Math.floor(sp.z))
    }

    case 'flee': {
      const p = pilot.pos()
      if (!p) return { ok: false, error: 'no position yet' }
      let threat = null
      let bestD = Infinity
      for (const e of nearbyEntities(bot)) {
        const h = hostileName(e)
        if (!h) continue
        const d = e.position.distanceTo(p)
        if (d < bestD) { bestD = d; threat = e }
      }
      if (!threat) { reply('nothing hostile in range'); return { ok: true } }
      const r = pilot.runAway(threat.position.x, threat.position.z, args.radius)
      reply(`fleeing from ${threat.name || 'threat'}`)
      return r
    }

    // -------------------------------------------------------- processes
    case 'follow': {
      if (args.kind === 'off') {
        pilot.stop()
        reply('stopped following')
        return { ok: true }
      }
      const radius = settings.get('followRadius')
      let getter = null
      let label = ''
      if (args.kind === 'player' || args.kind === 'players') {
        const names = args.names && args.names.length > 0 ? args.names : null
        getter = () => {
          if (names) {
            for (const n of names) {
              const pos = playerPosition(bot, n)
              if (pos) return pos
            }
            return null
          }
          // any player in range
          let best = null
          let bestD = Infinity
          for (const e of nearbyEntities(bot)) {
            if (!e.username && !playerEntity(bot, e.username || '')) continue
            if (e.username) {
              const d = e.position.distanceTo(pilot.pos() || e.position)
              if (d < bestD) { bestD = d; best = e }
            }
          }
          return best ? best.position : null
        }
        label = names ? `player ${names.join('/')}` : 'players'
      } else {
        const types = args.types && args.types.length > 0 ? args.types : null
        getter = () => {
          let best = null
          let bestD = Infinity
          for (const e of nearbyEntities(bot)) {
            const en = String(e.name || e.type || '')
            if (types && !types.some((t) => en.includes(t))) continue
            if (!types && !en) continue
            const d = e.position.distanceTo(pilot.pos() || e.position)
            if (d < bestD) { bestD = d; best = e }
          }
          return best ? best.position : null
        }
        label = types ? `entity ${types.join('/')}` : 'entities'
      }
      const r = pilot.follow(getter, radius)
      reply(`following ${label}`)
      return r
    }

    case 'attack': {
      if (args.target === null) {
        pilot.stop()
        reply('attack off')
        return { ok: true }
      }
      pilot.startJob('attack', `attack ${args.target}`, (alive) => runCombat(pilot, args.target, alive))
      return { ok: true, reply: `hunting ${args.target}` }
    }

    case 'pickup': {
      pilot.startJob('pickup', `pickup r${args.radius}`, (alive) => runPickup(pilot, args.radius, alive))
      return { ok: true, reply: `picking up drops within ${args.radius} blocks` }
    }

    case 'mine': {
      return pilot.mine(args.blocks, args.count)
    }

    case 'tunnel': {
      pilot.startJob('tunnel', `tunnel ${args.height}x${args.width}x${args.depth}`, (alive) => runTunnel(pilot, args.height, args.width, args.depth, alive))
      return { ok: true, reply: `digging a ${args.height}x${args.width} tunnel, ${args.depth} deep` }
    }

    case 'excavate': {
      let from
      let to
      if (args.mode === 'selection') {
        const c = selection.cuboid()
        if (!c) { reply('no selection — set pos1 and pos2 first (or use excavate x1 y1 z1 x2 y2 z2)'); return { ok: false, error: 'no selection' } }
        from = { x: c.minX, y: c.minY, z: c.minZ }
        to = { x: c.maxX, y: c.maxY, z: c.maxZ }
      } else {
        from = { x: args.from[0], y: args.from[1], z: args.from[2] }
        to = { x: args.to[0], y: args.to[1], z: args.to[2] }
      }
      const c = normCuboid(from, to)
      pilot.startJob('excavate', `excavate ${c.minX} ${c.minY} ${c.minZ} -> ${c.maxX} ${c.maxY} ${c.maxZ}`,
        (alive) => runExcavate(pilot, from, to, alive))
      return { ok: true, reply: 'excavating' }
    }

    case 'find': {
      const target = findNearestBlock(pilot, args.block, settings.get('mineScanRadius'))
      if (!target) { reply(`no ${args.block} in range`); return { ok: false, error: 'not found' } }
      reply(`nearest ${args.block}: ${target.x} ${target.y} ${target.z}`)
      return { ok: true, target }
    }

    case 'click': {
      pilot.startJob('click', `click ${args.x} ${args.y} ${args.z}`, async (alive) => {
        const ok = await runClick(pilot, args.x, args.y, args.z, alive)
        pilot.emit('log', ok ? `clicked ${args.x} ${args.y} ${args.z}` : `could not click ${args.x} ${args.y} ${args.z}`)
        return ok
      })
      return { ok: true, reply: `clicking ${args.x} ${args.y} ${args.z}` }
    }

    // ---------------------------------------------------------- farming
    case 'farm': {
      let origin = null
      if (args.waypoint) {
        const resolved = waypoints.resolve(args.waypoint)
        if (!resolved) { reply(`no waypoint "${args.waypoint}"`); return { ok: false, error: 'waypoint not found' } }
        origin = resolved.waypoint
        reply(`farming within ${args.range} blocks of ${resolved.waypoint.name}`)
      }
      const { runFarm } = require('./processes/farm')
      pilot.startJob('farm', `farm r${args.range}${origin ? ' @' + origin.name : ''}`, (alive) => runFarm(pilot, args.range, alive, origin))
      return { ok: true, reply: `farming within ${args.range} blocks${origin ? ' of ' + origin.name : ''}` }
    }

    case 'explore': {
      const { runExplore } = require('./processes/explore')
      const origin = (args.x !== null && args.z !== null) ? { x: args.x, z: args.z } : null
      const radius = args.radius || 256
      const filter = ctx.exploreFilter || null
      pilot.startJob('explore', `explore r${radius}`, (alive) => runExplore(pilot, radius, alive, { origin, filter }))
      return { ok: true, reply: `exploring ${origin ? `from ${origin.x} ${origin.z}` : 'from here'} within ${radius} blocks` }
    }

    // ------------------------------------------------------- waypoints
    case 'waypoints': {
      switch (args.mode) {
        case 'list': {
          const list = waypoints.list(args.tag)
          if (list.length === 0) { reply(args.tag ? `no waypoints tagged ${args.tag}` : 'no waypoints saved'); return { ok: true } }
          for (const w of list) reply(waypoints.describe(w))
          return { ok: true, list }
        }
        case 'save': {
          const n = node()
          const r = waypoints.saveWaypoint(args.tag, args.name, n)
          if (!r.ok) { reply(r.error); return r }
          reply(`saved ${args.name} [${args.tag}] at ${n.x} ${n.y} ${n.z}`)
          return { ok: true }
        }
        case 'goal': {
          const resolved = waypoints.resolve(args.ref)
          if (!resolved) { reply(`no waypoint "${args.ref}"`); return { ok: false, error: 'not found' } }
          if (resolved.kind === 'tag') {
            reply(`tag "${args.ref}":`)
            for (const w of resolved.list) reply('  ' + waypoints.describe(w))
          }
          const w = resolved.waypoint
          return pilot.setGoal(new GoalBlock(w.x, w.y, w.z))
        }
        case 'info': {
          const resolved = waypoints.resolve(args.ref)
          if (!resolved) { reply(`no waypoint "${args.ref}"`); return { ok: false, error: 'not found' } }
          reply(waypoints.describe(resolved.waypoint) + ` (${new Date(resolved.waypoint.time).toLocaleString()})`)
          return { ok: true }
        }
        case 'delete': {
          const r = waypoints.delete(args.ref)
          reply(r.ok ? `deleted ${r.deleted} waypoint(s)` : r.error)
          return r
        }
        case 'clear': {
          const r = waypoints.clear()
          reply(`cleared ${r.deleted} waypoints`)
          return r
        }
        default:
          reply('usage: wp <save|goal|list|info|delete|clear> ...')
          return { ok: false }
      }
    }

    // ------------------------------------------------------- selection
    case 'sel': {
      switch (args.action) {
        case 'pos1':
        case 'pos2': {
          const n = node()
          const at = args.coords
            ? { x: args.coords[0], y: args.coords[1], z: args.coords[2] }
            : n
          const r = args.action === 'pos1' ? selection.setPos1(at) : selection.setPos2(at)
          reply(`${args.action} at ${at.x} ${at.y} ${at.z}`)
          pilot.emit('selection')
          return { ok: true }
        }
        case 'clear': {
          selection.clear()
          reply('selection cleared')
          pilot.emit('selection')
          return { ok: true }
        }
        case 'undo': {
          const r = selection.undo()
          reply(r.ok ? 'undone' : r.error)
          pilot.emit('selection')
          return r
        }
        case 'expand':
        case 'contract':
        case 'shift': {
          const r = selection.transform(args.action, args.n, args.dir)
          reply(r.ok ? `${args.action} ${args.n} ${args.dir} — now ${selection.volume()} cells` : r.error)
          pilot.emit('selection')
          return r
        }
        case 'fill':
        case 'walls':
        case 'shell':
        case 'sphere':
        case 'cylinder': {
          const r = args.action === 'fill'
            ? selection.fillBlueprint(args.block)
            : args.action === 'walls'
              ? selection.wallsBlueprint(args.block)
              : args.action === 'shell'
                ? selection.shellBlueprint(args.block)
                : args.action === 'sphere'
                  ? selection.sphereBlueprint(args.block, args.radius, args.hollow)
                  : selection.cylinderBlueprint(args.block, args.radius, args.height, args.hollow)
          if (!r.ok) { reply(r.error); return r }
          // shape blueprints carry ABSOLUTE world cells (unlike `copy`, which
          // stores relative ones) — build them against a zero origin, never
          // the bot's feet: origin + absolute doubled every coordinate (the
          // chest landed at 2x and the build died as "beyond the loaded
          // world" — found by the live station e2e)
          pilot.build(r.blueprint, { x: 0, y: 0, z: 0 })
          reply(`building ${args.action} ${args.block} (${r.blueprint.placements.length} cells)`)
          return { ok: true }
        }
        case 'cleararea': {
          const r = selection.clearAreaBlueprint()
          if (!r.ok) { reply(r.error); return r }
          pilot.startJob('excavate', 'cleararea', (alive) => runExcavate(pilot, selection.pos1, selection.pos2, alive))
          reply(`clearing ${selection.volume()} cells`)
          return { ok: true }
        }
        case 'replace': {
          const c = selection.cuboid()
          if (!c) { reply('no selection'); return { ok: false, error: 'no selection' } }
          pilot.startJob('replace', `replace ${args.from} -> ${args.to}`, async (alive) => {
            // dig every matching cell, then fill with the new block
            const { runExcavate, remaining } = require('./processes/excavate')
            let dug = 0
            while (alive()) {
              const cells = remaining(pilot, c).filter((cell) => cell.name === args.from)
              if (cells.length === 0) break
              dug += cells.length
              for (const cell of cells) {
                if (!alive()) break
                await pilot.digCell(cell)
              }
            }
            const fillBp = selection.fillBlueprint(args.to)
            const { runBuilder } = require('./processes/builder')
            await runBuilder(pilot, fillBp.blueprint, { x: c.minX, y: c.minY, z: c.minZ }, alive)
            return { dug }
          })
          reply(`replacing ${args.from} with ${args.to} in the selection`)
          return { ok: true }
        }
        case 'copy': {
          const r = selection.copy(pilot.view)
          reply(r.ok ? `copied ${r.cells} cells (${r.size.x}x${r.size.y}x${r.size.z})` : r.error)
          return r
        }
        case 'paste': {
          if (!selection.clipboard) { reply('clipboard is empty — sel copy first'); return { ok: false, error: 'empty clipboard' } }
          const at = args.coords
            ? { x: args.coords[0], y: args.coords[1], z: args.coords[2] }
            : node()
          pilot.build(selection.clipboard, at)
          reply(`pasting ${selection.clipboard.placements.length} cells at ${at.x} ${at.y} ${at.z}`)
          return { ok: true }
        }
        default:
          reply('usage: sel <pos1|pos2|clear|undo|fill|walls|shell|sphere|cylinder|cleararea|replace|expand|contract|shift|copy|paste> ...')
          return { ok: false }
      }
    }

    // --------------------------------------------------------- building
    case 'build': {
      // schematic formats (nbt) load through the schematic parser; plain
      // names fall back to the json blueprint library
      let loaded = null
      if (/\.(litematic|schem|schematic)$/.test(args.schematic)) {
        loaded = await loadSchematicFile(args.schematic)
      } else {
        loaded = loadBlueprintFile(args.schematic)
        if (!loaded.ok) {
          const s = await loadSchematicFile(args.schematic)
          if (s.ok) loaded = { ok: true, blueprint: s.schematic }
        }
      }
      if (!loaded.ok) { reply(loaded.error); return loaded }
      let origin = null
      if (args.origin) {
        const n = node()
        origin = {
          x: resolveCoord(args.origin.x, n.x),
          // "build <schem> <x> <z>" (no y) anchors on the bot's feet level,
          // like baritone — resolveCoord(null) must not leak into the
          // builder as null (null + offset coerces to 0 and the build
          // floats at y=0 with no anchor faces)
          y: args.origin.y == null ? n.y : resolveCoord(args.origin.y, n.y),
          z: resolveCoord(args.origin.z, n.z)
        }
      }
      return pilot.build(loaded.blueprint, origin)
    }

    case 'litematica': {
      const loaded = await loadSchematicFile(args.file)
      if (!loaded.ok) { reply(loaded.error); return loaded }
      return pilot.build(loaded.schematic, null)
    }

    // ------------------------------------------------------ inventory
    case 'inventory': {
      let items = []
      try { items = bot.inventory ? bot.inventory.items() : [] } catch (e) { items = [] }
      if (items.length === 0) { reply('inventory empty'); return { ok: true } }
      const counts = new Map()
      for (const it of items) counts.set(it.name, (counts.get(it.name) || 0) + (it.count || 1))
      for (const [n, c] of counts) reply(`${n} x${c}`)
      return { ok: true, items: [...counts.entries()] }
    }

    case 'drop': {
      const inv = require('./inventory')
      const r = await inv.drop(bot, args)
      reply(r.ok ? r.reply : r.error)
      return r
    }

    case 'eat': {
      const inv = require('./inventory')
      const r = await inv.eatOnce(bot)
      reply(r.ok ? r.reply : r.error)
      return r
    }

    case 'say': {
      try { bot.chat(args.message) } catch (e) { /* ignore */ }
      return { ok: true }
    }

    // ------------------------------------------------------------ misc
    case 'render': {
      const cur = settings.get('renderPath')
      settings.set('renderPath', !cur)
      settings.set('renderGoal', !cur)
      pilot.emit('settings')
      reply(`path and goal rendering ${!cur ? 'on' : 'off'} (map reloads instantly)`)
      return { ok: true }
    }

    case 'repack': {
      pilot.emit('repack')
      reply('map cache repack requested')
      return { ok: true }
    }

    case 'reloadall': {
      waypoints.load()
      pilot.emit('reloadall')
      reply(`reloaded ${waypoints.list().length} waypoints`)
      return { ok: true }
    }

    case 'saveall': {
      const w = waypoints.save()
      pilot.emit('saveall')
      reply(w.ok ? `saved ${w.count} waypoints to ${waypoints.file}` : w.error)
      return w
    }

    case 'blacklist': {
      if (!pilot.mineBlacklist) pilot.mineBlacklist = new Set()
      if (args.mode === 'coords') {
        pilot.mineBlacklist.add(`${args.x},${args.y},${args.z}`)
        reply(`blacklisted ${args.x} ${args.y} ${args.z}`)
        return { ok: true }
      }
      // blacklist the closest known block of any type the mine process targets
      const n = node()
      pilot.mineBlacklist.add(`${n.x + 1},${n.y},${n.z}`)
      reply('blacklisted the block ahead (closest)')
      return { ok: true }
    }

    case 'explorefilter': {
      const r = loadExplorefilter(args.file, args.invert)
      if (!r.ok) { reply(r.error); return r }
      ctx.exploreFilter = r.filter
      reply(`explore filter: ${r.count} chunks${args.invert ? ' (inverted)' : ''}`)
      return { ok: true, filter: r }
    }

    case 'elytra': {
      const elytra = require('./processes/elytra')
      const n = node()
      const x = resolveCoord(args.x, n.x)
      const z = resolveCoord(args.z, n.z)
      const y = args.y === null ? null : resolveCoord(args.y, n.y)
      return elytra.commandElytra(pilot, x, y, z)
    }

    case 'craft':
    case 'chest': {
      const inv = require('./inventory')
      if (name === 'craft') return inv.commandCraft(ctx, args)
      return inv.commandChest(ctx, args)
    }

    case 'feed':
    case 'breed':
    case 'sleep':
    case 'wake':
    case 'activate': {
      const inter = require('./interactions')
      if (name === 'feed') return inter.feedEntity(ctx, args.entity, args.item)
      if (name === 'breed') return inter.breedPair(ctx, args.entity)
      if (name === 'sleep') return inter.sleepInBed(ctx)
      if (name === 'wake') return inter.wakeUp(ctx)
      return inter.activateBlock(ctx, args.block)
    }

    case 'auto': {
      if (!ctx.brain) return { ok: false, error: 'the brain is not available in this session' }
      const st = ctx.brain.status()
      if (args.mode === 'status') {
        reply(`full-auto: ${st.on ? 'ON' : 'off'} — ${st.activity}${st.reason ? ' (' + st.reason + ')' : ''}`)
        return { ok: true, status: st }
      }
      const want = args.mode === 'toggle' ? !st.on : args.mode === 'on'
      settings.set('autoSurvival', want)
      ctx.brain.setEnabled(want)
      return { ok: true, reply: `full-auto ${want ? 'ON' : 'off'}` }
    }

    case 'litematica': {
      reply('litematica loading lands with the builder phase — next push')
      return { ok: false, error: 'not implemented yet' }
    }

    case 'damn': {
      reply('damn daniel... back at it again with the white vans')
      return { ok: true }
    }

    default: {
      reply(`unknown command "${name}"`)
      return { ok: false }
    }
  }
}

module.exports = { executeCommand, hostileName, nearbyEntities, playerPosition, VERSION }
