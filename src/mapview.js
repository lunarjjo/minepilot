'use strict'

// the map view — server-side terrain snapshot for the web console.
// for every column in every loaded chunk, the topmost non-air block and
// its y level; the color comes from the shared block palette so the client
// never needs block knowledge. chunk payloads are cached and invalidated
// per column on block updates; the console asks for a viewport and gets
// only what it can see.

const { blockColor, isAirLike } = require('./util/blocks')

const COLS = 16
const MAX_SCAN_Y = 319
const MIN_SCAN_Y = -64

class MapView {
  constructor (bot, settings) {
    this.bot = bot
    this.settings = settings
    this.cache = new Map() // 'cx,cz' -> { cols: [ [name, y] * 256 ] }
    this.dirties = new Set() // column keys changed since the last viewport push
    this.wire()
  }

  wire () {
    const onUpdate = (oldBlock, newBlock) => {
      try {
        const b = newBlock || oldBlock
        if (!b || !b.position) return
        const x = Math.floor(b.position.x)
        const z = Math.floor(b.position.z)
        this.invalidateColumn(x, z)
      } catch (e) { /* ignore */ }
    }
    if (this.bot.on) {
      this.bot.on('blockUpdate', onUpdate)
      this.bot.on('blockUpdate:(*,' + this.bot.username + ')', () => { /* spammy variant ignored */ })
    }
  }

  key (cx, cz) {
    return cx + ',' + cz
  }

  invalidateColumn (x, z) {
    const cx = Math.floor(x / COLS)
    const cz = Math.floor(z / COLS)
    const k = this.key(cx, cz)
    if (this.cache.has(k)) {
      // recompute just this column lazily: drop the whole chunk from cache
      // (single-column updates are rare and chunk scans are cheap)
      this.cache.delete(k)
      this.dirties.add(k)
    }
  }

  dispose () {
    if (this.bot.removeListener) {
      try { this.bot.removeAllListeners('blockUpdate') } catch (e) { /* ignore */ }
    }
    this.cache.clear()
  }

  // the topmost non-air block of one column, scanning down from a hint
  topOf (x, z, hintY) {
    const start = Math.max(MIN_SCAN_Y, Math.min(MAX_SCAN_Y, Math.floor(hintY)))
    let top = null
    for (let y = start; y >= MIN_SCAN_Y; y--) {
      let b = null
      try { b = this.bot.blockAt ? this.bot.blockAt(new (require('vec3'))(x, y, z)) : null } catch (e) { b = null }
      if (!b) break // fog: stop at the first unknown cell
      if (!isAirLike(b.name)) {
        top = { name: b.name, y }
        break
      }
    }
    return top
  }

  // scan one chunk into a compact payload
  chunkData (cx, cz) {
    const k = this.key(cx, cz)
    let cached = this.cache.get(k)
    if (cached) return cached
    const botY = this.bot.entity && this.bot.entity.position
      ? this.bot.entity.position.y + 32
      : 96
    const cols = new Array(COLS * COLS)
    for (let lx = 0; lx < COLS; lx++) {
      for (let lz = 0; lz < COLS; lz++) {
        const x = cx * COLS + lx
        const z = cz * COLS + lz
        const top = this.topOf(x, z, botY)
        const idx = lz * COLS + lx
        cols[idx] = top ? [top.name, top.y] : null
      }
    }
    cached = { cx, cz, cols }
    this.cache.set(k, cached)
    return cached
  }

  // a serializable chunk payload for the wire (color included)
  chunkPayload (cx, cz) {
    const data = this.chunkData(cx, cz)
    const cols = []
    for (let i = 0; i < data.cols.length; i++) {
      const c = data.cols[i]
      cols.push(c ? { c: blockColor(c[0]), y: c[1], n: c[0] } : null)
    }
    return { cx, cz, cols }
  }

  // everything in a viewport rectangle (bounded, loaded chunks only)
  viewport (cx0, cz0, cx1, cz1) {
    const out = []
    const maxChunks = 4096 // hard cap: a console zoomed way out
    const w = Math.abs(cx1 - cx0) + 1
    const h = Math.abs(cz1 - cz0) + 1
    if (w * h > maxChunks) return out
    for (let cx = Math.min(cx0, cx1); cx <= Math.max(cx0, cx1); cx++) {
      for (let cz = Math.min(cz0, cz1); cz <= Math.max(cz0, cz1); cz++) {
        // only loaded chunks: probe one corner cell
        const probe = this.topOf(cx * COLS, cz * COLS, this.bot.entity ? this.bot.entity.position.y : 96)
        if (probe === null) {
          // corner may be air all the way down in a void-ish world; probe
          // the chunk presence via blockAt directly
          let known = false
          try {
            known = !!this.bot.blockAt(new (require('vec3'))(cx * COLS, 0, cz * COLS)) ||
              !!this.bot.blockAt(new (require('vec3'))(cx * COLS, 64, cz * COLS))
          } catch (e) { known = false }
          if (!known) continue
        }
        out.push(this.chunkPayload(cx, cz))
      }
    }
    return out
  }

  // changed chunks since the last drain (for live updates)
  drainDirty () {
    const out = [...this.dirties]
    this.dirties.clear()
    return out
  }

  stats () {
    return { chunks: this.cache.size, dirty: this.dirties.size }
  }
}

module.exports = { MapView, COLS }
