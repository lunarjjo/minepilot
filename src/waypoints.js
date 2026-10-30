'use strict'

// the waypoint store — minepilot's port of baritone's waypoint system.
// a waypoint is { name, tag, x, y, z, time } where tag groups waypoints the
// way baritone's tags do: "home" (beds), "death" (where the bot died),
// "user" (saved by hand). #wp goal <name|tag> sets the goal; #home and
// #sethome are sugar over the "home" tag.

const fs = require('fs')
const path = require('path')

const NAME_RE = /^[A-Za-z0-9_\-]{1,32}$/
const TAG_RE = /^[a-z0-9_\-]{1,32}$/

class WaypointStore {
  constructor (file) {
    this.file = file || path.join(process.cwd(), 'waypoints.json')
    this.waypoints = [] // [{ name, tag, x, y, z, time }]
    this.load()
  }

  load () {
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        this.waypoints = parsed.filter((w) => w && NAME_RE.test(String(w.name)) &&
          Number.isFinite(w.x) && Number.isFinite(w.y) && Number.isFinite(w.z))
      }
    } catch (e) {
      this.waypoints = []
    }
    return this
  }

  save () {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.waypoints, null, 2))
      return { ok: true, count: this.waypoints.length }
    } catch (e) {
      return { ok: false, error: String(e.message || e) }
    }
  }

  saveWaypoint (tag, name, pos) {
    if (!TAG_RE.test(String(tag))) return { ok: false, error: `"${tag}" is not a tag` }
    if (!NAME_RE.test(String(name))) return { ok: false, error: `"${name}" is not a waypoint name` }
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) {
      return { ok: false, error: 'no position to save' }
    }
    const existing = this.waypoints.findIndex((w) => w.name === name)
    const wp = {
      name: String(name),
      tag: String(tag),
      x: Math.floor(pos.x),
      y: Math.floor(pos.y),
      z: Math.floor(pos.z),
      time: Date.now()
    }
    if (existing >= 0) this.waypoints[existing] = wp
    else this.waypoints.push(wp)
    return { ok: true, waypoint: wp }
  }

  // auto-waypoints: death and bed, the way baritone creates them
  death (pos) {
    return this.saveWaypoint('death', 'death_' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19), pos)
  }

  bed (pos) {
    return this.saveWaypoint('home', 'bed', pos)
  }

  byName (name) {
    return this.waypoints.find((w) => w.name === name) || null
  }

  byTag (tag) {
    return this.waypoints.filter((w) => w.tag === tag)
  }

  // resolve a #wp goal argument: an exact name, else a tag list, else null
  resolve (ref) {
    const byName = this.byName(ref)
    if (byName) return { kind: 'name', waypoint: byName, list: [byName] }
    const byTag = this.byTag(String(ref).toLowerCase())
    if (byTag.length > 0) return { kind: 'tag', waypoint: byTag[0], list: byTag }
    return null
  }

  delete (ref) {
    const r = this.resolve(ref)
    if (!r) return { ok: false, error: `no waypoint "${ref}"` }
    this.waypoints = this.waypoints.filter((w) => !r.list.includes(w))
    return { ok: true, deleted: r.list.length }
  }

  clear () {
    const n = this.waypoints.length
    this.waypoints = []
    return { ok: true, deleted: n }
  }

  list (tag) {
    if (!tag) return this.waypoints
    return this.byTag(tag)
  }

  describe (r) {
    return `${r.name} [${r.tag}] ${r.x} ${r.y} ${r.z}`
  }
}

module.exports = { WaypointStore, NAME_RE, TAG_RE }
