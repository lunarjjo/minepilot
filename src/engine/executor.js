'use strict'

// the executor: turns a plan (a list of movements) into live physics.
// it drives the bot like a player would — look, hold forward, jump at
// steps — and watches the plan the whole way:
//
//   splice   every tick the next few movements are re-validated against
//            the live world; the moment one stops being legal (someone
//            placed a wall, the ground fell away), it asks for a replan
//            instead of walking into it
//   stuck    if the bot stops making progress, escalate: jump-nudge,
//            dig the blocks in the way, then force a replan
//   dig      movements that break through blocks dig them first
//   place    pillar movements jump and place a block underneath
//
// the bot interface it needs is small (look, setControlState, dig,
// placeBlock, world.getBlock, entity) so the same executor runs against
// the kinematic fake in unit tests and a real mineflayer bot in E2E.

const { EventEmitter } = require('events')
const { generate } = require('./moves')
const { equipForPlace } = require('./place')

const TICK_MS = 100
const LOOKAHEAD = 4
const STUCK_MS = 2500
const STUCK_LIMIT = 6
const ARRIVE_HORZ = 0.45
const ARRIVE_VERT = 1.25

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

    // validate the near future; a plan that stopped being true must splice
    if (this.index === 0 || this.arrivedCheck(m, p) === false) {
      for (let ahead = 0; ahead < LOOKAHEAD; ahead++) {
        const f = this.queue[this.index + ahead]
        if (!f) break
        if (!this.stillValid(f)) {
          this.emit('splice', { at: this.index + ahead, reason: 'world changed' })
          return
        }
      }
    }

    // break through what needs breaking
    const pending = m.toBreak.filter((b) => this.view.solid(b.x, b.y, b.z))
    if (pending.length > 0) {
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

  stillValid (m) {
    const fresh = generate(this.view, m.from, this.s)
    return fresh.some((c) => c.to.x === m.to.x && c.to.y === m.to.y && c.to.z === m.to.z && c.type === m.type)
  }

  // ---- movement driving ------------------------------------------------

  drive (m, p) {
    const tx = m.to.x
    const tz = m.to.z
    const dx = (tx + 0.5) - p.x
    const dz = (tz + 0.5) - p.z
    const horz = Math.sqrt(dx * dx + dz * dz)
    const rising = m.to.y > m.from.y

    this.lookAt(tx, m.to.y, tz, m.type === 'fall' ? 0.25 : (m.type === 'ascend' ? -0.15 : 0))

    switch (m.type) {
      case 'traverse':
      case 'diagonal':
        this.control('forward', true)
        this.control('sprint', horz > 2)
        this.control('jump', false)
        break
      case 'swim':
        // surface swim: keep bobbing up so a long crossing never drains
        // the air bar — a submerged bot drowns, a floating one does not
        this.control('forward', true)
        this.control('sprint', false)
        this.control('jump', true)
        break
      case 'ascend':
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
        break
      case 'climb':
        this.control('forward', true)
        this.control('jump', m.to.y > m.from.y)
        this.control('sprint', false)
        break
      case 'descend':
        this.control('forward', horz > 0.2)
        this.control('jump', false)
        this.control('sprint', false)
        break
      case 'fall':
        this.control('forward', horz > 0.35)
        this.control('jump', false)
        this.control('sprint', false)
        break
      case 'parkour':
      case 'bridge':
        this.control('forward', true)
        this.control('sprint', m.type === 'parkour')
        this.control('jump', m.type === 'parkour')
        break
      default:
        this.control('forward', true)
    }
    void rising
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

    // walked past the target: count consecutive worse distances and
    // forgive the miss (physics rarely lands dead-center)
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
      this.clearControls()
    }
    void m
  }

  finish (kind, extra) {
    this.running = false
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.clearControls()
    this.emit(kind, extra || null)
  }

  // ---- stuck handling --------------------------------------------------

  trackStuck (m, p) {
    if (!this.stuckPos) {
      this.stuckPos = { x: p.x, y: p.y, z: p.z, t: Date.now() }
      return
    }
    const moved = Math.abs(p.x - this.stuckPos.x) + Math.abs(p.y - this.stuckPos.y) + Math.abs(p.z - this.stuckPos.z)
    if (moved > 0.35) {
      this.stuckPos = { x: p.x, y: p.y, z: p.z, t: Date.now() }
      return
    }
    const held = Date.now() - this.stuckPos.t
    if (held < STUCK_MS) return

    this.stuckEvents++
    this.stuckPos = { x: p.x, y: p.y, z: p.z, t: Date.now() }
    this.emit('stuck', { events: this.stuckEvents, move: m.type })

    if (this.stuckEvents >= STUCK_LIMIT) {
      this.finish('failed', { reason: 'stuck', events: this.stuckEvents })
      return
    }
    // escalation: nudge-jump, then dig the face ahead, then replan
    if (this.stuckEvents % 3 === 2 && this.s.allowBreak) {
      const f = this.current()
      const dir = f ? { dx: Math.sign(f.to.x - f.from.x), dz: Math.sign(f.to.z - f.from.z) } : { dx: 1, dz: 0 }
      const ahead = [
        { x: Math.floor(p.x) + dir.dx, y: Math.floor(p.y), z: Math.floor(p.z) + dir.dz },
        { x: Math.floor(p.x) + dir.dx, y: Math.floor(p.y) + 1, z: Math.floor(p.z) + dir.dz }
      ]
      const diggable = ahead.filter((c) => this.view.solid(c.x, c.y, c.z))
      if (diggable.length > 0) {
        this.digThrough(diggable)
        return
      }
    }
    if (this.stuckEvents % 3 === 0) {
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
        const block = this.blockAt(c)
        if (!block || (block.boundingBox === 'empty')) continue
        this.lookAtBlock(c)
        // digging with the head underwater is drastically slower and burns
        // air the bot does not have — bail fast and let replanning route
        // around it instead of drowning mid-swing
        const p = this.pos()
        const submerged = p && this.view.water(Math.floor(p.x), Math.floor(p.y + 1.62), Math.floor(p.z))
        const capMs = submerged ? 6000 : 20000
        const done = this.bot.dig(block)
        await Promise.race([
          done,
          new Promise((resolve, reject) => setTimeout(() => reject(new Error('dig timeout')), capMs))
        ])
      }
    } catch (e) {
      this.emit('log', `dig failed: ${String(e.message || e).slice(0, 80)}`)
    } finally {
      this.digging = false
    }
  }

  // ---- placing (pillar + bridge) ---------------------------------------

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

  async placeFor (m) {
    if (this.placing) return
    this.placing = true
    try {
      const c = m.toPlace[0]
      const bridge = m.placeKind === 'bridge'
      // an explicit ref/face pair (bridge) or the block below (pillar)
      const ref = c.ref ? this.blockAt(c.ref) : this.blockAt({ x: c.x, y: c.y - 1, z: c.z })
      if (!ref) {
        this.bumpPlaceTries()
        return
      }
      const face = c.face || { x: 0, y: 1, z: 0 }
      const item = await equipForPlace(this.view, this.bot, c.block || null)
      if (!item) {
        this.emit('log', c.block ? `no ${c.block} left to place` : 'nothing in the inventory to place')
        this.noMaterial = true
        this.emit('noMaterial')
        this.bumpPlaceTries()
        return
      }
      if (bridge) {
        // stand still, sneak over the edge, click the ledge face sideways
        this.control('forward', false)
        this.control('sneak', true)
        this.lookAt(c.x, c.y, c.z, 0.5)
        await this.bot.placeBlock(ref, new this.Vec3(face.x, face.y, face.z))
        setTimeout(() => this.control('sneak', false), 250)
      } else {
        // pillar: jump first, place the block where our feet were
        const p0 = this.pos()
        this.control('jump', true)
        const rose = await this.waitUntil(() => {
          const p = this.pos()
          return p && p0 && p.y - p0.y >= 0.6
        }, 900)
        if (!rose) {
          this.control('jump', false)
          this.bumpPlaceTries()
          return
        }
        await this.bot.placeBlock(ref, new this.Vec3(face.x, face.y, face.z))
        this.control('jump', false)
      }
    } catch (e) {
      this.emit('log', 'place failed: ' + String(e.message || e).slice(0, 60))
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
      type: this.current() ? this.current().type : null
    }
  }
}

module.exports = { Executor, TICK_MS, STUCK_MS }
