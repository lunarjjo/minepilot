'use strict'

// the autopilot — minepilot's equivalent of baritone's IBaritone + the
// pathing process. it ties the goal system, the search and the executor
// together, runs one foreground PROCESS at a time (mine, build, farm,
// explore, follow, combat, ...) with baritone's pause/resume semantics,
// keeps a persistent goal (#goal sets it, #path walks it, #stop clears
// it), and reports ETA the way #eta does.
//
//   goto / path / goal        plan & walk toward a goal
//   come / follow             one-shot and continuous player tracking
//   mine / excavate / fill / tunnel / build / farm / explore / combat
//   thisway / axis / surface / invert / run away     goal constructors
//   pause / resume / stop     process lifecycle
//   eta                       remaining distance + seconds
//
// when the executor reports a splice (the world changed under the plan),
// the autopilot replans from the bot's actual position toward the same
// goal. unreachable goals degrade to the best partial path — walk as
// close as the loaded world allows — exactly baritone's contract.

const { EventEmitter } = require('events')
const { WorldView, rulesFromSettings } = require('./engine/world')
const { generate, DEFAULTS: MOVE_DEFAULTS } = require('./engine/moves')
const { search, DEFAULTS: SEARCH_DEFAULTS } = require('./engine/astar')
const { Executor } = require('./engine/executor')
const {
  GoalBlock, GoalNear, GoalXZ, GoalYLevel, GoalFollow, GoalInverted,
  GoalAxis, GoalStrictDirection, GoalRunAway, octile
} = require('./engine/goals')
const { runBuilder } = require('./processes/builder')
const { runFarm } = require('./processes/farm')
const { runExplore } = require('./processes/explore')
const { runMine } = require('./processes/mine')
const { recordDig, backfillAfterTask } = require('./processes/backfill')

const FOLLOW_REFRESH_MS = 1500
const REPLAN_DEBOUNCE_MS = 400
const MAX_CONSECUTIVE_FAILS = 3
const MAX_PATH_POINTS = 512
const HOSTILE_RE = /zombie|skeleton|creeper|spider|cave_spider|enderman|witch|blaze|ghast|slime|magma_cube|pillager|vindicator|evoker|ravager|phantom|drowned|husk|stray|wither_skeleton|piglin|hoglin|zoglin|warden|breeze|bogged/

const CHUNK_LOAD_GRACE_TRIES = 4
const CHUNK_LOAD_WAIT_MS = 1200

// engine settings that mirror registry keys one-to-one; anything absent
// falls back to the engine default. this mapping is the entire glue
// between "baritone setting names" and "the pathfinder's knobs".
const ENGINE_KEYS = [
  'allowBreak', 'allowPlace', 'allowParkour', 'allowParkourAscend',
  'allowWater', 'allowFallDamage', 'allowSprint',
  'allowDiagonalAscend', 'allowDiagonalDescend',
  'maxFallNoDamage', 'maxFallWithDamage', 'maxWaterLanding',
  'walkCost', 'swimCost', 'climbCost', 'ascendCost', 'parkourCost',
  'fallCostPerBlock', 'fallDamageCost', 'walkBlocksPerSecond',
  'blockBreakAdditionalPenalty', 'blockPlacementPenalty', 'jumpPenalty',
  'maxNodes', 'timeoutMs'
]

class Autopilot extends EventEmitter {
  // bot: a mineflayer bot (or a compatible fake)
  // deps: { Vec3 }
  // settings: the settings registry (src/settings.js)
  constructor ({ bot, deps, settings }) {
    super()
    this.bot = bot
    this.deps = deps
    this.settings = settings || null
    this.s = Object.assign({}, MOVE_DEFAULTS, SEARCH_DEFAULTS)
    this.view = WorldView.fromBot(bot, deps, this.buildRules())
    this.goal = null // the persistent goal (survives arrival, cleared by stop)
    this.task = 'idle' // what the user asked for most recently
    this.goalLabel = ''
    this.partial = false
    this.paused = false
    this.pausedBy = null
    this.lastReplanAt = 0
    this.replanPending = false
    this.consecutiveFails = 0
    this.pathPointsCache = []
    this.followTimer = null
    this.jobSeq = 0
    this.activeJob = 0
    this.activeProcessName = null
    this.executor = new Executor({ bot, view: this.view, settings: this.s, Vec3: deps.Vec3 })
    // every hole the executor digs is remembered for the backfill process
    this.executor.onDig = (x, y, z) => recordDig(this, x, y, z)
    this.wire()
    this.syncFromSettings()
  }

  // ---- settings glue ---------------------------------------------------

  buildRules () {
    return this.settings ? rulesFromSettings(this.settings) : rulesFromSettings(null)
  }

  syncFromSettings () {
    if (this.settings) {
      for (const key of ENGINE_KEYS) {
        if (this.settings.has(key)) this.s[key] = this.settings.get(key)
      }
    }
    // rebuild the rule set the world view enforces (block lists may have
    // changed since construction)
    this.view.rules = this.buildRules()
    this.emit('settings')
  }

  // ---- executor wiring ---------------------------------------------------

  wire () {
    this.executor.on('progress', (p) => this.emit('progress', p))
    this.executor.on('log', (text) => this.emit('log', text))
    this.executor.on('arrived', () => this.onArrived())
    this.executor.on('failed', (info) => {
      this.emit('log', `path failed: ${(info && info.reason) || 'unknown'}`)
      this.emit('failed', info || null)
      if (this.activeJob !== 0 || this.task === 'follow' || this.task === 'idle') return
      this.task = 'idle'
      this.emit('task')
    })
    this.executor.on('splice', () => this.scheduleReplan())
    this.executor.on('noMaterial', () => this.onNoMaterial())
    this.executor.on('stuck', (info) => this.emit('stuck', info))
  }

  onNoMaterial () {
    if (this.activeJob !== 0) return
    if (this.task === 'idle' || this.task === 'follow') return
    if (!this.s.allowPlace) return // already degraded for this task
    this.s.allowPlace = false
    this.placeDegraded = true
    this.emit('log', 'out of placeable blocks — planning without placing')
    this.replan()
  }

  // ---- position ---------------------------------------------------------

  pos () {
    const e = this.bot.entity
    return e && e.position ? e.position : null
  }

  node () {
    const p = this.pos()
    if (!p) return null
    return { x: Math.floor(p.x), y: Math.floor(p.y + 0.06), z: Math.floor(p.z) }
  }

  // ---- planning ---------------------------------------------------------

  // hostile positions for the avoidance penalty (the avoidance setting)
  hostilePositions () {
    if (!this.settings.get('avoidance')) return null
    const radius = this.settings.get('mobAvoidanceRadius')
    const p = this.pos()
    if (!p) return null
    const out = []
    try {
      for (const e of Object.values(this.bot.entities || {})) {
        if (!e || !e.position || e === this.bot.entity) continue
        const n = String(e.name || e.type || '')
        if (!HOSTILE_RE.test(n)) continue
        if (e.position.distanceTo(p) > radius + 16) continue
        out.push(e.position)
      }
    } catch (e) { return null }
    return out.length > 0 ? { radius, coeff: this.settings.get('mobAvoidanceCoefficient'), list: out } : null
  }

  planNow (goal) {
    const start = this.node()
    if (!start) return { status: 'nopos' }
    if (goal.isMet(start.x, start.y, start.z)) {
      return { status: 'found', moves: [], nodes: [start], cost: 0 }
    }
    // avoidance: nodes near hostiles cost extra, steering plans around
    // danger the way baritone's avoidance setting does
    const hostiles = this.hostilePositions()
    const neighbors = (n) => {
      const moves = generate(this.view, n, this.s)
      if (!hostiles) return moves
      for (const m of moves) {
        for (const h of hostiles.list) {
          const d = Math.hypot(m.to.x + 0.5 - h.x, m.to.y + 0.5 - h.y, m.to.z + 0.5 - h.z)
          if (d < hostiles.radius) {
            m.cost += hostiles.coeff * (1 - d / hostiles.radius) * 4
            break
          }
        }
      }
      return moves
    }
    return search(start, goal, neighbors, {
      maxNodes: this.s.maxNodes,
      timeoutMs: this.s.timeoutMs
    })
  }

  async launch (goal, taskLabel) {
    if (this.paused) this.resumeInternal()
    this.goal = goal
    this.task = taskLabel || 'goto'
    this.goalLabel = goal.label()
    this.partial = false
    this.consecutiveFails = 0
    this.partialPrevEnd = null
    this.escapeOf = null
    if (this.placeDegraded) {
      this.placeDegraded = false
      this.s.allowPlace = this.settings ? this.settings.get('allowPlace') : true
    }
    // the world around a fresh spawn loads in over a couple of seconds; a
    // plan against an all-fog world fails honestly but pointlessly, so
    // give the chunks a moment to arrive before declaring no path.
    let r = this.planNow(goal)
    for (let tries = 0; r.status !== 'found' && r.status !== 'partial' && tries < CHUNK_LOAD_GRACE_TRIES; tries++) {
      await new Promise((resolve) => setTimeout(resolve, CHUNK_LOAD_WAIT_MS))
      if (this.goal !== goal) return { ok: false, error: 'superseded' }
      r = this.planNow(goal)
    }
    if (process.env.MINEPILOT_DEBUG_PLAN === '1') {
      this.emit('log', `plan ${r.status}: ${r.moves ? r.moves.length : 0} moves, ${r.expanded || 0} nodes, endH ${Number(r.endHeuristic || 0).toFixed(1)}`)
    }
    if (r.status === 'found' || r.status === 'partial') {
      this.partial = r.status === 'partial'
      this.pathPointsCache = nodesToPoints(r.nodes)
      if (this.partial && !this.trackPartialEnd(r)) return { ok: true, reply: 'already as close as the world allows' }
      this.executor.run(r.moves)
      if (this.partial) this.emit('log', 'partial path: heading as close as the loaded world allows')
      this.emit('path', {
        points: this.pathPointsCache,
        goal: this.goalLabel,
        partial: this.partial,
        cost: Math.round(r.cost * 10) / 10
      })
      this.emit('task')
      return { ok: true, reply: `moving to ${this.goalLabel}` }
    }
    this.task = 'idle'
    this.goal = null
    this.emit('task')
    return { ok: false, error: 'no path to target' }
  }

  trackPartialEnd (r) {
    const end = r.moves.length ? r.moves[r.moves.length - 1].to : r.nodes[r.nodes.length - 1]
    const k = end.x + ',' + end.y + ',' + end.z
    if (this.partialPrevEnd && this.partialPrevEnd === k) {
      this.emit('log', 'partial arrival: the goal lies beyond the loaded world')
      this.executor.stop()
      this.task = 'idle'
      this.emit('arrived', { goal: this.goalLabel, partial: true })
      this.emit('task')
      return false
    }
    this.partialPrevEnd = k
    return true
  }

  scheduleReplan () {
    if (!this.goal || this.replanPending || this.paused) return
    const now = Date.now()
    const wait = Math.max(0, REPLAN_DEBOUNCE_MS - (now - this.lastReplanAt))
    this.replanPending = true
    setTimeout(() => {
      this.replanPending = false
      this.replan()
    }, wait)
  }

  replan () {
    if (!this.goal || this.task === 'idle' || this.paused) return
    const r = this.planNow(this.goal)
    if (r.status === 'found' || r.status === 'partial') {
      this.lastReplanAt = Date.now()
      this.partial = r.status === 'partial'
      this.pathPointsCache = nodesToPoints(r.nodes)
      if (this.partial && !this.trackPartialEnd(r)) return
      this.executor.replans++
      this.executor.run(r.moves)
      this.emit('path', { points: this.pathPointsCache, goal: this.goalLabel, partial: this.partial })
    } else {
      this.consecutiveFails++
      this.emit('log', `replan failed (${this.consecutiveFails}/${MAX_CONSECUTIVE_FAILS})`)
      if (this.consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
        this.executor.stop()
        this.executor.emit('failed', { reason: 'no path' })
      } else {
        setTimeout(() => this.replan(), 600)
      }
    }
  }

  onArrived () {
    if (this.activeJob !== 0) return // the running process owns arrival
    if (this.task === 'follow') return // the follow timer keeps it going
    if (this.partial && this.goal && this.task === 'goto') {
      this.replan()
      return
    }
    let settledByEscape = false
    if (this.escapeOf) {
      const resume = this.escapeOf
      this.escapeOf = null
      if ((this.escapeHops || 0) < 5) {
        this.escapeHops = (this.escapeHops || 0) + 1
        this.launch(resume.goal, resume.task).catch(() => {})
        return
      }
      this.emit('log', 'water escape loop: settling at the nearest dry land')
      settledByEscape = true
    }
    const n = this.node()
    const goalMetHere = this.goal && n && this.goal.isMet(n.x, n.y, n.z)
    if (!settledByEscape && !goalMetHere && n && this.view.water(n.x, n.y, n.z)) {
      const land = this.nearestDryCell(n)
      if (land) {
        if (this.goal && this.task === 'goto') this.escapeOf = { goal: this.goal, task: this.task }
        const r = this.driveTo(new GoalBlock(land.x, land.y, land.z))
        if (r && (r.status === 'found' || r.status === 'partial')) return
      }
    }
    this.emit('arrived', { goal: this.goalLabel })
    // baritone keeps the goal set after arrival (#eta reports done, a new
    // #path re-walks it); the TASK retires but the goal object stays.
    this.task = 'idle'
    this.pathPointsCache = []
    this.escapeHops = 0
    this.emit('task')
  }

  nearestDryCell (from) {
    let best = null
    let bestD = Infinity
    for (let dx = -10; dx <= 10; dx++) {
      for (let dz = -10; dz <= 10; dz++) {
        const x = from.x + dx
        const z = from.z + dz
        for (let dy = -4; dy <= 8; dy++) {
          const y = from.y + dy
          if (!this.view.known(x, y - 1, z)) continue
          if (this.view.standable(x, y - 1, z) &&
            this.view.passable(x, y, z) && !this.view.water(x, y, z) &&
            this.view.passable(x, y + 1, z)) {
            const d = dx * dx + dy * dy + dz * dz
            if (d < bestD) { bestD = d; best = { x, y, z } }
            break
          }
        }
      }
    }
    return best
  }

  // ---- pause / resume (baritone #pause semantics) ------------------------

  pause (by) {
    if (this.paused) return { ok: true, reply: 'already paused' }
    this.paused = true
    this.pausedBy = by || 'user'
    this.executor.stop()
    this.emit('log', `paused by ${this.pausedBy}`)
    this.emit('task')
    return { ok: true, reply: 'paused' }
  }

  resume () {
    if (!this.paused) return { ok: true, reply: 'not paused' }
    this.resumeInternal()
    if (!this.goal && this.activeJob === 0) return { ok: true, reply: 'nothing to resume' }
    this.replan()
    this.emit('task')
    return { ok: true, reply: 'resumed' }
  }

  resumeInternal () {
    this.paused = false
    this.pausedBy = null
  }

  // ---- verbs ----------------------------------------------------------

  goto (x, y, z) {
    const goal = (y === null || y === undefined)
      ? new GoalXZ(Math.floor(x), Math.floor(z))
      : new GoalBlock(Math.floor(x), Math.floor(y), Math.floor(z))
    return this.launch(goal, 'goto')
  }

  // baritone's #goal: set the persistent goal WITHOUT walking. #path then
  // walks toward whatever goal is set.
  setGoal (goal, label) {
    this.goal = goal
    this.goalLabel = label || goal.label()
    this.emit('task')
    return { ok: true, reply: `goal set: ${this.goalLabel}` }
  }

  path () {
    if (!this.goal) return { ok: false, error: 'no goal set — use goto or goal first' }
    return this.launch(this.goal, 'goto')
  }

  come (target) {
    const goal = new GoalNear(Math.floor(target.x), Math.floor(target.y), Math.floor(target.z), 1)
    return this.launch(goal, 'goto')
  }

  follow (getPosition, radius) {
    if (this.paused) this.resumeInternal()
    this.stopFollowTimer()
    this.goal = new GoalFollow(getPosition, radius)
    this.task = 'follow'
    this.goalLabel = this.goal.label()
    this.consecutiveFails = 0
    this.replan()
    this.followTimer = setInterval(() => {
      if (this.task !== 'follow' || this.paused) return
      const r = this.planNow(this.goal)
      if (r.status === 'found' || r.status === 'partial') {
        const cur = this.executor.queue.length
          ? this.executor.queue[this.executor.queue.length - 1].to
          : null
        const t = this.goal.target()
        if (!cur || !t || Math.abs(cur.x - t.x) + Math.abs(cur.z - t.z) > 2) {
          this.pathPointsCache = nodesToPoints(r.nodes)
          this.executor.replans++
          this.executor.run(r.moves)
          this.emit('path', { points: this.pathPointsCache, goal: this.goalLabel, partial: r.status === 'partial' })
        }
      }
    }, FOLLOW_REFRESH_MS)
    this.emit('task')
    return { ok: true, reply: 'following' }
  }

  stopFollowTimer () {
    if (this.followTimer) {
      clearInterval(this.followTimer)
      this.followTimer = null
    }
  }

  // goal constructors that mirror baritone one-liners

  thisway (distance) {
    const e = this.bot.entity
    if (!e) return { ok: false, error: 'no position yet' }
    // mineflayer yaw: 0 faces north (-z); facing = (-sin yaw, -cos yaw)
    const yaw = e.yaw || 0
    const fx = -Math.sin(yaw)
    const fz = -Math.cos(yaw)
    // snap to the nearest of the 8 compass directions, like baritone
    const dirs = [
      { x: 0, z: -1 }, { x: 1, z: -1 }, { x: 1, z: 0 }, { x: 1, z: 1 },
      { x: 0, z: 1 }, { x: -1, z: 1 }, { x: -1, z: 0 }, { x: -1, z: -1 }
    ]
    let best = dirs[0]
    let bestDot = -Infinity
    for (const d of dirs) {
      const len = Math.hypot(d.x, d.z)
      const dot = (fx * d.x + fz * d.z) / len
      if (dot > bestDot) { bestDot = dot; best = d }
    }
    const n = this.node()
    const goal = new GoalStrictDirection(n.x, n.y, n.z, best)
    return this.launch(goal, 'thisway')
  }

  axis () {
    return this.launch(new GoalAxis(), 'axis')
  }

  // walk to the surface: the first standable column above the current
  // position with sky above it (baritone #surface)
  surface () {
    const n = this.node()
    if (!n) return { ok: false, error: 'no position yet' }
    const e = this.bot.entity
    const minY = Math.floor((e && e.position ? e.position.y : n.y) + 1)
    let surfaceY = null
    for (let y = minY; y < 320; y++) {
      if (!this.view.known(n.x, y, n.z)) continue // fog: keep climbing
      if (this.view.standable(n.x, y, n.z) && this.view.passable(n.x, y + 1, n.z)) {
        surfaceY = y + 1
        break
      }
    }
    if (surfaceY === null) return { ok: false, error: 'no surface found above (unloaded chunks?)' }
    return this.launch(new GoalYLevel(surfaceY), 'surface')
  }

  // baritone #invert: walk away from the current goal (GoalInverted)
  invert () {
    if (!this.goal) return { ok: false, error: 'no goal to invert — set one first' }
    return this.launch(new GoalInverted(this.goal), 'invert')
  }

  // walk away from a point until outside the radius (#flee)
  runAway (x, z, radius) {
    return this.launch(new GoalRunAway(Math.floor(x), Math.floor(z), radius || 16), 'runaway')
  }

  // wait for the executor to arrive (or fail). resolves false on timeout —
  // callers treat that as "could not reach" and decide what it means.
  waitArrival (timeoutMs) {
    return new Promise((resolve) => {
      // an empty plan finishes synchronously inside run(), before any
      // listener could attach — treat an already-idle executor as arrived
      if (!this.executor.running) {
        resolve(true)
        return
      }
      const to = setTimeout(() => {
        cleanup()
        resolve(false)
      }, timeoutMs || 120000)
      const onArrived = () => { cleanup(); resolve(true) }
      const onFailed = () => { cleanup(); resolve(false) }
      const cleanup = () => {
        clearTimeout(to)
        this.executor.removeListener('arrived', onArrived)
        this.executor.removeListener('failed', onFailed)
      }
      this.executor.once('arrived', onArrived)
      this.executor.once('failed', onFailed)
    })
  }

  // ---- eta (baritone #eta) ---------------------------------------------

  eta () {
    const p = this.pos()
    if (!p) return { ok: false, error: 'no position yet' }
    if (!this.goal) return { ok: false, error: 'no goal set' }
    const n = this.node()
    const met = n && this.goal.isMet(n.x, n.y, n.z)
    const h = this.goal.heuristic(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
    const blocks = Math.round(h)
    // optimistic walk speed incl. sprint; honest about being an estimate
    const seconds = Math.round(h / (this.s.allowSprint ? 5.6 : 4.3))
    return {
      ok: true,
      arrived: !!met,
      blocks,
      seconds,
      goal: this.goalLabel,
      task: this.task,
      partial: this.partial,
      progress: this.executor.index,
      total: this.executor.queue.length
    }
  }

  // ---- processes ---------------------------------------------------------

  // run a process to completion in the background. fn receives an alive()
  // closure; the process dies the moment stop() or a newer job flips the
  // sequence. completion, failure and cleanup are logged here so the
  // process modules can stay pure loops.
  async runJob (task, label, fn) {
    this.stopFollowTimer()
    if (this.paused) this.resumeInternal()
    const id = ++this.jobSeq
    this.activeJob = id
    this.activeProcessName = task
    this.task = task
    this.goalLabel = label
    this.consecutiveFails = 0
    this.emit('task')
    const finish = () => {
      if (this.activeJob !== id) return
      this.activeJob = 0
      this.activeProcessName = null
      this.task = 'idle'
      this.goalLabel = ''
      this.pathPointsCache = []
      this.emit('task')
      backfillAfterTask(this)
    }
    try {
      const out = await fn(() => this.activeJob === id && !this.paused)
      finish()
      return out
    } catch (err) {
      this.executor.stop()
      if (this.activeJob === id) {
        this.emit('log', `${task} failed: ${String(err.message || err).slice(0, 90)}`)
      }
      finish()
      return null
    }
  }

  startJob (task, label, fn) {
    this.runJob(task, label, fn).catch(() => { /* runJob never rejects */ })
    return { ok: true }
  }

  // plan toward a goal and drive there, the way goto does, but callable
  // from inside a process loop (the task label stays the process's).
  // a stale plan must be able to splice + replan: mark the task active
  // when called with no task set, or replan() would refuse to run.
  driveTo (goal) {
    const r = this.planNow(goal)
    if (r.status !== 'found' && r.status !== 'partial') return r
    this.goal = goal
    this.goalLabel = goal.label()
    if (this.task === 'idle') {
      this.task = 'goto'
      this.emit('task')
    }
    this.partial = r.status === 'partial'
    this.pathPointsCache = nodesToPoints(r.nodes)
    if (this.partial && !this.trackPartialEnd(r)) return { status: 'partial-stuck' }
    this.executor.run(r.moves)
    this.emit('path', {
      points: this.pathPointsCache,
      goal: this.goalLabel,
      partial: this.partial,
      cost: Math.round(r.cost * 10) / 10
    })
    return r
  }

  mine (names, count) {
    this.stopFollowTimer()
    this.task = 'mine'
    this.goalLabel = `mine ${names.join(' ')} x${count}`
    this.consecutiveFails = 0
    this.emit('task')
    const id = ++this.jobSeq
    this.activeJob = id
    this.activeProcessName = 'mine'
    this.mineLoop = runMine(this, names, count, () => this.activeJob === id && !this.paused)
      .then((out) => {
        this.mineLoop = null
        if (this.activeJob !== id) return null
        this.activeJob = 0
        this.activeProcessName = null
        this.task = 'idle'
        this.goal = null
        this.goalLabel = ''
        this.pathPointsCache = []
        this.emit('arrived', { goal: `mine ${names[0]}` })
        this.emit('task')
        return out
      })
      .catch((err) => {
        this.mineLoop = null
        if (this.activeJob !== id) return 0
        this.activeJob = 0
        this.activeProcessName = null
        this.task = 'idle'
        this.goal = null
        this.goalLabel = ''
        this.emit('log', `mine failed: ${String(err.message || err).slice(0, 80)}`)
        this.emit('task')
        return null
      })
    return { ok: true, reply: `mining ${count} x ${names[0]}` }
  }

  build (blueprint, origin) {
    const o = origin || this.anchorHere()
    this.startJob('build', `build ${blueprint.name}`, (alive) => runBuilder(this, blueprint, o, alive))
    return { ok: true, reply: `building ${blueprint.name} (${blueprint.placements.length} cells)` }
  }

  farm (radius) {
    this.startJob('farm', `farm r${radius}`, (alive) => runFarm(this, radius, alive))
    return { ok: true, reply: `farming within ${radius} blocks` }
  }

  explore (radius) {
    this.startJob('explore', `explore r${radius}`, (alive) => runExplore(this, radius, alive))
    return { ok: true, reply: `exploring within ${radius} blocks` }
  }

  anchorHere () {
    const n = this.node()
    return n ? { x: n.x, y: n.y, z: n.z } : { x: 0, y: 0, z: 0 }
  }

  // ---- process helpers (used by every process module) -------------------

  hasItem (name) {
    try {
      const items = this.bot.inventory ? this.bot.inventory.items() : []
      return items.find((it) => it && it.name === name) || null
    } catch (e) { return null }
  }

  countItem (name) {
    try {
      const items = this.bot.inventory ? this.bot.inventory.items() : []
      return items.filter((it) => it && it.name === name)
        .reduce((sum, it) => sum + (it.count || 1), 0)
    } catch (e) { return 0 }
  }

  async equipItem (item) {
    try {
      if (this.bot.equip && item) await this.bot.equip(item, 'hand')
    } catch (e) { /* fakes and edge states may not equip */ }
  }

  botBlockAt (cell) {
    try {
      return this.bot.world.getBlock(new this.deps.Vec3(cell.x, cell.y, cell.z)) || null
    } catch (e) { return null }
  }

  lookAtCell (x, y, z) {
    try {
      if (this.bot.lookAt) return this.bot.lookAt(new this.deps.Vec3(x + 0.5, y + 0.5, z + 0.5))
    } catch (e) { /* ignore */ }
  }

  async placeRefFace (refBlock, face) {
    return this.bot.placeBlock(refBlock, new this.deps.Vec3(face.x, face.y, face.z))
  }

  isNearCell (x, y, z, r) {
    const n = this.node()
    if (!n) return false
    const dx = n.x - x
    const dy = n.y - y
    const dz = n.z - z
    return dx * dx + dy * dy + dz * dz <= r * r
  }

  // dig a single cell (used by the mine loop, the builder, the
  // excavator). never throws: failures are logged and the caller decides.
  async digCell (cell) {
    const block = this.botBlockAt(cell)
    if (!block) return false
    try {
      this.lookAtCell(cell.x, cell.y, cell.z)
      await Promise.race([
        this.bot.dig(block),
        new Promise((resolve, reject) => setTimeout(() => reject(new Error('dig timeout')), 20000))
      ])
      return true
    } catch (e) {
      this.emit('log', `dig failed: ${String(e.message || e).slice(0, 60)}`)
      return false
    }
  }

  // ---- lifecycle ---------------------------------------------------------

  stop () {
    this.stopFollowTimer()
    this.activeJob = 0 // any running process sees alive() turn false
    this.mineLoop = null
    this.goal = null
    this.task = 'idle'
    this.partial = false
    this.pathPointsCache = []
    this.paused = false
    this.pausedBy = null
    this.executor.stop()
    this.emit('task')
  }

  dispose () {
    this.stop()
    this.executor.dispose()
    this.removeAllListeners()
  }

  // ---- reporting ---------------------------------------------------------

  pathPoints () {
    const pts = this.pathPointsCache
    if (pts.length <= MAX_PATH_POINTS) return pts
    const stride = Math.ceil(pts.length / MAX_PATH_POINTS)
    const out = [pts[0]]
    for (let i = stride; i < pts.length - 1; i += stride) out.push(pts[i])
    out.push(pts[pts.length - 1])
    return out
  }

  info () {
    const e = this.executor.snapshot()
    return {
      task: this.task,
      process: this.activeProcessName,
      goal: this.goalLabel,
      partial: this.partial,
      paused: this.paused,
      progress: e.index,
      total: e.total,
      replans: e.replans,
      stuck: e.stuckEvents,
      move: e.type,
      running: e.running
    }
  }
}

function nodesToPoints (nodes) {
  const out = []
  for (const n of nodes || []) out.push([n.x, n.y, n.z])
  return out
}

module.exports = { Autopilot, MAX_PATH_POINTS, octile }
