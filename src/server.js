'use strict'

// the web cockpit server — one http server, three roles:
//   static    serves the console (src/web) with no build step
//   rest      /api/* for state, settings, waypoints, inventory
//   ws        the live protocol: state ticks, map viewport streaming,
//             entities, chat, path/selection overlays and every
//             interaction (commands, clicks, drags, inventory actions)
//
// message types (json, field t = type):
//   server -> client: hello, state, chunks, map:update, entities, path,
//                     selection, waypoints, chat, log, settings, inventory
//   client -> server: viewport, command, chat, click, select, set,
//                     inventory:equip, inventory:drop, follow, attack, ping

const http = require('http')
const fs = require('fs')
const path = require('path')
const { WebSocketServer } = require('ws')
const { executeCommand } = require('./commandexec')
const inventory = require('./inventory')
const { hostileName } = require('./commandexec')

const STATIC_DIR = path.join(__dirname, 'web')
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json'
}

function sendJson (res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function readBody (req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => {
      data += c
      if (data.length > 65536) reject(new Error('body too large'))
    })
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}) } catch (e) { reject(new Error('body is not JSON')) }
    })
    req.on('error', reject)
  })
}

function createCockpitServer (ctx) {
  // settings/selection/waypoints are stable; the pilot and the bot are
  // swapped on every (re)spawn, so they are ALWAYS read through ctx
  const { settings, selection, waypoints } = ctx
  // the mapview rides on ctx so it can be swapped when the bot (re)spawns
  const mapview = () => ctx.mapview
  const state = { startedAt: Date.now() }
  const clients = new Set()

  const app = http.createServer(async (req, res) => {
    const url = (req.url || '/').split('?')[0]
    try {
      // ---------------------------------------------------------- static
      if (req.method === 'GET' && !url.startsWith('/api/')) {
        let file = url === '/' ? '/index.html' : url
        file = file.replace(/\/+$/, '/index.html')
        const full = path.join(STATIC_DIR, path.normalize(file).replace(/^([.]{2}[\/\\])+/, ''))
        if (!full.startsWith(STATIC_DIR)) return sendJson(res, 403, { error: 'forbidden' })
        fs.readFile(full, (err, data) => {
          if (err) {
            // spa-ish fallback for unknown paths
            if (url !== '/') {
              fs.readFile(path.join(STATIC_DIR, 'index.html'), (e2, d2) => {
                if (e2) return sendJson(res, 404, { error: 'not found' })
                res.writeHead(200, { 'content-type': MIME['.html'] })
                res.end(d2)
              })
              return
            }
            return sendJson(res, 404, { error: 'not found' })
          }
          const ext = path.extname(full)
          res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' })
          res.end(data)
        })
        return
      }

      // ------------------------------------------------------------ rest
      if (url === '/api/health') {
        return sendJson(res, 200, {
          ok: true,
          bot: ctx.bot ? (ctx.bot.username || 'pending') : 'disconnected',
          task: ctx.pilot ? ctx.pilot.task : 'idle',
          uptime: Math.floor((Date.now() - state.startedAt) / 1000),
          version: require('../package.json').version
        })
      }
      if (url === '/api/status') {
        const node = ctx.pilot ? ctx.pilot.node() : null
        return sendJson(res, 200, {
          connected: !!ctx.bot,
          username: ctx.bot ? ctx.bot.username : null,
          version: ctx.bot ? ctx.bot.version : null,
          position: node,
          health: ctx.bot ? ctx.bot.health : null,
          food: ctx.bot ? ctx.bot.food : null,
          task: ctx.pilot ? ctx.pilot.info() : null,
          selection: selection.snapshot(),
          waypoints: waypoints.list(),
          map: mapview().stats()
        })
      }
      if (url === '/api/settings' && req.method === 'GET') {
        return sendJson(res, 200, { settings: settings.list(), categories: settings.categories() })
      }
      if (url === '/api/settings' && req.method === 'POST') {
        const body = await readBody(req)
        if (!body.key) return sendJson(res, 400, { error: 'key required' })
        const r = settings.set(body.key, body.value)
        if (r.ok && ctx.pilot) ctx.pilot.syncFromSettings()
        return sendJson(res, r.ok ? 200 : 400, r)
      }
      if (url === '/api/waypoints' && req.method === 'GET') {
        return sendJson(res, 200, { waypoints: waypoints.list() })
      }
      if (url === '/api/inventory' && req.method === 'GET') {
        return sendJson(res, 200, { items: inventory.items(ctx.bot || {}).map((it) => ({ name: it.name, count: it.count, slot: it.slot })) })
      }
      if (url === '/api/command' && req.method === 'POST') {
        const body = await readBody(req)
        if (typeof body.command !== 'string') return sendJson(res, 400, { error: 'command required' })
        const lines = []
        const r = await executeCommand(body.command, { ...ctx, reply: (t) => lines.push(t), source: 'console' })
        return sendJson(res, 200, { result: r, lines })
      }
      return sendJson(res, 404, { error: 'not found' })
    } catch (e) {
      return sendJson(res, 500, { error: String(e.message || e).slice(0, 120) })
    }
  })

  // ------------------------------------------------------------------- ws
  const wss = new WebSocketServer({ server: app, path: '/ws' })
  let viewport = null // the current combined viewport of all clients

  function broadcast (obj) {
    if (clients.size === 0) return
    const s = JSON.stringify(obj)
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) {
        try { ws.send(s) } catch (e) { /* dropping */ }
      }
    }
  }

  wss.on('connection', (ws) => {
    clients.add(ws)
    ws.send(JSON.stringify({
      t: 'hello',
      version: require('../package.json').version,
      username: ctx.bot ? ctx.bot.username : null,
      minecraft: ctx.bot ? ctx.bot.version : null,
      settings: settings.list(),
      waypoints: waypoints.list(),
      selection: selection.snapshot(),
      categories: settings.categories()
    }))
    ws.on('message', (data) => {
      let msg
      try { msg = JSON.parse(String(data)) } catch (e) {
        try { ws.send(JSON.stringify({ t: 'log', text: 'message is not JSON' })) } catch (e2) { /* closing */ }
        return
      }
      handleMessage(ws, msg)
    })
    ws.on('close', () => clients.delete(ws))
    ws.on('error', () => {})
  })

  function handleMessage (ws, msg) {
    const t = msg && msg.t
    switch (t) {
      case 'ping':
        try { ws.send(JSON.stringify({ t: 'pong' })) } catch (e) { /* closing */ }
        break
      case 'viewport': {
        viewport = { cx0: msg.cx0, cz0: msg.cz0, cx1: msg.cx1, cz1: msg.cz1 }
        const chunks = mapview().viewport(msg.cx0, msg.cz0, msg.cx1, msg.cz1)
        try { ws.send(JSON.stringify({ t: 'chunks', chunks })) } catch (e) { /* closing */ }
        break
      }
      case 'command': {
        if (typeof msg.text !== 'string' || !ctx.bot) return
        executeCommand(msg.text, { ...ctx, reply: (text) => broadcast({ t: 'chat', from: 'minepilot', text }), source: msg.source || 'web' })
          .catch((e) => broadcast({ t: 'chat', from: 'minepilot', text: `command error: ${String(e.message || e).slice(0, 80)}` }))
        break
      }
      case 'chat': {
        if (typeof msg.text !== 'string' || !ctx.bot) return
        try { ctx.bot.chat(String(msg.text).slice(0, 256)) } catch (e) { /* ignore */ }
        break
      }
      case 'click': {
        // map clicks: { x, y, z, button } — left = goto (top of column),
        // right = goto beside (the baritone click contract)
        if (!Number.isFinite(msg.x) || !Number.isFinite(msg.z)) return
        const x = Math.floor(msg.x)
        const z = Math.floor(msg.z)
        const top = mapview().topOf(x, z, (msg.y || 96) + 8)
        const y = top ? top.y + 1 : (Number.isFinite(msg.y) ? Math.floor(msg.y) : 64)
        const cmd = msg.button === 'right'
          ? `goto ${x} ${y} ${z}`
          : `goto ${x} ${y} ${z}`
        executeCommand(cmd, { ...ctx, reply: (text) => broadcast({ t: 'chat', from: 'minepilot', text }), source: 'map' })
          .catch(() => {})
        break
      }
      case 'select': {
        // drag selection: { x0, z0, x1, z1, y } — sets pos1/pos2; the ui
        // then runs sel fill/excavate/clear via plain commands
        selection.setPos1({ x: Math.floor(msg.x0), y: Math.floor(msg.y0), z: Math.floor(msg.z0) })
        selection.setPos2({ x: Math.floor(msg.x1), y: Math.floor(msg.y1), z: Math.floor(msg.z1) })
        broadcast({ t: 'selection', selection: selection.snapshot() })
        break
      }
      case 'set': {
        const r = settings.set(msg.key, msg.value)
        if (r.ok && ctx.pilot) ctx.pilot.syncFromSettings()
        broadcast({ t: 'settings', settings: settings.list() })
        if (!r.ok) broadcast({ t: 'log', text: `${msg.key}: ${r.error}` })
        break
      }
      case 'inventory:equip': {
        const item = inventory.findStack(ctx.bot, msg.name)
        if (item) {
          try { ctx.bot.equip(item, 'hand') } catch (e) { /* ignore */ }
        }
        break
      }
      case 'inventory:drop': {
        inventory.drop(ctx.bot, { mode: 'item', item: msg.name }).catch(() => {})
        break
      }
      case 'follow': {
        const cmd = msg.off ? 'follow off' : `follow ${msg.kind || 'player'} ${msg.name || ''}`.trim()
        executeCommand(cmd, { ...ctx, reply: () => {}, source: 'web' }).catch(() => {})
        break
      }
      case 'attack': {
        const cmd = msg.off ? 'attack off' : `attack ${msg.target}`
        executeCommand(cmd, { ...ctx, reply: () => {}, source: 'web' }).catch(() => {})
        break
      }
      default:
        break
    }
  }

  // ------------------------------------------------------------- ticks
  function stateTick () {
    if (!ctx.bot || !ctx.pilot) return
    const node = ctx.pilot.node()
    const e = ctx.bot.entity
    const eta = ctx.pilot.eta()
    broadcast({
      t: 'state',
      pos: e && e.position ? [e.position.x, e.position.y, e.position.z] : null,
      node,
      yaw: e ? e.yaw : null,
      health: ctx.bot.health,
      food: ctx.bot.food,
      task: ctx.pilot.info(),
      eta: eta.ok ? { blocks: eta.blocks, seconds: eta.seconds, arrived: eta.arrived } : null,
      held: ctx.bot.heldItem ? ctx.bot.heldItem.name : null,
      paused: ctx.pilot.paused
    })
  }

  function entityTick () {
    if (!ctx.bot) return
    const p = ctx.bot.entity && ctx.bot.entity.position
    if (!p) return
    const out = []
    try {
      for (const [id, e] of Object.entries(ctx.bot.entities || {})) {
        if (!e || !e.position || e === ctx.bot.entity) continue
        const d = e.position.distanceTo(p)
        if (d > 96) continue
        out.push({
          id: Number(id) || id,
          type: e.name || e.type || 'unknown',
          username: e.username || null,
          pos: [e.position.x, e.position.y, e.position.z],
          hostile: !!hostileName(e)
        })
      }
    } catch (e) { /* ignore */ }
    broadcast({ t: 'entities', entities: out })
  }

  function pathTick () {
    if (!ctx.pilot) return
    broadcast({
      t: 'path',
      points: ctx.pilot.pathPoints(),
      goal: ctx.pilot.goalLabel,
      partial: ctx.pilot.partial
    })
  }

  function inventoryTick () {
    if (!ctx.bot) return
    broadcast({
      t: 'inventory',
      items: inventory.items(ctx.bot).map((it) => ({ name: it.name, count: it.count })),
      held: ctx.bot.heldItem ? ctx.bot.heldItem.name : null
    })
  }

  function mapTick () {
    if (!viewport || clients.size === 0) return
    const dirty = mapview().drainDirty()
    if (dirty.length === 0) return
    const updated = []
    for (const k of dirty) {
      const [cx, cz] = k.split(',').map(Number)
      // only push chunks inside the current viewport
      if (cx >= Math.min(viewport.cx0, viewport.cx1) && cx <= Math.max(viewport.cx0, viewport.cx1) &&
        cz >= Math.min(viewport.cz0, viewport.cz1) && cz <= Math.max(viewport.cz0, viewport.cz1)) {
        updated.push(mapview().chunkPayload(cx, cz))
      }
    }
    if (updated.length > 0) broadcast({ t: 'chunks', chunks: updated })
  }

  const timers = [
    setInterval(stateTick, 400),
    setInterval(entityTick, 800),
    setInterval(pathTick, 1000),
    setInterval(inventoryTick, 2000),
    setInterval(mapTick, 500)
  ]

  // chat + waypoints + selection events from the bot side.
  // two lifetimes are wired here, with different rules:
  //   bot-level listeners — the SAME bot object survives respawn, so they
  //     are guarded by a WeakSet (re-registering would stack death/chat
  //     listeners until the EventEmitter warning fires — seen at 11 deaths).
  //   pilot-level listeners — the autopilot is re-created on every spawn,
  //     so these must be (re)wired on every call.
  const wiredBots = new WeakSet()
  const pushWaypoints = () => broadcast({ t: 'waypoints', waypoints: waypoints.list() })
  function wireBot (bot) {
    if (!bot || !bot.on) return
    if (!wiredBots.has(bot)) {
      wiredBots.add(bot)
      bot.on('chat', (username, message) => {
        broadcast({ t: 'chat', from: username, text: String(message) })
      })
      bot.on('death', pushWaypoints)
      bot.once('end', () => wiredBots.delete(bot))
    }
    if (ctx.pilot) {
      ctx.pilot.on('selection', () => broadcast({ t: 'selection', selection: selection.snapshot() }))
      ctx.pilot.on('log', (text) => broadcast({ t: 'log', text }))
      ctx.pilot.on('saveall', pushWaypoints)
      ctx.pilot.on('reloadall', pushWaypoints)
      ctx.pilot.on('repack', () => {
        if (mapview() && mapview().cache) mapview().cache.clear()
        if (viewport) {
          const chunks = mapview().viewport(viewport.cx0, viewport.cz0, viewport.cx1, viewport.cz1)
          broadcast({ t: 'chunks', chunks })
        }
      })
    }
  }

  function listen (port, host) {
    return new Promise((resolve) => {
      app.listen(port, host || '0.0.0.0', () => resolve(app.address()))
    })
  }

  function close () {
    for (const t of timers) clearInterval(t)
    for (const ws of clients) {
      try { ws.terminate() } catch (e) { /* gone */ }
    }
    clients.clear()
    wss.close()
    app.close()
  }

  return { app, wss, broadcast, listen, close, wireBot }
}

module.exports = { createCockpitServer }
