'use strict'

/* minepilot cockpit — vanilla js, no build step.
   one websocket, one canvas, one command grammar shared with in-game chat. */

// ------------------------------------------------------------------ state
const S = {
  ws: null,
  connected: false,
  chunks: new Map(), // 'cx,cz' -> { cx, cz, cols: [ {c,y,n} | null ] * 256 }
  entities: new Map(),
  path: [],
  goalLabel: null,
  partial: false,
  selection: { pos1: null, pos2: null },
  waypoints: [],
  settings: [],
  state: null,
  held: null,
  inventory: [],
  // camera
  camX: 0,
  camZ: 0,
  scale: 6, // pixels per block
  follow: true,
  // interaction
  dragStart: null, // { sx, sy, wx, wz } in screen + world coords
  dragging: false,
  panning: false,
  panLast: null,
  downButton: 0,
  // craft + station
  recipes: [],
  recipeTotal: 0,
  station: { open: false }
}

const CHUNK = 16
const $ = (id) => document.getElementById(id)
const canvas = $('map')
const ctx2d = canvas.getContext('2d')

// ------------------------------------------------------------------- ws
function connect () {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const ws = new WebSocket(`${proto}//${location.host}/ws`)
  S.ws = ws
  ws.onopen = () => {
    S.connected = true
    $('hud-conn').textContent = 'live'
    $('hud-conn').className = 'stat conn ok'
    sendViewport()
  }
  ws.onclose = () => {
    S.connected = false
    $('hud-conn').textContent = 'reconnecting…'
    $('hud-conn').className = 'stat conn bad'
    setTimeout(connect, 1500)
  }
  ws.onerror = () => { try { ws.close() } catch (e) {} }
  ws.onmessage = (ev) => {
    let msg
    try { msg = JSON.parse(ev.data) } catch (e) { return }
    handle(msg)
  }
}

function send (obj) {
  if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(obj))
}

function handle (msg) {
  switch (msg.t) {
    case 'hello':
      $('hud-bot').innerHTML = `<b>${esc(msg.username || 'connecting…')}</b>${msg.minecraft ? ' · mc ' + esc(msg.minecraft) : ''} · v' + esc(msg.version)`
      S.settings = msg.settings || []
      S.waypoints = msg.waypoints || []
      S.selection = msg.selection || { pos1: null, pos2: null }
      renderSettings()
      renderWaypoints()
      feed(`[minepilot] connected — type "help" for the command list`, 'log')
      break
    case 'state':
      S.state = msg
      renderHud()
      if (S.follow && msg.pos) {
        S.camX = msg.pos[0]
        S.camZ = msg.pos[2]
        requestDraw()
      }
      break
    case 'chunks':
      for (const ch of msg.chunks || []) S.chunks.set(`${ch.cx},${ch.cz}`, ch)
      requestDraw()
      break
    case 'entities':
      S.entities = new Map((msg.entities || []).map((e) => [e.id, e]))
      renderEntities()
      requestDraw()
      break
    case 'path':
      S.path = msg.points || []
      S.goalLabel = msg.goal
      S.partial = !!msg.partial
      requestDraw()
      break
    case 'selection':
      S.selection = msg.selection || { pos1: null, pos2: null }
      requestDraw()
      break
    case 'waypoints':
      S.waypoints = msg.waypoints || []
      renderWaypoints()
      requestDraw()
      break
    case 'chat':
      feed(`<span class="who">${esc(msg.from)}</span> ${esc(msg.text)}`)
      break
    case 'log':
      feed(esc(msg.text), 'log')
      break
    case 'settings':
      S.settings = msg.settings || []
      renderSettings()
      break
    case 'inventory':
      S.inventory = msg.items || []
      S.held = msg.held
      renderInventory()
      break
    case 'recipes':
      S.recipes = msg.recipes || []
      S.recipeTotal = msg.total || 0
      renderRecipes()
      break
    case 'station':
      S.station = msg
      renderStation()
      break
    default:
      break
  }
}

// ------------------------------------------------------------- viewport
function visibleChunkRange () {
  const w = canvas.width / (window.devicePixelRatio || 1)
  const h = canvas.height / (window.devicePixelRatio || 1)
  const blocksX = w / S.scale
  const blocksZ = h / S.scale
  return {
    cx0: Math.floor((S.camX - blocksX / 2) / CHUNK) - 1,
    cz0: Math.floor((S.camZ - blocksZ / 2) / CHUNK) - 1,
    cx1: Math.floor((S.camX + blocksX / 2) / CHUNK) + 1,
    cz1: Math.floor((S.camZ + blocksZ / 2) / CHUNK) + 1
  }
}

let viewportTimer = null
function sendViewport () {
  if (viewportTimer) return
  viewportTimer = setTimeout(() => {
    viewportTimer = null
    const v = visibleChunkRange()
    send({ t: 'viewport', ...v })
  }, 150)
}

// ----------------------------------------------------------------- draw
let drawPending = false
function requestDraw () {
  if (drawPending) return
  drawPending = true
  requestAnimationFrame(() => {
    drawPending = false
    draw()
  })
}

function resize () {
  const dpr = window.devicePixelRatio || 1
  canvas.width = canvas.clientWidth * dpr
  canvas.height = canvas.clientHeight * dpr
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0)
  requestDraw()
  sendViewport()
}
window.addEventListener('resize', resize)

function worldToScreen (wx, wz) {
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  return [w / 2 + (wx - S.camX) * S.scale, h / 2 + (wz - S.camZ) * S.scale]
}

function screenToWorld (sx, sy) {
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  return [S.camX + (sx - w / 2) / S.scale, S.camZ + (sy - h / 2) / S.scale]
}

function shade (hex, factor) {
  const v = hex.replace('#', '')
  const r = Math.round(parseInt(v.slice(0, 2), 16) * factor)
  const g = Math.round(parseInt(v.slice(2, 4), 16) * factor)
  const b = Math.round(parseInt(v.slice(4, 6), 16) * factor)
  return `rgb(${r},${g},${b})`
}

function draw () {
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  ctx2d.clearRect(0, 0, w, h)
  ctx2d.fillStyle = '#090a0c'
  ctx2d.fillRect(0, 0, w, h)

  // terrain: one rect per column (cheap and crisp at any zoom)
  const v = visibleChunkRange()
  const botY = S.state && S.state.pos ? S.state.pos[1] : 64
  const step = S.scale < 2 ? Math.max(1, Math.floor(2 / S.scale)) : 1 // coarse draw when zoomed far out
  ctx2d.beginPath()
  for (let cx = v.cx0; cx <= v.cx1; cx++) {
    for (let cz = v.cz0; cz <= v.cz1; cz++) {
      const ch = S.chunks.get(`${cx},${cz}`)
      if (!ch) continue
      for (let lx = 0; lx < CHUNK; lx += step) {
        for (let lz = 0; lz < CHUNK; lz += step) {
          const col = ch.cols[lz * CHUNK + lx]
          if (!col) continue
          const [sx, sy] = worldToScreen(cx * CHUNK + lx, cz * CHUNK + lz)
          const size = S.scale * step
          if (sx > w + size || sy > h + size || sx + size < 0 || sy + size < 0) continue
          const factor = 0.72 + Math.max(-0.35, Math.min(0.35, (col.y - botY) * 0.055))
          ctx2d.fillStyle = shade(col.c, factor)
          ctx2d.fillRect(sx, sy, size + 0.5, size + 0.5)
        }
      }
    }
  }

  // grid at high zoom
  if (S.scale >= 12) {
    ctx2d.strokeStyle = 'rgba(255,255,255,0.05)'
    ctx2d.lineWidth = 1
    const [gx0] = screenToWorld(0, 0)
    const [, gz0] = screenToWorld(0, 0)
    const [gx1] = screenToWorld(w, h)
    const [, gz1] = screenToWorld(w, h)
    ctx2d.beginPath()
    for (let x = Math.floor(gx0); x <= gx1; x++) {
      const [sx] = worldToScreen(x, 0)
      ctx2d.moveTo(sx, 0)
      ctx2d.lineTo(sx, h)
    }
    for (let z = Math.floor(gz0); z <= gz1; z++) {
      const [, sy] = worldToScreen(0, z)
      ctx2d.moveTo(0, sy)
      ctx2d.lineTo(w, sy)
    }
    ctx2d.stroke()
  }

  // selection rectangle
  if (S.selection.pos1 && S.selection.pos2) {
    const a = S.selection.pos1
    const b = S.selection.pos2
    const x0 = Math.min(a.x, b.x)
    const z0 = Math.min(a.z, b.z)
    const x1 = Math.max(a.x, b.x)
    const z1 = Math.max(a.z, b.z)
    const [sx0, sy0] = worldToScreen(x0, z0)
    const [sx1, sy1] = worldToScreen(x1 + 1, z1 + 1)
    ctx2d.fillStyle = 'rgba(139, 93, 255, 0.14)'
    ctx2d.fillRect(sx0, sy0, sx1 - sx0, sy1 - sy0)
    ctx2d.strokeStyle = '#8b5dff'
    ctx2d.lineWidth = 1.5
    ctx2d.setLineDash([6, 4])
    ctx2d.strokeRect(sx0, sy0, sx1 - sx0, sy1 - sy0)
    ctx2d.setLineDash([])
  }

  // path polyline + goal marker
  if (S.path.length > 1 && S.settings.find((s) => s.key === 'renderPath')?.value !== false) {
    ctx2d.strokeStyle = 'rgba(232, 179, 62, 0.9)'
    ctx2d.lineWidth = 2
    ctx2d.setLineDash([7, 5])
    ctx2d.beginPath()
    S.path.forEach((p, i) => {
      const [sx, sy] = worldToScreen(p[0], p[2])
      if (i === 0) ctx2d.moveTo(sx, sy)
      else ctx2d.lineTo(sx, sy)
    })
    ctx2d.stroke()
    ctx2d.setLineDash([])
    const last = S.path[S.path.length - 1]
    const [gx, gy] = worldToScreen(last[0], last[2])
    ctx2d.strokeStyle = '#e8b33e'
    ctx2d.lineWidth = 2
    ctx2d.beginPath()
    ctx2d.arc(gx, gy, 7, 0, Math.PI * 2)
    ctx2d.stroke()
  }

  // waypoints
  if (S.settings.find((s) => s.key === 'renderWaypoints')?.value !== false) {
    ctx2d.font = '10px system-ui'
    for (const wp of S.waypoints) {
      const [sx, sy] = worldToScreen(wp.x, wp.z)
      if (sx < -30 || sy < -30 || sx > w + 30 || sy > h + 30) continue
      ctx2d.fillStyle = '#8b5dff'
      ctx2d.beginPath()
      ctx2d.moveTo(sx, sy)
      ctx2d.lineTo(sx - 5, sy - 12)
      ctx2d.lineTo(sx + 5, sy - 12)
      ctx2d.closePath()
      ctx2d.fill()
      ctx2d.fillStyle = 'rgba(214,217,222,0.85)'
      ctx2d.fillText(wp.name, sx + 7, sy - 6)
    }
  }

  // entities
  const drawEnt = S.settings.find((s) => s.key === 'mapEntities')?.value !== false
  if (drawEnt) {
    const showNames = S.scale >= 4
    ctx2d.font = '10px system-ui'
    for (const e of S.entities.values()) {
      const [sx, sy] = worldToScreen(e.pos[0], e.pos[2])
      if (sx < -20 || sy < -20 || sx > w + 20 || sy > h + 20) continue
      const color = e.username ? '#5dd3ff' : (e.hostile ? '#e8635a' : '#cfc3a5')
      ctx2d.fillStyle = color
      ctx2d.beginPath()
      ctx2d.arc(sx, sy, e.username ? 5 : 3.5, 0, Math.PI * 2)
      ctx2d.fill()
      if (showNames) {
        ctx2d.fillStyle = 'rgba(214,217,222,0.8)'
        ctx2d.fillText(e.username || e.type, sx + 7, sy + 3)
      }
    }
  }

  // the bot: arrow rotated by yaw
  if (S.state && S.state.pos) {
    const [sx, sy] = worldToScreen(S.state.pos[0], S.state.pos[2])
    const yaw = S.state.yaw || 0
    ctx2d.save()
    ctx2d.translate(sx, sy)
    ctx2d.rotate(-yaw)
    ctx2d.fillStyle = S.state.paused ? '#e8b33e' : '#ffffff'
    ctx2d.beginPath()
    ctx2d.moveTo(0, -9)
    ctx2d.lineTo(-6, 7)
    ctx2d.lineTo(0, 3.5)
    ctx2d.lineTo(6, 7)
    ctx2d.closePath()
    ctx2d.fill()
    ctx2d.restore()
  }

  // drag-in-progress selection preview
  if (S.dragging && S.dragStart && S.downButton === 0) {
    const cur = S.dragCur
    if (cur) {
      const [ax, ay] = worldToScreen(S.dragStart.wx, S.dragStart.wz)
      const [bx, by] = worldToScreen(cur.wx, cur.wz)
      ctx2d.strokeStyle = '#8b5dff'
      ctx2d.lineWidth = 1.5
      ctx2d.setLineDash([6, 4])
      ctx2d.strokeRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay))
      ctx2d.setLineDash([])
    }
  }

  $('map-scale').textContent = `${S.scale.toFixed(S.scale < 1 ? 2 : 1)} px/block${S.follow ? ' · following' : ''}`
}

// ---------------------------------------------------------- interactions
let dragCur = null
S.dragCur = null

canvas.addEventListener('contextmenu', (e) => e.preventDefault())

canvas.addEventListener('mousedown', (e) => {
  const rect = canvas.getBoundingClientRect()
  const sx = e.clientX - rect.left
  const sy = e.clientY - rect.top
  const [wx, wz] = screenToWorld(sx, sy)
  S.downButton = e.button
  if (e.button === 1 || e.button === 2 || e.shiftKey) {
    S.panning = true
    S.panLast = { sx, sy }
    canvas.classList.add('panning')
    return
  }
  S.dragStart = { sx, sy, wx, wz, shift: e.shiftKey }
  S.dragging = true
  dragCur = { wx, wz }
})

canvas.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect()
  const sx = e.clientX - rect.left
  const sy = e.clientY - rect.top
  if (S.panning && S.panLast) {
    S.camX -= (sx - S.panLast.sx) / S.scale
    S.camZ -= (sy - S.panLast.sy) / S.scale
    S.follow = false
    S.panLast = { sx, sy }
    requestDraw()
    sendViewport()
    return
  }
  if (S.dragging) {
    const [wx, wz] = screenToWorld(sx, sy)
    dragCur = { wx, wz }
    S.dragCur = dragCur
    requestDraw()
  }
})

canvas.addEventListener('mouseup', (e) => {
  const rect = canvas.getBoundingClientRect()
  const sx = e.clientX - rect.left
  const sy = e.clientY - rect.top
  if (S.panning) {
    S.panning = false
    S.panLast = null
    canvas.classList.remove('panning')
    return
  }
  if (!S.dragging || !S.dragStart) return
  const [wx, wz] = screenToWorld(sx, sy)
  const moved = Math.hypot(sx - S.dragStart.sx, sy - S.dragStart.sy)
  S.dragging = false
  dragCur = null
  S.dragCur = null

  if (moved < 5) {
    // a click — walk there (left: on top; right handled above as pan)
    send({ t: 'click', x: Math.floor(wx), z: Math.floor(wz), y: S.state && S.state.pos ? Math.floor(S.state.pos[1]) : 96, button: 'left' })
    return
  }

  // a drag — selection between the two world corners
  const x0 = Math.floor(Math.min(S.dragStart.wx, wx))
  const z0 = Math.floor(Math.min(S.dragStart.wz, wz))
  const x1 = Math.floor(Math.max(S.dragStart.wx, wx))
  const z1 = Math.floor(Math.max(S.dragStart.wz, wz))
  const y = S.state && S.state.node ? S.state.node.y : 64
  send({ t: 'select', x0, z0, x1, z1, y0: y, y1: y, z0b: z0 })
  showSelectionMenu(e.clientX - rect.left + canvas.getBoundingClientRect().left - canvas.getBoundingClientRect().left + (e.clientX - canvas.getBoundingClientRect().left), e.clientY, { x0, z0, x1, z1, y })
})

canvas.addEventListener('wheel', (e) => {
  e.preventDefault()
  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
  S.scale = Math.max(0.35, Math.min(24, S.scale * factor))
  requestDraw()
  sendViewport()
}, { passive: false })

// double click: center on the spot and stop following
canvas.addEventListener('dblclick', (e) => {
  const rect = canvas.getBoundingClientRect()
  const [wx, wz] = screenToWorld(e.clientX - rect.left, e.clientY - rect.top)
  S.camX = wx
  S.camZ = wz
  S.follow = false
  requestDraw()
  sendViewport()
})

// ------------------------------------------------------------- popups
function popup (x, y, title, items) {
  const menu = $('map-menu')
  menu.innerHTML = ''
  if (title) {
    const t = document.createElement('div')
    t.className = 'title'
    t.textContent = title
    menu.appendChild(t)
  }
  for (const item of items) {
    if (item === '-') {
      const sep = document.createElement('div')
      sep.className = 'sep'
      menu.appendChild(sep)
      continue
    }
    const b = document.createElement('button')
    b.textContent = item.label
    if (item.danger) b.className = 'danger'
    b.onclick = () => {
      hidePopup()
      item.fn()
    }
    menu.appendChild(b)
  }
  menu.style.left = Math.min(x, window.innerWidth - 200) + 'px'
  menu.style.top = Math.min(y, window.innerHeight - 240) + 'px'
  menu.classList.remove('hidden')
}

function hidePopup () {
  $('map-menu').classList.add('hidden')
}

document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('#map-menu')) hidePopup()
})

function showSelectionMenu (x, y, sel) {
  const w = sel.x1 - sel.x0 + 1
  const d = sel.z1 - sel.z0 + 1
  popup(x, y, `selection ${w}×${d} @ y${sel.y}`, [
    { label: 'excavate (dig it all)', fn: () => send({ t: 'command', text: 'excavate sel' }) },
    { label: 'fill… (place a block)', fn: () => {
      const block = prompt('fill with block name:', 'dirt')
      if (block) send({ t: 'command', text: `sel fill ${block}` })
    } },
    { label: 'walls…', fn: () => {
      const block = prompt('wall block name:', 'cobblestone')
      if (block) send({ t: 'command', text: `sel walls ${block}` })
    } },
    { label: 'shell…', fn: () => {
      const block = prompt('shell block name:', 'glass')
      if (block) send({ t: 'command', text: `sel shell ${block}` })
    } },
    '-',
    { label: 'clear area (to air)', danger: true, fn: () => send({ t: 'command', text: 'sel cleararea' }) },
    { label: 'copy', fn: () => send({ t: 'command', text: 'sel copy' }) },
    { label: 'undo', fn: () => send({ t: 'command', text: 'sel undo' }) },
    { label: 'drop selection', fn: () => send({ t: 'command', text: 'sel clear' }) }
  ])
}

// entity list clicks -> follow / attack / interact menu
const FEEDABLE = /cow|sheep|mooshroom|pig|chicken|rabbit|horse|donkey|mule|wolf|cat|ocelot|fox|panda|turtle|camel|hoglin|frog|goat|bee|sniffer|armadillo/
function entityMenu (e, ent) {
  const rect = $('side').getBoundingClientRect()
  const items = [
    { label: 'follow', fn: () => send({ t: 'command', text: ent.username ? `follow player ${ent.username}` : `follow entity ${ent.type}` }) },
    { label: 'attack', danger: true, fn: () => send({ t: 'command', text: `attack ${ent.username || ent.type}` }) },
    { label: 'goto', fn: () => send({ t: 'command', text: `goto ${Math.floor(ent.pos[0])} ${Math.floor(ent.pos[1])} ${Math.floor(ent.pos[2])}` }) }
  ]
  if (String(ent.type) === 'villager') {
    items.push({ label: 'trade', fn: () => send({ t: 'station:open', kind: 'villager', entityId: ent.id }) })
  }
  if (FEEDABLE.test(String(ent.type))) {
    items.push({ label: 'feed', fn: () => send({ t: 'command', text: `feed ${ent.type}` }) })
    items.push({ label: 'breed', fn: () => send({ t: 'command', text: `breed ${ent.type}` }) })
  }
  popup(rect.left - 190, e.clientY, ent.username || ent.type, items)
}

// --------------------------------------------------------------- render
function esc (s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function renderHud () {
  const st = S.state
  if (!st) return
  const hearts = '♥'.repeat(Math.round((st.health ?? 20) / 2))
  const heartsOff = '♥'.repeat(Math.max(0, 10 - Math.round((st.health ?? 20) / 2)))
  $('hud-health').innerHTML = `<span class="on">${hearts}</span><span class="off">${heartsOff}</span>`
  const food = '🍗'.repeat(Math.round((st.food ?? 20) / 2))
  $('hud-food').innerHTML = `<span class="on">${food}</span>`
  if (st.node) $('hud-pos').textContent = `${st.node.x} ${st.node.y} ${st.node.z}`
  const task = st.task || {}
  const autoTag = st.auto && st.auto.on ? ` · auto: ${st.auto.activity}` : ''
  $('hud-task').innerHTML = `<b>${esc(task.paused ? 'paused' : (task.task || 'idle'))}</b>${task.goal ? ' · ' + esc(task.goal) : ''}${esc(autoTag)}`
  $('hud-eta').textContent = st.eta && !st.eta.arrived ? `${st.eta.blocks} blocks · ~${st.eta.seconds}s` : (st.eta && st.eta.arrived ? 'at goal' : '')
  $('hud-held').innerHTML = st.held ? `hand: <b>${esc(st.held)}</b>` : ''
  const ab = $('hud-auto')
  const on = !!(st.auto && st.auto.on)
  ab.textContent = on ? `auto: ${st.auto.activity}` : 'auto: off'
  ab.className = 'auto ' + (on ? 'on' : 'off')
  ab.title = on ? `full-auto — ${st.auto.reason}` : 'the full-auto survival brain'
}

// the full-auto toggle drives the same `auto` command as the console
$('hud-auto').onclick = () => {
  const on = !!(S.state && S.state.auto && S.state.auto.on)
  send({ t: 'command', text: on ? 'auto off' : 'auto on' })
}

function renderEntities () {
  const list = $('entity-list')
  const bot = S.state && S.state.pos ? S.state.pos : null
  const arr = [...S.entities.values()]
  if (arr.length === 0) {
    list.innerHTML = '<div class="entity" style="cursor:default"><span class="name" style="color:var(--dim)">nothing nearby</span></div>'
    return
  }
  arr.sort((a, b) => {
    if (!bot) return 0
    const da = Math.hypot(a.pos[0] - bot[0], a.pos[2] - bot[2])
    const db = Math.hypot(b.pos[0] - bot[0], b.pos[2] - bot[2])
    return da - db
  })
  list.innerHTML = ''
  for (const e of arr.slice(0, 40)) {
    const el = document.createElement('div')
    el.className = 'entity' + (e.username ? ' player' : '') + (e.hostile ? ' hostile' : '') + (e.type === 'item' ? ' item' : '')
    const d = bot ? Math.hypot(e.pos[0] - bot[0], e.pos[2] - bot[2]).toFixed(0) : '?'
    el.innerHTML = `<span class="dot"></span><span class="name">${esc(e.username || e.type)}</span><span class="dist">${d}m</span>`
    el.onclick = (ev) => entityMenu(ev, e)
    list.appendChild(el)
  }
}

function renderWaypoints () {
  const list = $('waypoint-list')
  if (S.waypoints.length === 0) {
    list.innerHTML = '<div class="waypoint" style="cursor:default"><span class="name" style="color:var(--dim)">no waypoints — "#wp save user name"</span></div>'
    return
  }
  list.innerHTML = ''
  for (const wp of S.waypoints) {
    const el = document.createElement('div')
    el.className = 'waypoint'
    el.innerHTML = `<span class="pin">◆</span><span class="name">${esc(wp.name)}</span><span class="tag">${esc(wp.tag)}</span><span class="coords">${wp.x} ${wp.y} ${wp.z}</span>`
    el.onclick = () => send({ t: 'command', text: `wp goal ${wp.name}` })
    list.appendChild(el)
  }
}

function renderInventory () {
  const grid = $('inventory-grid')
  grid.innerHTML = ''
  for (const it of S.inventory) {
    const el = document.createElement('div')
    el.className = 'slot' + (it.name === S.held ? ' held' : '')
    el.innerHTML = `<span><b>${esc(shortName(it.name))}</b>${it.count > 1 ? ' ×' + it.count : ''}</span>`
    el.title = it.name
    el.onclick = (ev) => {
      const rect = $('side').getBoundingClientRect()
      popup(rect.left - 190, ev.clientY, it.name, [
        { label: 'equip to hand', fn: () => send({ t: 'inventory:equip', name: it.name }) },
        { label: 'drop stack', danger: true, fn: () => send({ t: 'inventory:drop', name: it.name }) },
        { label: 'craft more…', fn: () => send({ t: 'command', text: `craft ${it.name} 1` }) }
      ])
    }
    grid.appendChild(el)
  }
  if (S.inventory.length === 0) {
    grid.innerHTML = '<div class="slot" style="grid-column:1/-1;aspect-ratio:auto;padding:10px;cursor:default">inventory empty</div>'
  }
}

function shortName (name) {
  return String(name).replace(/_/g, ' ').slice(0, 12)
}

function renderSettings () {
  renderSettingsFiltered('')
}

function renderSettingsFiltered (query) {
  const list = $('settings-list')
  const q = query.trim().toLowerCase()
  const items = S.settings.filter((s) => !q || s.key.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))
  list.innerHTML = ''
  for (const s of items) {
    const el = document.createElement('div')
    el.className = 'setting' + (s.modified ? ' modified' : '')
    const valHtml = s.type === 'bool'
      ? `<button data-key="${esc(s.key)}" data-val="${!s.value}">${s.value ? '✓ true' : 'false'}</button>`
      : `<input type="text" data-key="${esc(s.key)}" value="${esc(JSON.stringify(s.value).replace(/^"|"$/g, ''))}">`
    el.innerHTML = `<div class="key">${esc(s.key)}</div><div class="desc">${esc(s.description)}</div><div class="ctrl">${valHtml}</div><div class="cat">${esc(s.category)}</div>`
    list.appendChild(el)
  }
  // wire the controls
  list.querySelectorAll('button[data-key]').forEach((b) => {
    b.onclick = () => send({ t: 'set', key: b.dataset.key, value: b.dataset.val })
  })
  list.querySelectorAll('input[data-key]').forEach((inp) => {
    inp.onchange = () => send({ t: 'set', key: inp.dataset.key, value: inp.value })
  })
}

$('settings-search').addEventListener('input', (e) => renderSettingsFiltered(e.target.value))

// --------------------------------------------------------------- craft tab
// recipes arrive availability-decorated from the server; the craft action
// itself is the plain `craft <item> <n>` command, which walks to a table
// when the recipe needs one — the same path the console uses.
let recipeSearchTimer = null
$('recipe-search').addEventListener('input', (e) => {
  if (recipeSearchTimer) clearTimeout(recipeSearchTimer)
  recipeSearchTimer = setTimeout(() => {
    send({ t: 'recipes:get', q: e.target.value, craftableFirst: !e.target.value })
  }, 200)
})

function renderRecipes () {
  const list = $('recipe-list')
  const note = $('craft-note')
  note.textContent = `${S.recipes.length} shown · ${S.recipeTotal} recipes known · green = craftable right now`
  if (S.recipes.length === 0) {
    list.innerHTML = '<div class="recipe"><span style="color:var(--dim)">nothing matches — clear the search or give the bot materials</span></div>'
    return
  }
  list.innerHTML = ''
  for (const r of S.recipes) {
    const el = document.createElement('div')
    el.className = 'recipe' + (r.craftable ? ' craftable' : '')
    const ings = r.ingredients.map((i) => {
      const cls = i.have >= i.need ? 'have' : 'lack'
      return `<span class="ing ${cls}">${esc(shortName(i.name))} ${i.have}/${i.need}</span>`
    }).join('')
    el.innerHTML = `
      <div class="r-head">
        <span class="r-name">${esc(r.displayName || r.name)}</span>
        ${r.count > 1 ? `<span class="r-count">×${r.count}</span>` : ''}
        ${r.requiresTable ? '<span class="r-table" title="needs a crafting table in reach">table</span>' : ''}
      </div>
      <div class="r-ings">${ings}</div>`
    const btn = document.createElement('button')
    btn.className = 'r-craft'
    btn.textContent = r.craftable ? 'craft' : 'missing ' + r.missing
    btn.disabled = !r.craftable
    btn.onclick = () => {
      const n = prompt(`craft how many ${r.name}? (one craft makes ${r.count})`, '1')
      if (!n) return
      send({ t: 'command', text: `craft ${r.name} ${Number(n) || 1}` })
    }
    el.appendChild(btn)
    list.appendChild(el)
  }
}

// ------------------------------------------------------------ station tab
$('st-open-chest').onclick = () => send({ t: 'station:open', kind: 'chest' })
$('st-open-furnace').onclick = () => send({ t: 'station:open', kind: 'furnace' })
$('st-open-table').onclick = () => send({ t: 'station:open', kind: 'crafting_table' })
$('st-close').onclick = () => send({ t: 'station:action', action: 'close' })

function stationItemMenu (e, it, extra) {
  const rect = $('side').getBoundingClientRect()
  popup(rect.left - 190, e.clientY, it.name, [
    ...extra,
    { label: 'equip to hand', fn: () => send({ t: 'inventory:equip', name: it.name }) },
    { label: 'drop stack', danger: true, fn: () => send({ t: 'inventory:drop', name: it.name }) }
  ])
}

function stationInventoryGrid (title) {
  // the bot's own inventory, clickable for transfers into the open station
  const wrap = document.createElement('div')
  wrap.className = 'station-inv'
  const h = document.createElement('div')
  h.className = 'st-title'
  h.textContent = title
  wrap.appendChild(h)
  const grid = document.createElement('div')
  grid.className = 'st-grid'
  if (S.inventory.length === 0) {
    grid.innerHTML = '<div class="st-slot empty">nothing carried</div>'
  }
  for (const it of S.inventory) {
    const el = document.createElement('div')
    el.className = 'st-slot'
    el.innerHTML = `<b>${esc(shortName(it.name))}</b>${it.count > 1 ? ' ×' + it.count : ''}`
    el.title = it.name
    el.onclick = (ev) => {
      const st = S.station || {}
      if (st.kind === 'chest') {
        stationItemMenu(ev, it, [
          { label: 'deposit stack', fn: () => send({ t: 'station:action', action: 'deposit', name: it.name }) },
          { label: 'deposit 1', fn: () => send({ t: 'station:action', action: 'deposit', name: it.name, count: 1 }) }
        ])
      } else if (st.kind === 'furnace') {
        stationItemMenu(ev, it, [
          { label: 'put in smelt slot', fn: () => send({ t: 'station:action', action: 'put', role: 'input', name: it.name }) },
          { label: 'put in fuel slot', fn: () => send({ t: 'station:action', action: 'put', role: 'fuel', name: it.name }) }
        ])
      }
    }
    grid.appendChild(el)
  }
  wrap.appendChild(grid)
  return wrap
}

function renderStation () {
  const body = $('station-body')
  const st = S.station || { open: false }
  if (!st.open) {
    body.innerHTML = '<div class="st-empty">no station open — click <b>open chest</b> / <b>open furnace</b> to walk to the nearest one<br><span style="color:var(--dim)">a villager in range can be opened from the <i>nearby</i> list</span></div>'
    return
  }
  body.innerHTML = ''

  if (st.kind === 'chest') {
    const h = document.createElement('div')
    h.className = 'st-title'
    h.textContent = `chest at ${st.pos ? st.pos.map(Math.floor).join(' ') : '?'}`
    body.appendChild(h)
    const grid = document.createElement('div')
    grid.className = 'st-grid'
    const items = st.items || []
    if (items.length === 0) grid.innerHTML = '<div class="st-slot empty">chest is empty</div>'
    for (const it of items) {
      const el = document.createElement('div')
      el.className = 'st-slot'
      el.innerHTML = `<b>${esc(shortName(it.name))}</b>${it.count > 1 ? ' ×' + it.count : ''}`
      el.title = it.name
      el.onclick = (ev) => stationItemMenu(ev, it, [
        { label: 'withdraw stack', fn: () => send({ t: 'station:action', action: 'withdraw', name: it.name }) },
        { label: 'withdraw 1', fn: () => send({ t: 'station:action', action: 'withdraw', name: it.name, count: 1 }) }
      ])
      grid.appendChild(el)
    }
    body.appendChild(grid)
    const all = document.createElement('div')
    all.className = 'row'
    all.innerHTML = '<button id="st-dep-all">deposit everything</button>'
    body.appendChild(all)
    body.querySelector('#st-dep-all').onclick = () => send({ t: 'station:action', action: 'depositAll' })
    body.appendChild(stationInventoryGrid('bot inventory — click to deposit'))
  } else if (st.kind === 'furnace') {
    const h = document.createElement('div')
    h.className = 'st-title'
    h.textContent = `furnace at ${st.pos ? st.pos.map(Math.floor).join(' ') : '?'}`
    body.appendChild(h)
    const prog = document.createElement('div')
    prog.className = 'st-progress'
    const pct = Math.round((st.progress || 0) * 100)
    const burn = Math.round((st.burn || 0) * 100)
    prog.innerHTML = `
      <div class="bar"><div class="fill cook" style="width:${pct}%"></div></div>
      <div class="bar"><div class="fill burn" style="width:${burn}%"></div></div>
      <div class="tiny mono">smelt ${pct}% · fuel ${burn}%</div>`
    body.appendChild(prog)
    const grid = document.createElement('div')
    grid.className = 'st-grid three'
    const slot = (label, item, actions) => {
      const el = document.createElement('div')
      el.className = 'st-slot big' + (item ? '' : ' empty')
      el.innerHTML = `<span class="tag">${label}</span>${item ? `<b>${esc(shortName(item.name))}</b>${item.count > 1 ? ' ×' + item.count : ''}` : '—'}`
      if (item && actions.length > 0) {
        el.onclick = (ev) => stationItemMenu(ev, item, actions)
      }
      return el
    }
    grid.appendChild(slot('smelt', st.input, [{ label: 'take back', fn: () => send({ t: 'station:action', action: 'take', role: 'input' }) }]))
    grid.appendChild(slot('fuel', st.fuel, [{ label: 'take back', fn: () => send({ t: 'station:action', action: 'take', role: 'fuel' }) }]))
    grid.appendChild(slot('output', st.output, [{ label: 'take', fn: () => send({ t: 'station:action', action: 'take', role: 'output' }) }]))
    body.appendChild(grid)
    body.appendChild(stationInventoryGrid('bot inventory — click to put'))
  } else if (st.kind === 'villager') {
    const h = document.createElement('div')
    h.className = 'st-title'
    h.textContent = 'villager trades'
    body.appendChild(h)
    for (const tr of st.trades || []) {
      const el = document.createElement('div')
      el.className = 'recipe' + (tr.disabled ? '' : ' craftable')
      const ins = [tr.input1, tr.input2].filter(Boolean)
        .map((i) => `<span class="ing have">${esc(shortName(i.name))} ×${i.count}</span>`).join('')
      const out = tr.output ? `<span class="ing out">${esc(shortName(tr.output.name))} ×${tr.output.count}</span>` : ''
      el.innerHTML = `<div class="r-ings">${ins}<span class="ing arrow">→</span>${out}</div>`
      const btn = document.createElement('button')
      btn.className = 'r-craft'
      btn.textContent = tr.disabled ? 'locked' : 'trade'
      btn.disabled = !!tr.disabled
      btn.onclick = () => send({ t: 'station:action', action: 'trade', index: tr.index, times: 1 })
      el.appendChild(btn)
      body.appendChild(el)
    }
    if ((st.trades || []).length === 0) {
      body.innerHTML += '<div class="st-slot empty">this villager offers nothing (or trades are loading)</div>'
    }
  } else if (st.kind === 'crafting_table') {
    const h = document.createElement('div')
    h.className = 'st-title'
    h.textContent = `crafting table at ${st.pos ? st.pos.map(Math.floor).join(' ') : '?'}`
    body.appendChild(h)
    body.innerHTML += '<div class="st-empty">table recipes are unlocked — pick what to craft in the <b>craft</b> tab</div>'
  }
}

// refresh recipes when the inventory ticks (availability changes)
let lastInvSignature = ''
setInterval(() => {
  const sig = S.inventory.map((i) => i.name + ':' + i.count).join('|')
  if (sig !== lastInvSignature) {
    lastInvSignature = sig
    send({ t: 'recipes:get', q: $('recipe-search').value, craftableFirst: !$('recipe-search').value })
  }
}, 2500)

// ------------------------------------------------------------- console
function feed (html, cls) {
  const el = document.createElement('div')
  el.className = 'line' + (cls ? ' ' + cls : '')
  el.innerHTML = html
  const f = $('feed')
  f.appendChild(el)
  while (f.children.length > 400) f.removeChild(f.firstChild)
  f.scrollTop = f.scrollHeight
}

const history = []
let historyIdx = -1
$('cmd').addEventListener('keydown', (e) => {
  const input = $('cmd')
  if (e.key === 'Enter') {
    const text = input.value.trim()
    if (!text) return
    history.push(text)
    historyIdx = history.length
    input.value = ''
    feed(`<span class="who">›</span> ${esc(text)}`, 'cmd')
    send({ t: 'command', text })
  } else if (e.key === 'ArrowUp') {
    if (historyIdx > 0) {
      historyIdx--
      input.value = history[historyIdx] || ''
    }
    e.preventDefault()
  } else if (e.key === 'ArrowDown') {
    if (historyIdx < history.length - 1) {
      historyIdx++
      input.value = history[historyIdx] || ''
    } else {
      historyIdx = history.length
      input.value = ''
    }
    e.preventDefault()
  }
})

// tabs
$('side-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button')
  if (!btn) return
  for (const b of $('side-tabs').querySelectorAll('button')) b.classList.remove('active')
  btn.classList.add('active')
  for (const body of document.querySelectorAll('.tab-body')) body.classList.add('hidden')
  $('tab-' + btn.dataset.tab).classList.remove('hidden')
})

// --------------------------------------------------------------- boot
resize()
connect()
setInterval(() => sendViewport(), 4000) // refresh the visible viewport periodically
$('cmd').focus()
