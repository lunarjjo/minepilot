'use strict'

// the settings registry — minepilot's port of baritone's Settings system.
// every knob the engine, the processes and the console share lives here,
// defined once with a type, a default, a description and a category.
//
//   get(key)                 -> current value
//   set(key, raw)            -> { ok, value } | { ok: false, error }
//   reset(key | null)         -> back to defaults (null = all)
//   list()                   -> [{ key, type, value, default, modified, ... }]
//
// types:
//   bool   true / false
//   int    integer, ranged
//   float  number, ranged
//   string plain string
//   blocks comma separated block names (stored as string[])
//   items  comma separated item names (stored as string[])
//   map    comma separated a=b pairs (stored as { a: [b, ...] })
//
// names follow baritone's Settings.java wherever the semantics match, so
// muscle memory carries over; minepilot-only knobs live in the minepilot
// category and say so in their description.

const CATEGORIES = {
  movement: 'how the pathfinder may move',
  costs: 'cost model weights',
  mining: 'what the mine process will touch',
  building: 'how the builder interprets schematics',
  inventory: 'inventory and tool behavior',
  pathing: 'search budgets and resilience',
  rendering: 'what the web map draws',
  chat: 'in-game chat control',
  elytra: 'elytra flight',
  minepilot: 'minepilot-only extras'
}

class Settings {
  constructor () {
    this.defs = new Map() // key -> { type, default, description, category, min, max }
    this.values = new Map()
    this.modified = new Set()
  }

  define (key, type, value, description, category, opts) {
    const def = { type, default: value, description, category: category || 'minepilot', min: null, max: null }
    if (opts) {
      if (Number.isFinite(opts.min)) def.min = opts.min
      if (Number.isFinite(opts.max)) def.max = opts.max
    }
    this.defs.set(key, def)
    this.values.set(key, value)
    return this
  }

  has (key) {
    return this.defs.has(key)
  }

  typeOf (key) {
    const d = this.defs.get(key)
    return d ? d.type : null
  }

  get (key) {
    if (!this.defs.has(key)) throw new Error(`unknown setting "${key}"`)
    return this.values.get(key)
  }

  // raw values from chat / the console arrive as strings; typed values
  // (REST json) arrive as themselves. both go through the same coercion.
  set (key, raw) {
    const d = this.defs.get(key)
    if (!d) {
      const hint = this.suggest(key)
      return { ok: false, error: hint ? `unknown setting "${key}" — did you mean "${hint}"?` : `unknown setting "${key}"` }
    }
    const parsed = this.coerce(d, raw)
    if (!parsed.ok) return parsed
    const value = parsed.value
    if (d.type === 'blocks' || d.type === 'items') {
      const bad = value.filter((n) => !/^[a-z0-9_]+$/.test(n))
      if (bad.length > 0) return { ok: false, error: `not a block/item name: ${bad.join(', ')}` }
    }
    const prev = this.values.get(key)
    if (JSON.stringify(prev) !== JSON.stringify(value)) {
      this.values.set(key, value)
      this.modified.add(key)
    }
    return { ok: true, value, was: prev }
  }

  coerce (d, raw) {
    switch (d.type) {
      case 'bool': {
        if (typeof raw === 'boolean') return { ok: true, value: raw }
        const s = String(raw).trim().toLowerCase()
        if (s === 'true' || s === 'on' || s === 'yes' || s === '1') return { ok: true, value: true }
        if (s === 'false' || s === 'off' || s === 'no' || s === '0') return { ok: true, value: false }
        return { ok: false, error: 'takes true or false' }
      }
      case 'int':
      case 'float': {
        const n = Number(raw)
        if (!Number.isFinite(n)) return { ok: false, error: 'takes a number' }
        const v = d.type === 'int' ? Math.round(n) : n
        if (d.min !== null && v < d.min) return { ok: false, error: `must be >= ${d.min}` }
        if (d.max !== null && v > d.max) return { ok: false, error: `must be <= ${d.max}` }
        return { ok: true, value: v }
      }
      case 'string': {
        const s = String(raw).trim()
        if (s === '') return { ok: false, error: 'takes a non-empty string' }
        return { ok: true, value: s.slice(0, 64) }
      }
      case 'blocks':
      case 'items': {
        const dedupe = (arr) => [...new Set(arr)]
        if (Array.isArray(raw)) {
          const arr = raw.map((x) => String(x).trim().toLowerCase()).filter(Boolean)
          return { ok: true, value: dedupe(arr) }
        }
        const s = String(raw).trim().toLowerCase()
        if (s === '' || s === 'none' || s === 'empty') return { ok: true, value: [] }
        return { ok: true, value: dedupe(s.split(',').map((x) => x.trim()).filter(Boolean)) }
      }
      case 'map': {
        // "a=b,c=d" or { a: 'b' } -> { a: [b, c] }
        const out = {}
        const put = (k, v) => {
          k = String(k).trim().toLowerCase()
          v = String(v).trim().toLowerCase()
          if (!k || !v) return
          if (!out[k]) out[k] = []
          if (!out[k].includes(v)) out[k].push(v)
        }
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          for (const [k, v] of Object.entries(raw)) {
            const list = Array.isArray(v) ? v : [v]
            for (const item of list) put(k, item)
          }
          return { ok: true, value: out }
        }
        const s = String(raw).trim()
        if (s === '' || s === 'none' || s === 'empty') return { ok: true, value: out }
        for (const pair of s.split(',')) {
          const eq = pair.indexOf('=')
          if (eq === -1) return { ok: false, error: `"${pair.trim()}" is not a=b` }
          put(pair.slice(0, eq), pair.slice(eq + 1))
        }
        return { ok: true, value: out }
      }
      default:
        return { ok: false, error: `unsupported type ${d.type}` }
    }
  }

  reset (key) {
    if (key === null || key === undefined) {
      for (const [k, d] of this.defs) this.values.set(k, d.default)
      this.modified.clear()
      return { ok: true, reset: 'all' }
    }
    const d = this.defs.get(key)
    if (!d) return { ok: false, error: `unknown setting "${key}"` }
    this.values.set(key, d.default)
    this.modified.delete(key)
    return { ok: true, reset: key, value: d.default }
  }

  suggest (name) {
    const keys = [...this.defs.keys()]
    const n = String(name).toLowerCase()
    for (const k of keys) {
      if (k.startsWith(n.slice(0, 4))) return k
    }
    return null
  }

  list (filter) {
    const out = []
    for (const [key, d] of this.defs) {
      if (filter && d.category !== filter) continue
      out.push({
        key,
        type: d.type,
        value: this.values.get(key),
        default: d.default,
        modified: this.modified.has(key),
        description: d.description,
        category: d.category
      })
    }
    return out
  }

  categories () {
    return Object.entries(CATEGORIES).map(([name, blurb]) => ({ name, blurb, count: this.list(name).length }))
  }

  modifiedList () {
    return this.list().filter((s) => s.modified)
  }

  snapshot () {
    const out = {}
    for (const key of this.modified) out[key] = this.values.get(key)
    return out
  }

  applySnapshot (obj) {
    if (!obj || typeof obj !== 'object') return { applied: 0, failed: [] }
    let applied = 0
    const failed = []
    for (const [k, v] of Object.entries(obj)) {
      const r = this.set(k, v)
      if (r.ok) applied++
      else failed.push(k)
    }
    return { applied, failed }
  }
}

// the registry itself. baritone parity notes:
//   - baritone has 250+ settings; minepilot ports every one whose
//     semantics exist in a headless mineflayer context (a client mod has
//     rendering threads, window focus, entity rendering, culling, etc. —
//     none of which exist here), plus minepilot-specific knobs. the full
//     mapping table lives in docs/baritone-parity.md.
function createDefaultSettings () {
  const s = new Settings()

  // ---- movement -------------------------------------------------------
  s.define('allowBreak', 'bool', true, 'the pathfinder may dig through breakable blocks when it is the cheapest route', 'movement')
  s.define('allowPlace', 'bool', true, 'the pathfinder may pillar up and bridge gaps using inventory blocks', 'movement')
  s.define('allowSprint', 'bool', true, 'sprinting is allowed while walking paths', 'movement')
  s.define('allowParkour', 'bool', false, 'sprint-jump one block gaps (skilled movement, same default as baritone)', 'movement')
  s.define('allowParkourAscend', 'bool', false, 'parkour jumps that gain a block of height', 'movement')
  s.define('allowDiagonalAscend', 'bool', false, '45 degree ascents', 'movement')
  s.define('allowDiagonalDescend', 'bool', true, '45 degree descents', 'movement')
  s.define('allowDownward', 'bool', true, 'descending and falling are legal moves', 'movement')
  s.define('allowSwimming', 'bool', true, 'swimming across water is legal (baritone defaults false because of lag; a bot does not care)', 'movement')
  s.define('sprintInWater', 'bool', true, 'sprint while swimming', 'movement')
  s.define('allowVines', 'bool', true, 'climb vines and ladders', 'movement')
  s.define('allowFallDamage', 'bool', false, 'paths may include falls that hurt', 'movement')
  s.define('maxFallHeightNoWater', 'int', 3, 'longest fall taken with no water below', 'movement', { min: 1, max: 64 })
  s.define('maxFallHeightBucket', 'int', 20, 'longest fall taken into deep water', 'movement', { min: 1, max: 64 })
  s.define('allowWaterBucketFall', 'bool', true, 'place water below before long falls when a bucket is carried (landing cushion)', 'movement')
  s.define('allowJumpAtBuildLimit', 'bool', false, 'jump while at the build height limit', 'movement')
  s.define('assumeWalkOnWater', 'bool', false, 'plan as if the bot could walk on the water surface (baritone frost walker semantics; mineflayer cannot, so default off)', 'movement')
  s.define('assumeSafeWalk', 'bool', false, 'assume sneaking at edges prevents falling (mineflayer cannot, default off)', 'movement')

  // ---- costs -----------------------------------------------------------
  s.define('blockBreakAdditionalPenalty', 'float', 2, 'flat penalty added to every dig, so the planner prefers detours over straight lines through walls', 'costs', { min: 0, max: 100 })
  s.define('blockPlacementPenalty', 'float', 4, 'flat penalty added to every placement (baritone default 20; minepilot bridges slower so it is tuned down here)', 'costs', { min: 0, max: 100 })
  s.define('jumpPenalty', 'float', 0, 'extra penalty added to every jumping move on top of ascendCost (baritone default 2, which is baked into minepilot\'s ascendCost)', 'costs', { min: 0, max: 100 })
  s.define('walkOnWaterOnePenalty', 'float', 3, 'penalty for each block walked on the water surface', 'costs', { min: 0, max: 100 })
  s.define('walkCost', 'float', 1, 'cost of walking one block', 'costs', { min: 0.1, max: 10 })
  s.define('swimCost', 'float', 2.2, 'cost of swimming one block', 'costs', { min: 0.1, max: 10 })
  s.define('climbCost', 'float', 1.2, 'cost of climbing one block on a ladder or vine', 'costs', { min: 0.1, max: 10 })
  s.define('ascendCost', 'float', 2, 'cost of stepping up one block', 'costs', { min: 0.1, max: 10 })
  s.define('parkourCost', 'float', 2.5, 'cost of a parkour jump', 'costs', { min: 0.1, max: 10 })
  s.define('fallCostPerBlock', 'float', 0.1, 'cost added per block of fall distance', 'costs', { min: 0, max: 10 })
  s.define('fallDamageCost', 'float', 0.5, 'cost per half heart of expected fall damage', 'costs', { min: 0, max: 10 })
  s.define('walkBlocksPerSecond', 'float', 4.3, 'walking speed used to convert dig seconds into cost units', 'costs', { min: 1, max: 10 })

  // ---- mining ----------------------------------------------------------
  s.define('blocksToAvoid', 'blocks', [], 'blocks the pathfinder refuses to walk on (magma, honey...) even when they support the feet', 'mining')
  s.define('blocksToDisallowBreaking', 'blocks', ['chest', 'crafting_table', 'furnace', 'blast_furnace', 'smoker', 'barrel', 'dispenser', 'dropper', 'hopper', 'lectern', 'jukebox', 'note_block', 'beacon', 'bed', 'brewing_stand', 'enchanting_table', 'spawner', 'anvil'], 'blocks never broken by anything (containers and utility blocks)', 'mining')
  s.define('blocksToAvoidBreaking', 'blocks', ['chest', 'crafting_table', 'furnace', 'blast_furnace', 'smoker', 'barrel', 'dispenser', 'dropper', 'hopper', 'lectern', 'jukebox', 'note_block', 'beacon', 'bed', 'brewing_stand', 'enchanting_table', 'spawner', 'anvil', 'grass_block', 'farmland', 'dirt_path', 'oak_log', 'oak_leaves', 'iron_ore', 'gold_ore', 'diamond_ore', 'emerald_ore', 'redstone_ore', 'lapis_ore', 'coal_ore', 'copper_ore', 'ancient_debris'], 'blocks the pathfinder strongly prefers not to break (avoidBreakingMultiplier penalty) — containers and good ores', 'mining')
  s.define('avoidBreakingMultiplier', 'float', 0.1, 'fraction of a to-break block hardness cost used as the avoid penalty (baritone 0.1)', 'mining', { min: 0, max: 10 })
  s.define('allowBreakAnyway', 'blocks', [], 'blocks allowed to break even when they are in blocksToDisallowBreaking', 'mining')
  s.define('mineScanRadius', 'int', 64, 'how far the mine process searches loaded chunks for targets', 'mining', { min: 16, max: 128 })
  s.define('veinRadius', 'int', 1, 'after breaking one ore, also break directly adjacent ores of the same type', 'mining', { min: 0, max: 4 })
  s.define('blacklistClosestOnFailure', 'bool', true, 'a vein that cannot be reached gets blacklisted instead of retried forever', 'mining')
  s.define('throwawayItems', 'items', ['cobblestone', 'dirt', 'netherrack', 'andesite', 'diorite', 'granite', 'gravel', 'sand', 'dirt_path', 'stone', 'tuff', 'cobbled_deepslate', 'deepslate'], 'acceptable items to toss when the inventory is full and something valuable was just mined', 'mining')

  // ---- building --------------------------------------------------------
  s.define('buildIgnoreExisting', 'bool', false, 'skip verifying cells that already hold the right block state family', 'building')
  s.define('buildIgnoreDirection', 'bool', false, 'ignore the facing property when comparing placed blocks', 'building')
  s.define('buildIgnoreBlocks', 'blocks', [], 'blueprint cells whose world block is in this list count as done', 'building')
  s.define('buildSkipBlocks', 'blocks', [], 'blueprint cells whose intended block is in this list are never placed (holes in the build)', 'building')
  s.define('buildSubstitutes', 'map', { dirt: ['coarse_dirt', 'grass_block'], cobblestone: ['cobbled_deepslate', 'stone'], oak_planks: ['spruce_planks', 'birch_planks'] }, 'block=alt1,alt2 — accepted stand-ins when the exact block runs out', 'building')
  s.define('avoidUpdatingFallingBlocks', 'bool', true, 'do not place sand or gravel in positions where it would fall', 'building')

  // ---- inventory -------------------------------------------------------
  s.define('allowInventory', 'bool', true, 'the bot may swap hotbar slots while pathing (mineflayer has no screen lock, so unlike baritone this defaults true)', 'inventory')
  s.define('autoTool', 'bool', true, 'equip the best tool for each dig', 'inventory')
  s.define('toolSwapDelayMs', 'int', 150, 'pause between inventory swaps, anti-cheat friendliness', 'inventory', { min: 0, max: 1000 })
  s.define('acceptableThrowawayItems', 'items', ['dirt', 'cobblestone', 'netherrack', 'stone', 'andesite', 'diorite', 'granite', 'gravel', 'sand', 'tuff', 'cobbled_deepslate', 'deepslate'], 'items acceptable to use as filler blocks when bridging', 'inventory')
  s.define('autoEat', 'bool', true, 'eat when hunger drops', 'inventory')
  s.define('autoEatThreshold', 'int', 14, 'food level that triggers auto-eat', 'inventory', { min: 1, max: 20 })
  s.define('dropExcessWhenFull', 'bool', true, 'toss a throwaway stack when the inventory is full and a pickup is pending', 'inventory')

  // ---- pathing ---------------------------------------------------------
  s.define('maxNodes', 'int', 150000, 'A* node budget per search', 'pathing', { min: 1000, max: 1000000 })
  s.define('timeoutMs', 'int', 3500, 'wall clock budget per search', 'pathing', { min: 200, max: 60000 })
  s.define('avoidance', 'bool', true, 'avoid hostile mobs while pathing', 'pathing')
  s.define('mobAvoidanceRadius', 'int', 8, 'distance from a hostile mob that paths steer away from', 'pathing', { min: 0, max: 32 })
  s.define('mobAvoidanceCoefficient', 'float', 1.5, 'strength of the mob avoidance penalty', 'pathing', { min: 0, max: 10 })
  s.define('lavaAvoidanceRadius', 'int', 2, 'horizontal distance kept from lava while pathing', 'pathing', { min: 0, max: 8 })
  s.define('enterPortal', 'bool', true, 'walking into a nether portal is a legal move', 'pathing')
  s.define('followRadius', 'int', 3, 'stand this close while following someone', 'pathing', { min: 1, max: 16 })
  s.define('exploreKeepLoadedUnloaded', 'bool', false, 'explore prefers targets at the edge of the loaded world (frontier bias)', 'pathing')

  // ---- rendering (the web map) -----------------------------------------
  s.define('renderPath', 'bool', true, 'draw the active path on the map', 'rendering')
  s.define('renderGoal', 'bool', true, 'mark the goal on the map', 'rendering')
  s.define('renderSelectionBoxes', 'bool', true, 'draw the active selection on the map', 'rendering')
  s.define('renderWaypoints', 'bool', true, 'draw named waypoints on the map', 'rendering')
  s.define('mapShading', 'bool', true, 'shade terrain by relative height for depth perception', 'rendering')
  s.define('mapEntities', 'bool', true, 'draw entities on the map', 'rendering')

  // ---- chat control ----------------------------------------------------
  s.define('chatControl', 'bool', true, 'listen for commands in in-game chat', 'chat')
  s.define('prefixControl', 'bool', true, 'commands in chat must start with the prefix', 'chat')
  s.define('prefix', 'string', '#', 'the command prefix', 'chat')
  s.define('useMessageTag', 'bool', true, 'prefix bot replies with the minepilot tag so they are recognizable in the feed', 'chat')

  // ---- elytra ----------------------------------------------------------
  s.define('elytraAllowTakeoff', 'bool', true, 'the elytra process may start flying from the ground', 'elytra')
  s.define('elytraMinGlideHeight', 'int', 24, 'minimum altitude above terrain before leveling out', 'elytra', { min: 4, max: 120 })
  s.define('elytraFireworkBoost', 'bool', true, 'use firework rockets when losing too much altitude', 'elytra')
  s.define('elytraTargetRadius', 'int', 8, 'how close to the destination before starting to descend', 'elytra', { min: 2, max: 64 })

  // ---- minepilot extras ------------------------------------------------
  s.define('reconnect', 'bool', true, 'reconnect with backoff after a disconnect', 'minepilot')
  s.define('reconnectMaxDelayMs', 'int', 30000, 'cap for the reconnect backoff', 'minepilot', { min: 1000, max: 300000 })
  s.define('stuckTimeoutMs', 'int', 2500, 'standing still this long counts as stuck', 'minepilot', { min: 500, max: 30000 })
  s.define('autoRespawn', 'bool', true, 'respawn automatically after death', 'minepilot')
  s.define('deathWaypoints', 'bool', true, 'save a waypoint where the bot died', 'minepilot')
  s.define('bedWaypoints', 'bool', true, 'save a waypoint when sleeping in a bed', 'minepilot')
  s.define('logVerbosity', 'string', 'info', 'console log level: debug | info | warn | error', 'minepilot')
  s.define('mapChunkRadius', 'int', 16, 'chunk radius streamed to the web map around the bot', 'minepilot', { min: 2, max: 32 })

  return s
}

module.exports = { Settings, createDefaultSettings, CATEGORIES }
