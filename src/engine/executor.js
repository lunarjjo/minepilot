'use strict'

// the executor: turns a plan (a list of movements) into live physics.
// it drives the bot the way baritone drives a player:
//
//   steering  consecutive collinear segments are MERGED — the bot aims at
//             a look-ahead point down the path instead of stopping its
//             gaze on every cell center, so corners are cut smoothly and
//             forward/sprint are never released between blocks (the old
//             per-cell control reset was the stutter)
//   sprint    enabled on straight runs of 3+ blocks; sprint-JUMP (hold
//             jump, auto re-jump on landing — the bunny hop) on flat runs
//             of 4+ with headroom: ~7 blocks/s, the trick that makes
//             baritone cover flat ground absurdly fast
//   validate  the near future is re-checked with a CHEAP per-move
//             validator every other tick; the first move that stops being
//             true forces a splice (replan), never a blind walk into a
//             wall the world just placed there. (the old validator
//             regenerated the full movement list and doomed chained
//             placements — a bridge's next move never "existed" until the
//             current one placed its block, so bridging replanned forever
//             without placing anything)
//   dig       movements that break through blocks dig them FIRST, with
//             the best tool equipped (autoTool), from within reach
//   place     pillar/bridge/ascendPlace movements place before stepping
//
// the bot interface it needs is small (look, setControlState, dig,
// placeBlock, world.getBlock, entity) so the same executor runs against
// the kinematic fake in unit tests and a real mineflayer bot in E2E.

const { EventEmitter } = require('events')
const { validateMove } = require('./moves')
const { equipForPlace, anchorsFor } = require('./place')
const { equipForDig } = require('../autotool')

const TICK_MS = 100
const LOOKAHEAD = 4
const STEER_MAX = 6 // merge up to six collinear segments into one steer
const SPRINT_MIN_RUN = 3 // sprint when the straight run is at least this long
const BUNNY_MIN_RUN = 4 // hold jump (sprint-jump) on flat runs this long
const STUCK_MS = 2500
const STUCK_LIMIT = 6
const ARRIVE_HORZ = 0.45
const ARRIVE_VERT = 1.25
const DIG_REACH = 4.0

// field-diagnosis switch for placement problems: MINEPILOT_DEBUG_PLACE=1
// prints every placement attempt (kind, planned vs live cell) to stderr
const PLACE_DEBUG = process.env.MINEPILOT_DEBUG_PLACE === '1'
// same for digs: MINEPILOT_DEBUG_DIG=1 prints every dig start + every
// timeout with the geometry (cell, block, bot, distance)
const DIG_DEBUG = process.env.MINEPILOT_DEBUG_DIG === '1'

class Executor extends EventEmitter {
  constructor ({ bot, view, settings, Vec3 }) {
    super()
    this.bot = bot
    this.view = view
    this.s = settings
    this.Vec3 = Vec3
    this.queue = []
    this.index = 0
    this.running = false
    this.digging = false
    this.placing = false
    this.placeTries = 0
    this.timer = null
    this.stuckSince = 0
    this.stuckEvents = 0
    this.stuckPos = null
    this.lastDist = Infinity
    this.worseTicks = 0
    this.replans = 0
    this.tickCount = 0
    this.sprinting = false
  }

  // ---- lifecycle -------------------------------------------------------

  run (moves) {
    this.stop()
    this.queue = moves || []
    this.index = 0
    this.running = true
    this.stuckEvents = 0
    this.stuckSince = 0
    this.lastDist = Infinity
    this.worseTicks = 0
    this.placeTries = 0
    this.noMaterial = false
    this.tickCount = 0
    this.sprinting = false
    if (this.queue.length === 0) {
      this.finish('arrived')
      return
    }
    this.emit('progress', { index: 0, total: this.queue.length })
    this.timer = setInterval(() => this.tick(), TICK_MS)
    this.tick()
  }

  stop () {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.running = false
    this.digging = false
    this.sprinting = false
    this.clearControls()
  }

  dispose () {
    this.stop()
    this.removeAllListeners()
  }

  // ---- helpers ---------------------------------------------------------

  pos () {
    const e = this.bot.entity
    return e && e.position ? e.position : null
  }

  clearControls () {
    try { this.bot.clearControlStates() } catch (e) { /* fake without it */ }
  }

  control (key, on) {
    try { this.bot.setControlState(key, on) } catch (e) { /* ignore */ }
  }

  lookAt (x, y, z, pitch) {
    const p = this.pos()
    if (!p) return
    const dx = (x + 0.5) - p.x
    const dz = (z + 0.5) - p.z
    // mineflayer's yaw convention (verified empirically against a live
    // bot): yaw 0 faces north (-z), and the facing vector is
    // (-sin(yaw), -cos(yaw)) — hence atan2(-dx, -dz)
    const yaw = Math.atan2(-dx, -dz)
    try { this.bot.look(yaw, pitch || 0, true) } catch (e) { /* ignore */ }
  }

  lookAtBlock (b) {
    try {
      if (this.bot.lookAt) this.bot.lookAt(new this.Vec3(b.x + 0.5, b.y + 0.5, b.z + 0.5))
      else this.lookAt(b.x, b.y, b.z, 0.4)
    } catch (e) { /* ignore */ }
  }

  blockAt (c) {
    try {
      return this.bot.world.getBlock(new this.Vec3(c.x, c.y, c.z)) || null
    } catch (e) { return null }
  }

  current () {
    return this.queue[this.index] || null
  }

  // ---- main tick -------------------------------------------------------

  tick () {
    if (!this.running || this.digging) return
    const m = this.current()
    if (!m) return
    const p = this.pos()
    if (!p) return
    this.tickCount++

    // validate the near future; a plan that stopped being true must splice.
    // every OTHER tick is plenty — the validator is cheap but the tick is
    // 100ms and the world rarely changes faster than that.
    if ((this.tickCount & 1) === 0) {
      for (let ahead = 0; ahead < LOOKAHEAD; ahead++) {
        const f = this.queue[this.index + ahead]
        if (!f) break
        if (!validateMove(this.view, f)) {
          this.emit('splice', { at: this.index + ahead, reason: 'world changed' })
          return
        }
      }
    }

    // break through what needs breaking — but only from within reach: a
    // dig started out of reach is the "hasty" swing that never lands
    const pending = m.toBreak.filter((b) => this.view.solid(b.x, b.y, b.z))
    if (pending.length > 0) {
      const f = pending[0]
      const d = Math.hypot((f.x + 0.5) - p.x, (f.y + 0.5) - (p.y + 1), (f.z + 0.5) - p.z)
      if (d > DIG_REACH) {
        // walk toward the work first; the dig starts once it is in reach
        this.drive(m, p)
        return
      }
      this.digThrough(pending)
      return
    }

    // place support (pillar) or the next bridge plank before stepping
    if (m.toPlace && m.toPlace.length > 0 && !this.placedFor(m)) {
      this.placeFor(m).catch(() => { /* guarded inside */ })
      return
    }

    this.drive(m, p)

    if (this.arrivedCheck(m, p)) {
      this.advance(m)
      return
    }

    this.trackStuck(m, p)
  }

  // ---- steering: merge collinear segments, aim ahead ---------------------

  // the steer target: the furthest endpoint of the run of collinear,
  // work-free walking segments ahead. aiming here instead of the current
  // cell center is what lets the bot flow through straight runs (and
  // diagonals) without per-block stutter; arrival is still measured per
  // cell by arrivedCheck so precision is never lost.
  steerTarget () {
    const m = this.current()
    if (!m) return null
    let end = { x: m.to.x, y: m.to.y, z: m.to.z }
    let run = 1
    let flat = m.to.y === m.from.y
    const dx = Math.sign(m.to.x - m.from.x)
    const dz = Math.sign(m.to.z - m.from.z)
    const mergeable = m.type === 'traverse' || m.type === 'diagonal'
    if (mergeable && (dx !== 0 || dz !== 0)) {
      for (let k = this.index + 1; k < this.queue.length && run < STEER_MAX; k++) {
        const nxt = this.queue[k]
        if (nxt.toBreak.length || (nxt.toPlace && nxt.toPlace.length)) break // work boundary
        if (nxt.type !== 'traverse' && nxt.type !== 'diagonal') break
        const ndx = Math.sign(nxt.to.x - nxt.from.x)
        const ndz = Math.sign(nxt.to.z - nxt.from.z)
        if (ndx !== dx || ndz !== dz) break
        if (nxt.to.y !== nxt.from.y) flat = false
        end = { x: nxt.to.x, y: nxt.to.y, z: nxt.to.z }
        run++
      }
    }
    // headroom for jumping: +2 clear over every cell of the run (the jump
    // raises the body 1.25 above its cells; walking only needs +1)
    let headroom = false
    if (flat && run >= BUNNY_MIN_RUN) {
      headroom = true
      for (let k = this.index; k < this.index + run && headroom; k++) {
        const q = this.queue[k]
        if (!q) { headroom = false; break }
        if (!this.view.passable(q.from.x, q.from.y + 2, q.from.z)) headroom = false
        if (!this.view.passable(q.to.x, q.to.y + 2, q.to.z)) headroom = false
      }
    }
    const cellsLeft = this.queue.length - this.index
    return { x: end.x, y: end.y, z: end.z, run, flat, headroom, nearEnd: cellsLeft <= 2 }
  }

  // ---- movement driving ------------------------------------------------

  drive (m, p) {
    const steer = this.steerTarget() || { x: m.to.x, y: m.to.y, z: m.to.z, run: 1, flat: true, headroom: false, nearEnd: true }
    const aimAtCurrent = m.type === 'descend' || m.type === 'fall' || m.type === 'parkour' ||
      m.type === 'bridge' || m.type === 'ascend' || m.type === 'pillar' || m.type === 'climb'
    const tx = aimAtCurrent ? m.to.x : steer.x
    const tz = aimAtCurrent ? m.to.z : steer.z

    this.lookAt(tx, m.to.y, tz, m.type === 'fall' ? 0.25 : (m.type === 'ascend' ? -0.15 : 0))

    switch (m.type) {
      case 'traverse':
      case 'diagonal':
      case 'ascendPlace': {
        this.control('forward', true)
        // sprint on straight runs; the steer merge is what makes a run
        // long enough to be worth the sprint at all
        const canSprint = this.s.allowSprint !== false && steer.run >= SPRINT_MIN_RUN && !steer.nearEnd
        this.control('sprint', canSprint)
        this.sprinting = canSprint
        // the bunny hop: hold jump while sprinting a flat straight run
        // with headroom. mineflayer re-jumps on every landing, which is
        // exactly how a player sprint-jumps — ~7 blocks/s on flat ground
        const hop = canSprint && this.s.allowSprintJump !== false &&
          steer.run >= BUNNY_MIN_RUN && steer.flat && steer.headroom
        this.control('jump', hop)
        break
      }
      case 'swim':
        // surface swim: keep bobbing up so a long crossing never drains
        // the air bar — a submerged bot drowns, a floating one does not
        this.control('forward', true)
        this.control('sprint', false)
        this.control('jump', true)
        break
      case 'ascend':
      case 'ascendPlace':
      case 'pillar':
        this.control('forward', true)
        // hold the jump while below the step, and while in water (the way
        // out of a pool is jump + forward against the bank). on land the
        // early release lets the bot settle instead of hopping forever.
        {
          const inWater = this.view.water(Math.floor(p.x), Math.floor(p.y + 0.1), Math.floor(p.z))
          this.control('jump', p.y < m.to.y - 0.3 || inWater)
        }
        this.control('sprint', false)
        this.sprinting = false
        break
      case 'climb':
        this.control('forward', true)
        this.control('jump', m.to.y > m.from.y)
        this.control('sprint', false)
        this.sprinting = false
        break
      case 'descend':
        this.control('forward', true)
        this.control('jump', false)
        this.control('sprint', false)
        this.sprinting = false
        break
      case 'digFall':
        // the shaft digs itself: the pending-break loop eats the column
        // top-down and the body drops one block per break. stand still,
        // look down, and let gravity do the walking
        this.control('forward', false)
        this.control('jump', false)
        this.control('sprint', false)
        this.sprinting = false
        break
      case 'fall':
        this.control('forward', true)
        this.control('jump', false)
        this.control('sprint', false)
        this.sprinting = false
        break
      case 'parkour':
      case 'bridge':
        this.control('forward', true)
        this.control('sprint', m.type === 'parkour')
        this.control('jump', m.type === 'parkour')
        this.sprinting = m.type === 'parkour'
        break
      default:
        this.control('forward', true)
    }
  }

  arrivedCheck (m, p) {
    const dx = (m.to.x + 0.5) - p.x
    const dz = (m.to.z + 0.5) - p.z
    const horz = Math.sqrt(dx * dx + dz * dz)
    const vert = Math.abs(p.y - m.to.y)

    const v = this.bot.entity.velocity
    const inWaterNow = this.view.water(Math.floor(p.x), Math.floor(p.y + 0.1), Math.floor(p.z))
    // a swimming bot bobs by design — do not wait for it to settle
    const settled = inWaterNow || !v || !Number.isFinite(v.y) || Math.abs(v.y) < 0.35

    if (horz <= ARRIVE_HORZ && vert <= ARRIVE_VERT && settled) return true

    // PASSED the node: beyond its center along the movement direction. a
    // sprinting bot (and a bunny-hopping one, which is airborne over cell
    // centers with velocity.y far from settled) must not orbit back to a
    // node it already crossed — the old forgiveness needed 8 worsening
    // ticks and a sub-1.6 miss, which turned overshoots into figure
    // eights. only for intermediate nodes: the LAST node gets the strict
    // centered+settled arrival above.
    const dirx = Math.sign(m.to.x - m.from.x)
    const dirz = Math.sign(m.to.z - m.from.z)
    if ((dirx !== 0 || dirz !== 0) && this.index < this.queue.length - 1) {
      const past = (p.x - (m.to.x + 0.5)) * dirx + (p.z - (m.to.z + 0.5)) * dirz
      if (past > 0.3 && vert <= ARRIVE_VERT + 0.5) return true
    }

    // walked past and getting worse anyway: forgive a small miss
    if (horz > this.lastDist + 0.01) {
      this.worseTicks++
      if (this.worseTicks > 8 && horz < 1.6 && vert <= ARRIVE_VERT) return true
    } else {
      this.worseTicks = 0
    }
    this.lastDist = horz
    return false
  }

  advance (m) {
    this.index++
    this.stuckSince = 0
    this.stuckPos = null
    this.lastDist = Infinity
    this.worseTicks = 0
    this.placeTries = 0
    this.emit('progress', { index: this.index, total: this.queue.length })
    if (this.index >= this.queue.length) {
      this.finish('arrived')
    } else {
      // keep walking: only drop the transient controls. releasing
      // forward between cells was the per-block stutter; the next drive()
      // re-applies forward/sprint/jump as its steering demands
      this.control('jump', false)
      this.control('sneak', false)
    }
    void m
  }

  finish (kind, extra) {
    this.running = false
    this.sprinting = false
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.clearControls()
    this.emit(kind, extra || null)
  }

  // ---- stuck handling --------------------------------------------------

  // stuck = no PROGRESS TOWARD THE CURRENT MOVE for a while. the old
  // detector measured any position change — a bot bouncing on a jump arc
  // (an ascend whose launch floor was dug out from under it) "moved" 1.4
  // blocks every 300ms and never tripped. measuring the distance to the
  // move's own target ratchets: only real approach resets the clock, and
  // oscillation around the same distance ages out into an escalation.
  trackStuck (m, p) {
    const dist = Math.hypot((m.to.x + 0.5) - p.x, m.to.y - p.y, (m.to.z + 0.5) - p.z)
    if (!this.stuckPos) {
      this.stuckPos = { x: p.x, y: p.y, z: p.z, t: Date.now(), dist }
      return
    }
    if (dist < this.stuckPos.dist - 0.35) {
      // real progress toward this move — restart the clock
      this.stuckPos = { x: p.x, y: p.y, z: p.z, t: Date.now(), dist }
      return
    }
    const held = Date.now() - this.stuckPos.t
    if (held < STUCK_MS) return

    this.stuckEvents++
    this.stuckPos = { x: p.x, y: p.y, z: p.z, t: Date.now(), dist }
    this.emit('stuck', { events: this.stuckEvents, move: m.type })

    if (this.stuckEvents >= STUCK_LIMIT) {
      this.finish('failed', { reason: 'stuck', events: this.stuckEvents })
      return
    }

    // the most common stuck by far: a solid block at feet or head ahead.
    // dig it out FIRST (with the right tool) — jumping into a wall or
    // replanning into the same wall both just burn time
    const dirx = Math.sign(m.to.x - m.from.x)
    const dirz = Math.sign(m.to.z - m.from.z)
    if ((dirx !== 0 || dirz !== 0) && this.s.allowBreak) {
      const fx = Math.floor(p.x)
      const fy = Math.floor(p.y)
      const fz = Math.floor(p.z)
      const diggable = []
      for (const c of [
        { x: fx + dirx, y: fy, z: fz + dirz },
        { x: fx + dirx, y: fy + 1, z: fz + dirz }
      ]) {
        if (!this.view.solid(c.x, c.y, c.z)) continue
        const info = this.view.breakInfo(c.x, c.y, c.z)
        if (info && info.breakable) diggable.push(c)
      }
      if (diggable.length > 0) {
        this.digThrough(diggable)
        return
      }
    }
    // then the classic ladder: nudge-jump, then splice into a replan
    if (this.stuckEvents % 2 === 1) {
      this.control('jump', true)
      this.control('forward', true)
      setTimeout(() => { try { this.bot.setControlState('jump', false) } catch (e) { /* gone */ } }, 600)
    } else {
      this.emit('splice', { at: this.index, reason: 'stuck' })
    }
  }

  // ---- digging ---------------------------------------------------------

  async digThrough (cells) {
    if (this.digging) return
    this.digging = true
    this.clearControls()
    try {
      for (const c of cells) {
        let block = this.blockAt(c)
        if (!block || (block.boundingBox === 'empty')) continue
        // autoTool, baritone-style: swing the right tool before every dig.
        // mining stone bare-handed takes 7.5s a block and the dig timeout
        // eats the whole movement; a pickaxe makes it under a second
        if (this.s.autoTool !== false) {
          try { await equipForDig(this.bot, block.name) } catch (e) { /* fakes may not equip */ }
        }
        // digging with the head underwater is drastically slower and burns
        // air the bot does not have — bail fast and let replanning route
        // around it instead of drowning mid-swing
        const p = this.pos()
        const submerged = p && this.view.water(Math.floor(p.x), Math.floor(p.y + 1.62), Math.floor(p.z))
        // the cap must RESPECT the real dig time: a bare-hand cobblestone
        // dig legitimately takes 10s, and a cap shorter than that restarts
        // the swing forever (each restart resets progress server-side) —
        // the exact "cannot break blocks" field report
        let digMs = 8000
        try {
          if (typeof this.bot.digTime === 'function') digMs = this.bot.digTime(block)
        } catch (e) { /* fakes */ }
        const capMs = submerged ? Math.min(6000, Math.max(4000, digMs)) : Math.max(8000, digMs + 5000)
        // a hung dig (server never acks: occluded target, misaligned look)
        // gets ONE re-look + retry, then the movement splices into a replan
        // — a 20s dead swing was the difference between a stumble and a
        // failed path
        for (let attempt = 0; attempt < 2; attempt++) {
          this.lookAtBlock(c)
          if (DIG_DEBUG) {
            const p = this.pos()
            const d = p ? Math.hypot((c.x + 0.5) - p.x, (c.y + 0.5) - (p.y + 1.62), (c.z + 0.5) - p.z) : -1
            console.error(`[dig] ${block.name} at (${c.x},${c.y},${c.z}) bot=(${p ? p.x.toFixed(1) + ',' + p.y.toFixed(1) + ',' + p.z.toFixed(1) : '?'}) dist=${d.toFixed(1)} attempt=${attempt}`)
          }
          try {
            const digP = this.bot.dig(block)
            // a timed-out dig may reject AFTER the race is lost (the swing
            // finally aborts); an unhandled late rejection would crash the
            // whole stack — swallow it, the retry owns the recovery
            if (digP && digP.catch) digP.catch(() => {})
            await Promise.race([
              digP,
              new Promise((resolve, reject) => setTimeout(() => reject(new Error('dig timeout')), capMs))
            ])
            break
          } catch (e) {
            if (attempt === 0 && String(e.message || e).includes('timeout')) {
              // the block reference may be stale after the world moved —
              // re-read it before the retry
              const fresh = this.blockAt(c)
              if (fresh && fresh.boundingBox !== 'empty') {
                block = fresh
                await new Promise((r) => setTimeout(r, 120))
                continue
              }
              break
            }
            throw e
          }
        }
        // the backfill process wants to know about every hole we make
        if (this.onDig) this.onDig(c.x, c.y, c.z)
      }
    } catch (e) {
      this.emit('log', `dig failed: ${String(e.message || e).slice(0, 80)}`)
    } finally {
      this.digging = false
    }
  }

  // ---- placing (pillar + bridge + ascendPlace) --------------------------

  placedFor (m) {
    const c = m.toPlace[0]
    return this.view.solid(c.x, c.y, c.z)
  }

  bumpPlaceTries () {
    this.placeTries++
    if (this.placeTries > 8) {
      this.placeTries = 0
      this.emit('splice', { at: this.index, reason: 'cannot place' })
    }
  }

  // resolve the anchor block + face for a placement cell: an explicit
  // ref first (bridges), then ANY solid neighbor face (the staircase-up
  // has no fixed anchor — whatever the world offers), then below.
  // the returned `ref` is the anchor CELL — aim the crosshair at its
  // center: strict servers (26.3) validate the eye ray against the
  // claimed anchor, and aiming at the destination (still air) gets the
  // placement silently refused.
  anchorFor (c) {
    if (c.ref) {
      const b = this.blockAt(c.ref)
      if (b) return { block: b, ref: { x: c.ref.x, y: c.ref.y, z: c.ref.z }, face: c.face || { x: 0, y: 1, z: 0 } }
    }
    for (const a of anchorsFor(this.view, c)) {
      const b = this.blockAt(a.ref)
      if (b) return { block: b, ref: { x: a.ref.x, y: a.ref.y, z: a.ref.z }, face: a.face }
    }
    const below = this.blockAt({ x: c.x, y: c.y - 1, z: c.z })
    if (below) return { block: below, ref: { x: c.x, y: c.y - 1, z: c.z }, face: { x: 0, y: 1, z: 0 } }
    return null
  }

  async placeFor (m) {
    if (this.placing) return
    this.placing = true
    const dbg = PLACE_DEBUG
    try {
      const c = m.toPlace[0]
      const kind = m.placeKind || (m.type === 'pillar' ? 'pillar' : 'bridge')
      if (dbg) {
        const p = this.pos()
        console.error(`[place] kind=${kind} plan=(${c.x},${c.y},${c.z}) live=(${p ? Math.floor(p.x) : '?'},${p ? Math.floor(p.y) : '?'},${p ? Math.floor(p.z) : '?'}) idx=${this.index}/${this.queue.length}`)
      }
      const item = await equipForPlace(this.view, this.bot, c.block || null)
      if (!item) {
        // log once per no-material episode, not once per movement tick
        if (!this.noMaterial) {
          this.emit('log', c.block ? `no ${c.block} left to place` : 'nothing in the inventory to place')
        }
        this.noMaterial = true
        this.emit('noMaterial')
        this.bumpPlaceTries()
        return
      }
      if (kind === 'bridge') {
        // stand still, sneak over the edge, and AIM AT THE ANCHOR — the
        // server raycasts the eye against the block the packet claims was
        // clicked, so the crosshair must be on the anchor itself (the
        // builder has always done it this way; aiming at the destination
        // cell gets the placement refused on strict servers)
        const anchor = this.anchorFor(c)
        if (!anchor) {
          this.bumpPlaceTries()
          return
        }
        this.control('forward', false)
        this.control('sneak', true)
        this.lookAtBlock(anchor.ref)
        await this.bot.placeBlock(anchor.block, new this.Vec3(anchor.face.x, anchor.face.y, anchor.face.z))
        setTimeout(() => this.control('sneak', false), 250)
      } else if (kind === 'ascend') {
        // staircase up: place the missing support beside us, then step
        // onto it like a normal ascend. aim at the anchor, not the air cell
        const anchor = this.anchorFor(c)
        if (!anchor) {
          this.bumpPlaceTries()
          return
        }
        this.lookAtBlock(anchor.ref)
        await this.bot.placeBlock(anchor.block, new this.Vec3(anchor.face.x, anchor.face.y, anchor.face.z))
      } else {
        // pillar: jump, then place into the cell under our CURRENT feet.
        // the anchor must be the live position, never the plan node — a
        // stale node makes the server place under our rising body and the
        // bot skyrockets on its own blocks while every post-check at the
        // planned cell says "still air" (14 items = a 14-block tower).
        // the rise window also matters: the server refuses placements
        // inside the player bbox, so click only after rising >= 1.0 of
        // the 1.25 jump apex.
        const p0 = this.pos()
        this.control('jump', true)
        let placed = false
        try {
          // rise past 1.08 of the 1.25 apex: at exactly 1.0 the server's
          // (slightly behind) view of the bot still overlaps the target
          // cell and refuses the placement — the racy-pillar stumble
          const rose = await this.waitUntil(() => {
            const p = this.pos()
            return p && p0 && p.y - p0.y >= 1.08
          }, 900)
          if (rose) {
            const p = this.pos()
            const fx = Math.floor(p.x)
            const fy = Math.floor(p0.y)
            const fz = Math.floor(p.z)
            const below = this.blockAt({ x: fx, y: fy - 1, z: fz })
            if (below) {
              // a previous attempt may have landed the block even though
              // its ack raced: the cell being solid is success — placing
              // again would stack another block and rocket the bot upward
              if (!this.view.solid(fx, fy, fz)) {
                // aim straight down at the block under our feet — the eye
                // ray must hit it for the server to accept the click
                this.lookAtBlock({ x: fx, y: fy - 1, z: fz })
                try {
                  await this.bot.placeBlock(below, new this.Vec3(0, 1, 0))
                } catch (e) {
                  if (!this.view.solid(fx, fy, fz)) throw e
                }
              }
              placed = this.view.solid(fx, fy, fz)
            }
          }
        } finally {
          this.control('jump', false)
        }
        if (!placed) this.bumpPlaceTries()
      }
    } catch (e) {
      if (PLACE_DEBUG) console.error(`[place] FAILED: ${String(e.message || e).slice(0, 120)}`)
      this.emit('log', 'place failed: ' + String(e.message || e).slice(0, 160))
      this.bumpPlaceTries()
    } finally {
      this.placing = false
    }
  }

  waitUntil (fn, timeoutMs) {
    return new Promise((resolve) => {
      const t0 = Date.now()
      const iv = setInterval(() => {
        let ok = false
        try { ok = fn() } catch (e) { ok = false }
        if (ok || Date.now() - t0 > timeoutMs) {
          clearInterval(iv)
          resolve(ok && Date.now() - t0 <= timeoutMs)
        }
      }, 40)
    })
  }

  snapshot () {
    return {
      running: this.running,
      index: this.index,
      total: this.queue.length,
      replans: this.replans,
      stuckEvents: this.stuckEvents,
      type: this.current() ? this.current().type : null,
      sprinting: this.sprinting
    }
  }
}

module.exports = { Executor, TICK_MS, STUCK_MS }

