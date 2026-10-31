'use strict'

// the command grammar — minepilot's port of baritone's command system.
// pure module: no mineflayer, no timers, no network. the same language is
// accepted from in-game chat (with the # prefix) and the web console,
// and every command here maps 1:1 onto a baritone command or a documented
// minepilot extra.
//
// names and argument shapes follow baritone's USAGE.md and the command
// sources (DefaultCommands.java, SelCommand.java, WaypointsCommand.java,
// FollowCommand.java) so muscle memory carries over:
//
//   baritone                       minepilot
//   -----------------------------  --------------------------------
//   #goto x y z / x z / block      goto x y z | x z | <block>
//   #goal x y z / x z / y / clear  goal ... | clear
//   #path                          path
//   #mine 64 diamond_ore           mine 64 diamond_ore | mine diamond_ore 64
//   #follow player X / players     follow player X | players | entity pig ...
//   #tunnel [h w d]                tunnel 3 2 100
//   #farm [range] [waypoint]       farm 48
//   #explore [x z]                 explore 0 0
//   #explorefilter f.json [inv]    explorefilter f.json
//   #build s.schematic [x y z]     build tower ~ 70 ~
//   #sel pos1/pos2/fill/...        sel fill dirt ...
//   #wp save|goal|list|...         wp save user home
//   #set key value | list|reset    set allowBreak false
//   #pause/#resume/#paused         same
//   #cancel/#stop/#forcecancel     same
//   #eta #proc #version #repack    same
//   #render #reloadall #saveall    same
//   #gc #find #blacklist           same
//   #surface/#top #axis #invert    same
//   #thisway 1000                  same
//   #come                          same
//   #click x y z                   same (map clicks do this too)
//   #elytra x z                    same
//   #damn daniel                   same. obviously.
//
// minepilot extras (no baritone equivalent): say, where, drop, eat, craft,
// chest, inventory, status, attack, flee, waypoint aliases sethome/home,
// excavate (the old baritone cuboid digger, kept because it is handy).

const MAX_COORD = 29999984
const NAME_RE = /^[A-Za-z0-9_]{1,16}$/
const MAX_MESSAGE = 256
const BLOCK_NAME_RE = /^[a-z0-9_]*[a-z][a-z0-9_]*$/ // must contain a letter ("64" is not a block)
const ITEM_NAME_RE = /^[a-z0-9_]+$/
const FILE_NAME_RE = /^[A-Za-z0-9_\-./]{1,64}$/
const WAYPOINT_NAME_RE = /^[A-Za-z0-9_\-]{1,32}$/

function num (token) {
  if (!/^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(token)) return null
  const v = Number(token)
  return Number.isFinite(v) ? v : null
}

function int (token) {
  const v = num(token)
  return v !== null && Number.isInteger(v) ? v : null
}

function coordError (token) {
  return `"${token}" is not a coordinate`
}

function fail (error) {
  return { ok: false, error }
}

// ~ relative coordinate against an anchor (baritone's RelativeBlockPos);
// returns { ok, value } where value is an OFFSET from the anchor
function relative (token) {
  if (token === '~') return { ok: true, value: 0, rel: true }
  if (token.startsWith('~')) {
    const v = num(token.slice(1))
    if (v === null) return { ok: false, error: coordError(token) }
    return { ok: true, value: v, rel: true }
  }
  const v = num(token)
  if (v === null) return { ok: false, error: coordError(token) }
  return { ok: true, value: v, rel: false }
}

const COMMANDS = [
  { name: 'help', args: '[command]', help: 'list commands, or detail one', baritone: true },
  { name: 'set', args: '[key] [value] | list | modified | reset [key]', help: 'read or change settings', baritone: true },
  { name: 'goal', args: '<x y z | x z | y | clear>', help: 'set the goal without moving; #path walks it', baritone: true },
  { name: 'goto', args: '<x y z | x z | block>', help: 'pathfind to coordinates or the nearest block of a type', baritone: true },
  { name: 'path', args: '', help: 'path toward the current goal', baritone: true },
  { name: 'proc', args: '', help: 'info about the running process', baritone: true },
  { name: 'eta', args: '', help: 'estimated distance and time to the goal', baritone: true },
  { name: 'version', args: '', help: 'bot, mineflayer and minecraft versions', baritone: true },
  { name: 'repack', args: '', help: 'rebuild the map view cache', baritone: true },
  { name: 'build', args: '<schematic> [x y z]', help: 'build a schematic here or at coords (~ supported)', baritone: true },
  { name: 'litematica', args: '<file>', help: 'build a .litematic file', baritone: true },
  { name: 'come', args: '[player]', help: 'walk to the player who asked (or a named player)', baritone: true },
  { name: 'axis', args: '[y]', help: 'head for the nearest axis at this height', baritone: true },
  { name: 'forcecancel', args: '', help: 'hard cancel: goal, processes, controls', baritone: true },
  { name: 'gc', args: '', help: 'report memory and try to free some', baritone: true },
  { name: 'invert', args: '', help: 'invert the current goal and path away', baritone: true },
  { name: 'tunnel', args: '[height width depth]', help: 'dig a tunnel (default 2x1x...) along your facing', baritone: true },
  { name: 'render', args: '', help: 'toggle path/goal rendering on the map', baritone: true },
  { name: 'farm', args: '[range] [waypoint]', help: 'harvest and replant crops', baritone: true },
  { name: 'follow', args: '<player X | players | entity T... | entities | off>', help: 'follow players or entities', baritone: true },
  { name: 'pickup', args: '[radius]', help: 'collect nearby dropped items', baritone: true },
  { name: 'explorefilter', args: '<file> [invert]', help: 'restrict explore to a chunk list', baritone: true },
  { name: 'reloadall', args: '', help: 'reload schematics and waypoints from disk', baritone: true },
  { name: 'saveall', args: '', help: 'save waypoints and settings to disk', baritone: true },
  { name: 'explore', args: '[x z | radius]', help: 'explore toward the closest unseen chunk', baritone: true },
  { name: 'blacklist', args: '[x y z]', help: 'stop the mine process from targeting the closest block', baritone: true },
  { name: 'find', args: '<block>', help: 'report where the nearest block of a type is', baritone: true },
  { name: 'mine', args: '<count> <blocks...> | <blocks...> [count]', help: 'mine blocks by name, with vein mining', baritone: true },
  { name: 'click', args: '<x y z>', help: 'walk to and right-click a block (door, chest, lever...)', baritone: true },
  { name: 'surface', args: '', help: 'head for the surface', baritone: true },
  { name: 'thisway', args: '<distance>', help: 'set a goal in your facing direction', baritone: true },
  { name: 'waypoints', args: '<save|goal|list|info|delete|clear> ...', help: 'manage waypoints (tags: home, death, user)', baritone: true },
  { name: 'sel', args: '<pos1|pos2|clear|undo|fill|walls|shell|sphere|...>', help: 'selection shape tools', baritone: true },
  { name: 'elytra', args: '<x z> | <x y z>', help: 'fly toward coordinates with an elytra', baritone: true },
  { name: 'pause', args: '', help: 'pause the current process', baritone: true },
  { name: 'resume', args: '', help: 'resume the paused process', baritone: true },
  { name: 'paused', args: '', help: 'is anything paused?', baritone: true },
  { name: 'cancel', args: '', help: 'stop pathing and clear the task', baritone: true },
  { name: 'stop', args: '', help: 'alias of cancel', baritone: true },
  { name: 'damn', args: 'daniel', help: 'damn daniel', baritone: true },
  // minepilot extras
  { name: 'excavate', args: '<x1 y1 z1> <x2 y2 z2> | sel', help: 'dig out a cuboid (or the current selection)', baritone: false },
  { name: 'attack', args: '<entity> | off', help: 'hunt and attack an entity type or player', baritone: false },
  { name: 'flee', args: '[radius]', help: 'run away from the nearest threat', baritone: false },
  { name: 'say', args: '<message>', help: 'send a chat message as the bot', baritone: false },
  { name: 'where', args: '', help: 'report current coordinates', baritone: false },
  { name: 'drop', args: '[all | hand | <item>]', help: 'toss items', baritone: false },
  { name: 'eat', args: '', help: 'eat once from the inventory', baritone: false },
  { name: 'craft', args: '<item> [count]', help: 'craft an item from carried materials', baritone: false },
  { name: 'chest', args: '<deposit|withdraw|list> [filter]', help: 'interact with a chest in range', baritone: false },
  { name: 'feed', args: '<entity> [item]', help: 'feed a nearby animal (breeding food by default)', baritone: false },
  { name: 'breed', args: '<entity>', help: 'feed two animals of a kind so they breed', baritone: false },
  { name: 'sleep', args: '', help: 'walk to the nearest bed and sleep', baritone: false },
  { name: 'wake', args: '', help: 'get out of the bed', baritone: false },
  { name: 'activate', args: '<block>', help: 'right-click the nearest block of a type (lever, door...)', baritone: false },
  { name: 'auto', args: '[on | off | status]', help: 'the full-auto survival brain: reflexes, needs, goals', baritone: false },
  { name: 'inventory', args: '[hand | armor]', help: 'list what the bot carries', baritone: false },
  { name: 'status', args: '', help: 'full status readout', baritone: false },
  { name: 'spawn', args: '', help: 'walk back to world spawn', baritone: false }
]

// baritone's command aliases
const ALIASES = {
  '?': 'help',
  modified: 'set',
  mod: 'set',
  baritone: 'set',
  modifiedsettings: 'set',
  reset: 'set',
  top: 'surface',
  s: 'sel',
  selection: 'sel',
  wp: 'waypoints',
  c: 'cancel'
}

function suggest (name) {
  const n = String(name).toLowerCase()
  // exact prefix first, then increasingly short prefixes
  for (const c of COMMANDS) {
    if (c.name.startsWith(n) && n.length >= 2) return c.name
  }
  for (const len of [4, 3, 2]) {
    if (n.length < len) continue
    const pre = n.slice(0, len)
    const hits = COMMANDS.filter((c) => c.name.startsWith(pre))
    if (hits.length >= 1) return hits[0].name
  }
  return null
}

function parseCoordTriple (rest, what) {
  // accepts "x z" or "x y z"; all may be relative (~)
  if (rest.length !== 2 && rest.length !== 3) {
    return fail(`usage: ${what} <x> <z> | ${what} <x> <y> <z> (~ supported)`)
  }
  const rx = relative(rest[0])
  if (!rx.ok) return fail(coordError(rest[0]))
  let y = null
  let rz
  if (rest.length === 3) {
    const ry = relative(rest[1])
    if (!ry.ok) return fail(coordError(rest[1]))
    y = ry
    rz = relative(rest[2])
  } else {
    rz = relative(rest[1])
  }
  if (!rz.ok) return fail(coordError(rest[rest.length - 1]))
  for (const r of [rx, y, rz]) {
    if (r && Math.abs(r.value) > MAX_COORD) {
      return fail(`coordinates must stay within ${MAX_COORD}`)
    }
  }
  return { ok: true, x: rx, y, z: rz }
}

// parse a raw line into { ok, name, args } or { ok: false, error }.
// accepts an optional leading "/" (console) and is case-insensitive.
function parseCommand (raw) {
  let line = String(raw == null ? '' : raw).trim()
  if (line === '') return fail('empty command')
  if (line.startsWith('/')) line = line.slice(1)
  const parts = line.split(/\s+/)
  let name = parts[0].toLowerCase()

  // sethome / home are waypoints aliases with fixed arguments
  if (name === 'sethome') {
    if (parts.length !== 1) return fail('usage: sethome')
    return { ok: true, name: 'waypoints', args: { mode: 'save', tag: 'home', name: 'home' } }
  }
  if (name === 'home') {
    if (parts.length !== 1) return fail('usage: home')
    return { ok: true, name: 'waypoints', args: { mode: 'goal', ref: 'home' } }
  }
  // bare "reset" (and "reset key") is baritone's set reset alias
  if (name === 'reset') {
    if (parts.length > 2) return fail('usage: reset [key]')
    return { ok: true, name: 'set', args: { mode: 'reset', key: parts[1] || null } }
  }

  if (ALIASES[name]) name = ALIASES[name]
  const rest = parts.slice(1)

  switch (name) {
    case 'help': {
      if (rest.length > 1) return fail('usage: help [command]')
      if (rest.length === 1) {
        const c = rest[0].toLowerCase()
        if (ALIASES[c] || COMMANDS.some((x) => x.name === (ALIASES[c] || c))) {
          return { ok: true, name, args: { command: ALIASES[c] || c } }
        }
        return fail(`unknown command "${c}"`)
      }
      return { ok: true, name, args: {} }
    }
    case 'set': {
      // #set | #set key | #set key value | #set list | #set modified |
      // #set reset [key]  (aliases route "reset"/"modified" here too)
      if (rest.length === 0) return { ok: true, name, args: { mode: 'modified' } }
      const first = rest[0]
      const firstLower = first.toLowerCase()
      if (firstLower === 'list' || firstLower === 'all') {
        if (rest.length !== 1) return fail('usage: set list')
        return { ok: true, name, args: { mode: 'list' } }
      }
      if (firstLower === 'modified') {
        if (rest.length !== 1) return fail('usage: set modified')
        return { ok: true, name, args: { mode: 'modified' } }
      }
      if (firstLower === 'reset') {
        if (rest.length > 2) return fail('usage: set reset [key]')
        return { ok: true, name, args: { mode: 'reset', key: rest[1] || null } }
      }
      if (rest.length === 1) return { ok: true, name, args: { mode: 'show', key: first } }
      if (rest.length === 2) return { ok: true, name, args: { mode: 'set', key: first, value: rest[1] } }
      return fail('usage: set [key] [value]')
    }
    case 'goal': {
      if (rest.length === 0) return { ok: true, name, args: { mode: 'feet' } }
      if (rest[0].toLowerCase() === 'clear') {
        if (rest.length !== 1) return fail('usage: goal clear')
        return { ok: true, name, args: { mode: 'clear' } }
      }
      if (rest.length === 1) {
        const y = num(rest[0])
        if (y === null) return fail('usage: goal <x y z | x z | y | clear>')
        if (Math.abs(y) > MAX_COORD) return fail('y level out of range')
        return { ok: true, name, args: { mode: 'ylevel', y: Math.round(y) } }
      }
      const c = parseCoordTriple(rest, 'goal')
      if (!c.ok) return c
      return {
        ok: true,
        name,
        args: { mode: 'coords', x: c.x, y: c.y, z: c.z }
      }
    }
    case 'goto': {
      // goto <block> — a single block name is a GetToBlock goal
      if (rest.length === 1 && !/^~|[+-]?\d/.test(rest[0])) {
        const block = rest[0].toLowerCase()
        if (!BLOCK_NAME_RE.test(block)) return fail(`"${rest[0]}" is not a block name`)
        return { ok: true, name, args: { mode: 'block', block } }
      }
      const c = parseCoordTriple(rest, 'goto')
      if (!c.ok) return c
      return { ok: true, name, args: { mode: 'coords', x: c.x, y: c.y, z: c.z } }
    }
    case 'path':
    case 'proc':
    case 'eta':
    case 'version':
    case 'repack':
    case 'forcecancel':
    case 'gc':
    case 'invert':
    case 'render':
    case 'reloadall':
    case 'saveall':
    case 'surface':
    case 'pause':
    case 'resume':
    case 'paused':
    case 'cancel':
    case 'stop':
    case 'where':
    case 'eat':
    case 'inventory':
    case 'status':
    case 'spawn': {
      if (rest.length !== 0) return fail(`${name} takes no arguments`)
      return { ok: true, name, args: {} }
    }
    case 'come': {
      if (rest.length > 1) return fail('usage: come [player]')
      if (rest.length === 1 && !NAME_RE.test(rest[0])) {
        return fail(`"${rest[0]}" is not a player name`)
      }
      return { ok: true, name, args: { player: rest[0] || null } }
    }
    case 'axis': {
      let y = null // unset: the axisHeight setting decides at execution time
      if (rest.length === 1) {
        const v = int(rest[0])
        if (v === null || v < -64 || v > 384) return fail('y must be an integer -64..384')
        y = v
      } else if (rest.length > 1) {
        return fail('usage: axis [y]')
      }
      return { ok: true, name, args: { y } }
    }
    case 'thisway': {
      if (rest.length !== 1) return fail('usage: thisway <distance>')
      const d = int(rest[0])
      if (d === null || d < 1 || d > 100000) return fail('distance must be 1-100000')
      return { ok: true, name, args: { distance: d } }
    }
    case 'mine': {
      // both baritone forms: "mine 64 diamond_ore" and "mine diamond_ore 64"
      if (rest.length < 1) return fail('usage: mine <count> <blocks...> | mine <blocks...> [count]')
      let count = null
      let names = rest.map((r) => r.toLowerCase())
      const first = int(rest[0])
      const last = int(rest[rest.length - 1])
      if (first !== null && rest.length >= 2) {
        count = first
        names = names.slice(1)
      } else if (last !== null && rest.length >= 2) {
        count = last
        names = names.slice(0, -1)
      }
      if (count !== null && (count < 1 || count > 4096)) return fail('count must be 1-4096')
      for (const n of names) {
        if (!BLOCK_NAME_RE.test(n)) return fail(`"${n}" is not a block name`)
      }
      if (count === null) count = 1
      return { ok: true, name, args: { blocks: names, count } }
    }
    case 'find':
    case 'blacklist': {
      if (name === 'blacklist') {
        if (rest.length === 0) return { ok: true, name, args: { mode: 'closest' } }
        if (rest.length !== 3) return fail('usage: blacklist [x y z]')
        const x = int(rest[0])
        const y = int(rest[1])
        const z = int(rest[2])
        if (x === null || y === null || z === null) return fail('blacklist takes integer coordinates')
        return { ok: true, name, args: { mode: 'coords', x, y, z } }
      }
      if (rest.length !== 1) return fail('usage: find <block>')
      const block = rest[0].toLowerCase()
      if (!BLOCK_NAME_RE.test(block)) return fail(`"${rest[0]}" is not a block name`)
      return { ok: true, name, args: { block } }
    }
    case 'tunnel': {
      if (rest.length > 3) return fail('usage: tunnel [height width depth]')
      const dims = []
      for (const tok of rest) {
        const v = int(tok)
        if (v === null || v < 1 || v > 256) return fail('tunnel dimensions must be integers 1-256')
        dims.push(v)
      }
      return {
        ok: true,
        name,
        args: {
          height: dims.length > 0 ? dims[0] : 2,
          width: dims.length > 1 ? dims[1] : 1,
          depth: dims.length > 2 ? dims[2] : 32
        }
      }
    }
    case 'farm': {
      if (rest.length > 2) return fail('usage: farm [range] [waypoint]')
      let range = 48
      let waypoint = null
      if (rest.length >= 1) {
        const v = int(rest[0])
        if (v === null || v < 1 || v > 256) return fail('range must be an integer 1-256')
        range = v
      }
      if (rest.length === 2) {
        if (!WAYPOINT_NAME_RE.test(rest[1])) return fail(`"${rest[1]}" is not a waypoint name`)
        waypoint = rest[1]
      }
      return { ok: true, name, args: { range, waypoint } }
    }
    case 'explore': {
      if (rest.length > 2) return fail('usage: explore [x z | radius]')
      if (rest.length === 1) {
        const v = int(rest[0])
        if (v === null || v < 16 || v > 4096) return fail('radius must be an integer 16-4096')
        return { ok: true, name, args: { x: null, z: null, radius: v } }
      }
      if (rest.length === 2) {
        const x = int(rest[0])
        const z = int(rest[1])
        if (x === null || z === null) return fail('usage: explore [x z | radius]')
        if (Math.abs(x) > MAX_COORD || Math.abs(z) > MAX_COORD) return fail('coordinates out of range')
        return { ok: true, name, args: { x, z, radius: null } }
      }
      return { ok: true, name, args: { x: null, z: null, radius: null } }
    }
    case 'explorefilter': {
      if (rest.length < 1 || rest.length > 2) return fail('usage: explorefilter <file> [invert]')
      if (!FILE_NAME_RE.test(rest[0])) return fail(`"${rest[0]}" is not a file name`)
      const invert = rest.length === 2 && rest[1].toLowerCase() === 'invert'
      if (rest.length === 2 && !invert) return fail('second argument must be "invert"')
      return { ok: true, name, args: { file: rest[0], invert } }
    }
    case 'build': {
      if (rest.length < 1 || rest.length > 4) return fail('usage: build <schematic> [x y z]')
      const schematic = rest[0].toLowerCase()
      if (!FILE_NAME_RE.test(schematic)) return fail(`"${rest[0]}" is not a schematic name`)
      let origin = null
      if (rest.length > 1) {
        const c = parseCoordTriple(rest.slice(1), 'build')
        if (!c.ok) return c
        origin = c
      }
      return { ok: true, name, args: { schematic, origin } }
    }
    case 'litematica': {
      if (rest.length !== 1) return fail('usage: litematica <file>')
      if (!FILE_NAME_RE.test(rest[0])) return fail(`"${rest[0]}" is not a file name`)
      return { ok: true, name, args: { file: rest[0] } }
    }
    case 'follow': {
      if (rest.length === 0) return fail('usage: follow <player X | players | entity T... | entities | off>')
      const kind = rest[0].toLowerCase()
      if (kind === 'off' || kind === 'stop') return { ok: true, name, args: { kind: 'off' } }
      if (kind === 'players') {
        if (rest.length !== 1) return fail('usage: follow players')
        return { ok: true, name, args: { kind: 'players', names: [] } }
      }
      if (kind === 'entities') {
        if (rest.length !== 1) return fail('usage: follow entities')
        return { ok: true, name, args: { kind: 'entities', types: [] } }
      }
      if (kind === 'player') {
        if (rest.length < 2) return fail('usage: follow player <name...>')
        for (const n of rest.slice(1)) {
          if (!NAME_RE.test(n)) return fail(`"${n}" is not a player name`)
        }
        return { ok: true, name, args: { kind: 'player', names: rest.slice(1) } }
      }
      if (kind === 'entity' || kind === 'entities_type') {
        if (rest.length < 2) return fail('usage: follow entity <type...>')
        for (const t of rest.slice(1)) {
          if (!/^[a-z0-9_:]+$/.test(t)) return fail(`"${t}" is not an entity type`)
        }
        return { ok: true, name, args: { kind: 'entity', types: rest.slice(1) } }
      }
      // bare "follow X" treats X as a player name, like natural speech
      if (NAME_RE.test(rest[0]) && rest.length === 1) {
        return { ok: true, name, args: { kind: 'player', names: [rest[0]] } }
      }
      return fail('usage: follow <player X | players | entity T... | entities | off>')
    }
    case 'pickup': {
      let radius = 16
      if (rest.length === 1) {
        const v = int(rest[0])
        if (v === null || v < 1 || v > 64) return fail('radius must be an integer 1-64')
        radius = v
      } else if (rest.length > 1) {
        return fail('usage: pickup [radius]')
      }
      return { ok: true, name, args: { radius } }
    }
    case 'click': {
      if (rest.length !== 3) return fail('usage: click <x y z>')
      const x = int(rest[0])
      const y = int(rest[1])
      const z = int(rest[2])
      if (x === null || y === null || z === null) return fail('click takes integer coordinates')
      if (Math.abs(x) > MAX_COORD || Math.abs(z) > MAX_COORD || y < -64 || y > 384) return fail('coordinates out of range')
      return { ok: true, name, args: { x, y, z } }
    }
    case 'elytra': {
      if (rest.length !== 2 && rest.length !== 3) return fail('usage: elytra <x z> | elytra <x y z>')
      const c = parseCoordTriple(rest, 'elytra')
      if (!c.ok) return c
      return { ok: true, name, args: { x: c.x, y: c.y, z: c.z } }
    }
    case 'excavate': {
      if (rest.length === 1 && rest[0].toLowerCase() === 'sel') {
        return { ok: true, name, args: { mode: 'selection' } }
      }
      if (rest.length !== 6) return fail('usage: excavate <x1 y1 z1> <x2 y2 z2> | excavate sel')
      const coords = []
      for (const tok of rest) {
        const v = int(tok)
        if (v === null) return fail('excavate takes integer coordinates')
        coords.push(v)
      }
      return { ok: true, name, args: { mode: 'cuboid', from: coords.slice(0, 3), to: coords.slice(3, 6) } }
    }
    case 'attack': {
      if (rest.length === 0) return fail('usage: attack <entity|player> | attack off')
      if (rest[0].toLowerCase() === 'off' || rest[0].toLowerCase() === 'stop') {
        return { ok: true, name, args: { target: null } }
      }
      if (rest.length !== 1) return fail('usage: attack <entity|player> | attack off')
      return { ok: true, name, args: { target: rest[0].toLowerCase() } }
    }
    case 'feed': {
      if (rest.length === 0 || rest.length > 2) return fail('usage: feed <entity> [item]')
      if (!NAME_RE.test(rest[0])) return fail(`"${rest[0]}" is not an entity name`)
      const item = rest.length === 2 ? rest[1].toLowerCase() : null
      if (item && !NAME_RE.test(item)) return fail(`"${rest[1]}" is not an item name`)
      return { ok: true, name, args: { entity: rest[0].toLowerCase(), item } }
    }
    case 'breed': {
      if (rest.length !== 1) return fail('usage: breed <entity>')
      if (!NAME_RE.test(rest[0])) return fail(`"${rest[0]}" is not an entity name`)
      return { ok: true, name, args: { entity: rest[0].toLowerCase() } }
    }
    case 'activate': {
      if (rest.length !== 1) return fail('usage: activate <block>')
      if (!NAME_RE.test(rest[0])) return fail(`"${rest[0]}" is not a block name`)
      return { ok: true, name, args: { block: rest[0].toLowerCase() } }
    }
    case 'sleep':
    case 'wake': {
      if (rest.length !== 0) return fail(`${name} takes no arguments`)
      return { ok: true, name, args: {} }
    }
    case 'auto': {
      if (rest.length === 0) return { ok: true, name, args: { mode: 'toggle' } }
      if (rest.length !== 1 || !['on', 'off', 'status'].includes(rest[0].toLowerCase())) {
        return fail('usage: auto [on | off | status]')
      }
      return { ok: true, name, args: { mode: rest[0].toLowerCase() } }
    }
    case 'flee': {
      let radius = 32
      if (rest.length === 1) {
        const v = int(rest[0])
        if (v === null || v < 4 || v > 256) return fail('radius must be an integer 4-256')
        radius = v
      } else if (rest.length > 1) {
        return fail('usage: flee [radius]')
      }
      return { ok: true, name, args: { radius } }
    }
    case 'say': {
      const message = rest.join(' ')
      if (message === '') return fail('usage: say <message>')
      if (message.length > MAX_MESSAGE) return fail(`message longer than ${MAX_MESSAGE} characters`)
      return { ok: true, name, args: { message } }
    }
    case 'drop': {
      if (rest.length > 1) return fail('usage: drop [all | hand | <item>]')
      if (rest.length === 0) return { ok: true, name, args: { mode: 'stack' } }
      const m = rest[0].toLowerCase()
      if (m === 'all') return { ok: true, name, args: { mode: 'all' } }
      if (m === 'hand') return { ok: true, name, args: { mode: 'hand' } }
      if (!ITEM_NAME_RE.test(m)) return fail(`"${rest[0]}" is not an item name`)
      return { ok: true, name, args: { mode: 'item', item: m } }
    }
    case 'craft': {
      if (rest.length < 1 || rest.length > 2) return fail('usage: craft <item> [count]')
      const item = rest[0].toLowerCase()
      if (!ITEM_NAME_RE.test(item)) return fail(`"${rest[0]}" is not an item name`)
      let count = 1
      if (rest.length === 2) {
        const v = int(rest[1])
        if (v === null || v < 1 || v > 64) return fail('count must be 1-64')
        count = v
      }
      return { ok: true, name, args: { item, count } }
    }
    case 'chest': {
      if (rest.length < 1 || rest.length > 2) return fail('usage: chest <deposit|withdraw|list> [filter]')
      const mode = rest[0].toLowerCase()
      if (mode !== 'deposit' && mode !== 'withdraw' && mode !== 'list') {
        return fail('usage: chest <deposit|withdraw|list> [filter]')
      }
      let filter = null
      if (rest.length === 2) {
        if (!ITEM_NAME_RE.test(rest[1].toLowerCase())) return fail(`"${rest[1]}" is not an item name`)
        filter = rest[1].toLowerCase()
      }
      return { ok: true, name, args: { mode, filter } }
    }
    case 'waypoints': {
      if (rest.length === 0) return { ok: true, name, args: { mode: 'list', tag: null } }
      const mode = rest[0].toLowerCase()
      const tail = rest.slice(1)
      switch (mode) {
        case 'list':
        case 'get':
        case 'l': {
          if (tail.length > 1) return fail('usage: wp list [tag]')
          let tag = null
          if (tail.length === 1) {
            tag = tail[0].toLowerCase()
            if (!/^[a-z0-9_\-]{1,32}$/.test(tag)) return fail(`"${tail[0]}" is not a tag`)
          }
          return { ok: true, name, args: { mode: 'list', tag } }
        }
        case 'clear':
        case 'c':
          if (tail.length !== 0) return fail('usage: wp clear')
          return { ok: true, name, args: { mode: 'clear' } }
        case 'save':
        case 's': {
          // wp save [tag] [name] — baritone: save user <name>
          if (tail.length < 1 || tail.length > 2) return fail('usage: wp save [tag] [name]')
          let tag = 'user'
          let wpname
          if (tail.length === 1) {
            wpname = tail[0]
          } else {
            tag = tail[0].toLowerCase()
            wpname = tail[1]
          }
          if (!/^[a-z0-9_\-]{1,32}$/.test(tag)) return fail(`"${tag}" is not a tag`)
          if (!WAYPOINT_NAME_RE.test(wpname)) return fail(`"${wpname}" is not a waypoint name`)
          return { ok: true, name, args: { mode: 'save', tag, name: wpname } }
        }
        case 'goal':
        case 'g': {
          if (tail.length !== 1) return fail('usage: wp goal <name|tag>')
          return { ok: true, name, args: { mode: 'goal', ref: tail[0] } }
        }
        case 'info':
        case 'show':
        case 'i':
          if (tail.length !== 1) return fail('usage: wp info <name>')
          return { ok: true, name, args: { mode: 'info', ref: tail[0] } }
        case 'delete':
        case 'd':
          if (tail.length !== 1) return fail('usage: wp delete <name>')
          return { ok: true, name, args: { mode: 'delete', ref: tail[0] } }
        default:
          return fail(`unknown wp subcommand "${mode}"`)
      }
    }
    case 'sel': {
      return parseSel(rest)
    }
    case 'damn': {
      if (rest.length === 1 && rest[0].toLowerCase() === 'daniel') {
        return { ok: true, name, args: {} }
      }
      return fail('usage: damn daniel')
    }
    default: {
      const hint = suggest(name)
      return fail(hint ? `unknown command "${name}" — did you mean "${hint}"?` : `unknown command "${name}"`)
    }
  }
}

// sel grammar, mirroring baritone's SelCommand actions:
//   pos1/p1/1 [x y z]    set corner 1 (default: feet)
//   pos2/p2/2 [x y z]    set corner 2
//   clear/c              drop the selection
//   undo/u               undo the last sel action
//   set/fill/s <block>   fill the selection with a block
//   walls/w <block>      walls only
//   shell/shl <block>    walls + roof + floor
//   sphere/sph <block> [r]        filled sphere from the selection center
//   hsphere/hsph <block> [r]      hollow sphere
//   cylinder/cyl <block> [r] [h] filled cylinder
//   hcylinder/hcyl <block> [r] [h] hollow cylinder
//   cleararea/ca         clear the selection to air
//   replace/r <a> <b>    replace block a with b inside the selection
//   expand/ex <n> [dir]  grow the selection (all, or n/s/e/w/up/down)
//   contract/ct <n> [dir]
//   shift/sh <n> [dir]
//   copy/cp              copy the selection to the clipboard
//   paste/p [x y z]      build the clipboard at coords (default: feet)
function parseSel (rest) {
  if (rest.length === 0) return fail('usage: sel <pos1|pos2|clear|undo|fill|walls|shell|sphere|cylinder|cleararea|replace|expand|contract|shift|copy|paste> ...')
  const action = rest[0].toLowerCase()
  const tail = rest.slice(1)

  const needBlock = (label) => {
    if (tail.length < 1) return fail(`usage: sel ${label} <block>`)
    const block = tail[0].toLowerCase()
    if (!BLOCK_NAME_RE.test(block)) return fail(`"${tail[0]}" is not a block name`)
    return { ok: true, block }
  }
  const coords = (label) => {
    if (tail.length !== 3) return fail(`usage: sel ${label} <x y z>`)
    const out = []
    for (const tok of tail) {
      const v = int(tok)
      if (v === null) return fail(`sel ${label} takes integer coordinates`)
      out.push(v)
    }
    return { ok: true, coords: out }
  }

  switch (action) {
    case 'pos1':
    case 'p1':
    case '1': {
      if (tail.length === 0) return { ok: true, name: 'sel', args: { action: 'pos1', coords: null } }
      const c = coords('pos1')
      if (!c.ok) return c
      return { ok: true, name: 'sel', args: { action: 'pos1', coords: c.coords } }
    }
    case 'pos2':
    case 'p2':
    case '2': {
      if (tail.length === 0) return { ok: true, name: 'sel', args: { action: 'pos2', coords: null } }
      const c = coords('pos2')
      if (!c.ok) return c
      return { ok: true, name: 'sel', args: { action: 'pos2', coords: c.coords } }
    }
    case 'clear':
    case 'c':
      if (tail.length !== 0) return fail('usage: sel clear')
      return { ok: true, name: 'sel', args: { action: 'clear' } }
    case 'undo':
    case 'u':
      if (tail.length !== 0) return fail('usage: sel undo')
      return { ok: true, name: 'sel', args: { action: 'undo' } }
    case 'set':
    case 'fill':
    case 's':
    case 'f': {
      const b = needBlock('fill')
      if (!b.ok) return b
      return { ok: true, name: 'sel', args: { action: 'fill', block: b.block } }
    }
    case 'walls':
    case 'w': {
      const b = needBlock('walls')
      if (!b.ok) return b
      return { ok: true, name: 'sel', args: { action: 'walls', block: b.block } }
    }
    case 'shell':
    case 'shl': {
      const b = needBlock('shell')
      if (!b.ok) return b
      return { ok: true, name: 'sel', args: { action: 'shell', block: b.block } }
    }
    case 'sphere':
    case 'sph':
    case 'hsphere':
    case 'hsph':
    case 'cylinder':
    case 'cyl':
    case 'hcylinder':
    case 'hcyl': {
      const b = needBlock(action)
      if (!b.ok) return b
      const restTail = tail.slice(1)
      const dims = []
      for (const tok of restTail) {
        const v = int(tok)
        if (v === null || v < 1 || v > 64) return fail(`${action} dimensions must be integers 1-64`)
        dims.push(v)
      }
      if (dims.length > 2) return fail(`usage: sel ${action} <block> [radius] [height]`)
      const hollow = action.startsWith('h')
      const kind = action.includes('sphere') ? 'sphere' : 'cylinder'
      return {
        ok: true,
        name: 'sel',
        args: {
          action: kind,
          hollow,
          block: b.block,
          radius: dims.length > 0 ? dims[0] : null,
          height: dims.length > 1 ? dims[1] : null
        }
      }
    }
    case 'cleararea':
    case 'ca':
      if (tail.length !== 0) return fail('usage: sel cleararea')
      return { ok: true, name: 'sel', args: { action: 'cleararea' } }
    case 'replace':
    case 'r': {
      if (tail.length !== 2) return fail('usage: sel replace <from> <to>')
      for (const t of tail) {
        if (!BLOCK_NAME_RE.test(t.toLowerCase())) return fail(`"${t}" is not a block name`)
      }
      return { ok: true, name: 'sel', args: { action: 'replace', from: tail[0].toLowerCase(), to: tail[1].toLowerCase() } }
    }
    case 'expand':
    case 'ex':
    case 'contract':
    case 'ct':
    case 'shift':
    case 'sh': {
      if (tail.length < 1 || tail.length > 2) return fail(`usage: sel ${action} <n> [north|south|east|west|up|down|all]`)
      const n = int(tail[0])
      if (n === null || n < 1 || n > 256) return fail('amount must be an integer 1-256')
      let dir = 'all'
      if (tail.length === 2) {
        dir = tail[1].toLowerCase()
        const ok = ['north', 'south', 'east', 'west', 'up', 'down', 'all'].includes(dir)
        if (!ok) return fail(`"${tail[1]}" is not a direction`)
      }
      const verb = ['expand', 'ex'].includes(action) ? 'expand' : (['contract', 'ct'].includes(action) ? 'contract' : 'shift')
      return { ok: true, name: 'sel', args: { action: verb, n, dir } }
    }
    case 'copy':
    case 'cp':
      if (tail.length !== 0) return fail('usage: sel copy')
      return { ok: true, name: 'sel', args: { action: 'copy' } }
    case 'paste':
    case 'p': {
      if (tail.length === 0) return { ok: true, name: 'sel', args: { action: 'paste', coords: null } }
      const c = coords('paste')
      if (!c.ok) return c
      return { ok: true, name: 'sel', args: { action: 'paste', coords: c.coords } }
    }
    default:
      return fail(`unknown sel action "${action}"`)
  }
}

function helpLines (onlyBaritone) {
  return COMMANDS
    .filter((c) => !onlyBaritone || c.baritone)
    .map((c) => (c.args ? `${c.name} ${c.args} — ${c.help}` : `${c.name} — ${c.help}`))
}

module.exports = {
  parseCommand,
  parseSel,
  COMMANDS,
  ALIASES,
  helpLines,
  suggest,
  MAX_COORD,
  NAME_RE,
  MAX_MESSAGE
}
