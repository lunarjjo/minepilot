'use strict'

// the selection manager — minepilot's port of baritone's selection system
// (ISelectionManager + SelCommand). a selection is a cuboid between pos1
// and pos2. sel actions mutate it; shape actions (fill, walls, shell,
// sphere, cylinder, cleararea, replace) turn it into a build job; copy
// snapshots the world volume into a reusable blueprint, paste builds it.
//
// every mutation pushes onto an undo stack (baritone's #sel undo).

const DIRS = {
  north: { x: 0, y: 0, z: -1 },
  south: { x: 0, y: 0, z: 1 },
  east: { x: 1, y: 0, z: 0 },
  west: { x: -1, y: 0, z: 0 },
  up: { x: 0, y: 1, z: 0 },
  down: { x: 0, y: -1, z: 0 }
}

function normCuboid (a, b) {
  return {
    minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x),
    minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y),
    minZ: Math.min(a.z, b.z), maxZ: Math.max(a.z, b.z)
  }
}

function cellsOf (c) {
  const out = []
  for (let x = c.minX; x <= c.maxX; x++) {
    for (let y = c.minY; y <= c.maxY; y++) {
      for (let z = c.minZ; z <= c.maxZ; z++) out.push({ x, y, z })
    }
  }
  return out
}

class SelectionManager {
  constructor () {
    this.pos1 = null
    this.pos2 = null
    this.undoStack = []
    this.clipboard = null // { placements, size, min } blueprint of a copy
  }

  snapshot () {
    return { pos1: this.pos1, pos2: this.pos2 }
  }

  pushUndo () {
    this.undoStack.push(this.snapshot())
    if (this.undoStack.length > 32) this.undoStack.shift()
  }

  undo () {
    const prev = this.undoStack.pop()
    if (!prev) return { ok: false, error: 'nothing to undo' }
    this.pos1 = prev.pos1
    this.pos2 = prev.pos2
    return { ok: true, selection: this.snapshot() }
  }

  setPos1 (p) {
    this.pushUndo()
    this.pos1 = p
    return { ok: true, pos: 'pos1', at: p }
  }

  setPos2 (p) {
    this.pushUndo()
    this.pos2 = p
    return { ok: true, pos: 'pos2', at: p }
  }

  clear () {
    this.pushUndo()
    this.pos1 = null
    this.pos2 = null
    return { ok: true }
  }

  hasSelection () {
    return !!(this.pos1 && this.pos2)
  }

  cuboid () {
    if (!this.hasSelection()) return null
    return normCuboid(this.pos1, this.pos2)
  }

  volume () {
    const c = this.cuboid()
    if (!c) return 0
    return (c.maxX - c.minX + 1) * (c.maxY - c.minY + 1) * (c.maxZ - c.minZ + 1)
  }

  // expand / contract / shift with a direction (or all six at once)
  transform (kind, n, dir) {
    const c = this.cuboid()
    if (!c) return { ok: false, error: 'no selection — set pos1 and pos2 first' }
    this.pushUndo()
    const p1 = { x: this.pos1.x, y: this.pos1.y, z: this.pos1.z }
    const p2 = { x: this.pos2.x, y: this.pos2.y, z: this.pos2.z }
    const move = (p, d, sign) => {
      p.x += d.x * sign
      p.y += d.y * sign
      p.z += d.z * sign
    }
    if (dir === 'all') {
      for (const d of Object.values(DIRS)) {
        // grow both ends outward / shrink both ends inward
        if (kind === 'expand') {
          move(p1, d, -n)
          move(p2, d, n)
        } else if (kind === 'contract') {
          move(p1, d, n)
          move(p2, d, -n)
        }
      }
      if (kind === 'shift') {
        // shift all: pick a canonical direction set (up)
        move(p1, DIRS.up, n)
        move(p2, DIRS.up, n)
      }
    } else {
      const d = DIRS[dir]
      if (!d) return { ok: false, error: `"${dir}" is not a direction` }
      if (kind === 'shift') {
        move(p1, d, n)
        move(p2, d, n)
      } else {
        // expand toward / contract from the direction: grow both corners
        // along the axis the direction points (baritone semantics)
        const axis = d.x !== 0 ? 'x' : (d.y !== 0 ? 'y' : 'z')
        const sign = d[axis]
        if (kind === 'expand') {
          if (sign > 0) p2[axis] += n
          else p1[axis] -= n
        } else {
          if (sign > 0) p2[axis] -= n
          else p1[axis] += n
        }
      }
    }
    this.pos1 = p1
    this.pos2 = p2
    return { ok: true, selection: this.snapshot(), volume: this.volume() }
  }

  // ---- shape blueprints (become builder jobs) --------------------------

  // fill the whole cuboid with a block
  fillBlueprint (block) {
    const c = this.cuboid()
    if (!c) return { ok: false, error: 'no selection' }
    const placements = cellsOf(c).map((cell) => ({ ...cell, block }))
    return { ok: true, blueprint: { name: `fill_${block}`, placements, min: { x: c.minX, y: c.minY, z: c.minZ } } }
  }

  // walls only (the four vertical faces)
  wallsBlueprint (block) {
    const c = this.cuboid()
    if (!c) return { ok: false, error: 'no selection' }
    const placements = []
    for (let x = c.minX; x <= c.maxX; x++) {
      for (let y = c.minY; y <= c.maxY; y++) {
        for (let z = c.minZ; z <= c.maxZ; z++) {
          const onWall = x === c.minX || x === c.maxX || z === c.minZ || z === c.maxZ
          if (onWall) placements.push({ x, y, z, block })
        }
      }
    }
    return { ok: true, blueprint: { name: `walls_${block}`, placements } }
  }

  // walls + floor + ceiling
  shellBlueprint (block) {
    const c = this.cuboid()
    if (!c) return { ok: false, error: 'no selection' }
    const placements = []
    for (let x = c.minX; x <= c.maxX; x++) {
      for (let y = c.minY; y <= c.maxY; y++) {
        for (let z = c.minZ; z <= c.maxZ; z++) {
          const onShell = x === c.minX || x === c.maxX || z === c.minZ || z === c.maxZ ||
            y === c.minY || y === c.maxY
          if (onShell) placements.push({ x, y, z, block })
        }
      }
    }
    return { ok: true, blueprint: { name: `shell_${block}`, placements } }
  }

  // sphere / cylinder centered on the selection center (baritone places
  // these from the selection's center, radius default = selection x radius)
  sphereBlueprint (block, radius, hollow) {
    const c = this.cuboid()
    if (!c) return { ok: false, error: 'no selection' }
    const r = radius || Math.max(1, Math.floor((c.maxX - c.minX) / 2))
    const cx = Math.floor((c.minX + c.maxX) / 2)
    const cy = Math.floor((c.minY + c.maxY) / 2)
    const cz = Math.floor((c.minZ + c.maxZ) / 2)
    const placements = []
    const r2 = r * r
    const inner2 = hollow ? (r - 1) * (r - 1) : -1
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dz = -r; dz <= r; dz++) {
          const d2 = dx * dx + dy * dy + dz * dz
          if (d2 > r2) continue
          if (hollow && d2 < inner2) continue
          placements.push({ x: cx + dx, y: cy + dy, z: cz + dz, block })
        }
      }
    }
    return { ok: true, blueprint: { name: `${hollow ? 'h' : ''}sphere_${block}`, placements } }
  }

  cylinderBlueprint (block, radius, height, hollow) {
    const c = this.cuboid()
    if (!c) return { ok: false, error: 'no selection' }
    const r = radius || Math.max(1, Math.floor((c.maxX - c.minX) / 2))
    const h = height || Math.max(1, c.maxY - c.minY + 1)
    const cx = Math.floor((c.minX + c.maxX) / 2)
    const cy = c.minY
    const cz = Math.floor((c.minZ + c.maxZ) / 2)
    const placements = []
    const r2 = r * r
    const inner2 = hollow ? (r - 1) * (r - 1) : -1
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        const d2 = dx * dx + dz * dz
        if (d2 > r2) continue
        if (hollow && d2 < inner2) continue
        for (let dy = 0; dy < h; dy++) {
          placements.push({ x: cx + dx, y: cy + dy, z: cz + dz, block })
        }
      }
    }
    return { ok: true, blueprint: { name: `${hollow ? 'h' : ''}cylinder_${block}`, placements } }
  }

  // clear everything to air — the fill blueprint with air
  clearAreaBlueprint () {
    return this.fillBlueprint('air')
  }

  // copy the world volume into a blueprint (paste builds it elsewhere)
  copy (view) {
    const c = this.cuboid()
    if (!c) return { ok: false, error: 'no selection' }
    const placements = []
    for (const cell of cellsOf(c)) {
      const name = view.name(cell.x, cell.y, cell.z)
      placements.push({ x: cell.x - c.minX, y: cell.y - c.minY, z: cell.z - c.minZ, block: name || 'air' })
    }
    this.clipboard = {
      name: 'clipboard',
      placements,
      size: {
        x: c.maxX - c.minX + 1,
        y: c.maxY - c.minY + 1,
        z: c.maxZ - c.minZ + 1
      }
    }
    return { ok: true, cells: placements.length, size: this.clipboard.size }
  }
}

module.exports = { SelectionManager, normCuboid, cellsOf, DIRS }
