'use strict'

// blueprint parsing for the builder process — botfleet's take on the
// schematic input baritone feeds its BuilderProcess. a blueprint is a
// small json document describing a 3d volume of blocks relative to an
// origin chosen at build time. two equivalent shapes are accepted:
//
//   { "name": "slab",
//     "palette": { "D": "dirt" },
//     "layers": [ ["DDD", "DDD", "DDD"] ] }
//
//     layers[i]   = the i-th layer, bottom to top (y offset i)
//     layers[i][j] = row j of the layer, running north -> south (z)
//     character k  = column k of the row, running west -> east (x)
//     "." " " "_"  = this cell must end up air (clear whatever is there)
//
//   { "name": "post",
//     "blocks": [ { "x": 0, "y": 0, "z": 0, "block": "cobblestone" }, ... ] }
//
// parsing output is a plain list of placements in blueprint-local
// coordinates; the builder diffs them against the live world at build
// time, so a blueprint is reusable at any origin and in any world.

const NAME_RE = /^[a-z0-9_]+$/
const MAX_DIM = 64
const MAX_PLACEMENTS = 4096
const CLEAR_CHARS = new Set(['.', ' ', '_'])

function fail (error) {
  return { ok: false, error }
}

function fromLayers (json) {
  const palette = json.palette
  if (!palette || typeof palette !== 'object') return fail('layers form needs a palette object')
  const layers = json.layers
  if (!Array.isArray(layers) || layers.length === 0) return fail('layers must be a non-empty array')
  if (layers.length > MAX_DIM) return fail(`layers stack taller than ${MAX_DIM}`)

  const placements = []
  let width = -1
  let depth = -1
  for (let y = 0; y < layers.length; y++) {
    const rows = layers[y]
    if (!Array.isArray(rows) || rows.length === 0) return fail(`layer ${y} must be a non-empty array of rows`)
    if (depth === -1) depth = rows.length
    if (rows.length !== depth) return fail(`layer ${y} has ${rows.length} rows, expected ${depth}`)
    for (let z = 0; z < rows.length; z++) {
      const row = String(rows[z])
      if (width === -1) width = row.length
      if (row.length !== width) return fail(`layer ${y} row ${z} has ${row.length} columns, expected ${width}`)
      for (let x = 0; x < row.length; x++) {
        const ch = row[x]
        if (CLEAR_CHARS.has(ch)) {
          placements.push({ x, y, z, block: 'air' })
          continue
        }
        const block = palette[ch]
        if (typeof block !== 'string' || !NAME_RE.test(block)) {
          return fail(`layer ${y} row ${z}: palette has no valid block for "${ch}"`)
        }
        placements.push({ x, y, z, block })
      }
    }
  }
  if (width > MAX_DIM || depth > MAX_DIM) return fail(`footprint larger than ${MAX_DIM}x${MAX_DIM}`)
  return placements
}

function fromBlocks (json) {
  const blocks = json.blocks
  if (!Array.isArray(blocks) || blocks.length === 0) return fail('blocks must be a non-empty array')
  const placements = []
  for (const b of blocks) {
    if (!b || typeof b !== 'object') return fail('blocks entries must be objects')
    const x = Number(b.x)
    const y = Number(b.y)
    const z = Number(b.z)
    for (const v of [x, y, z]) {
      if (!Number.isInteger(v) || Math.abs(v) > MAX_DIM) return fail('block coordinates must be integers within +/-64')
    }
    if (typeof b.block !== 'string' || !(b.block === 'air' || NAME_RE.test(b.block))) {
      return fail(`block name "${b.block}" is not a valid block name`)
    }
    placements.push({ x, y, z, block: b.block })
  }
  return placements
}

// parseBlueprint(json) -> { ok, blueprint } | { ok: false, error }
// blueprint: { name, size: {x, y, z}, placements: [{x, y, z, block}] }
// where block === 'air' means "this cell must end up clear".
function parseBlueprint (json) {
  if (!json || typeof json !== 'object') return fail('blueprint must be a json object')
  const name = typeof json.name === 'string' && json.name.trim() !== ''
    ? json.name.trim().slice(0, 48)
    : 'unnamed'

  let result
  if (Array.isArray(json.layers)) result = fromLayers(json)
  else if (Array.isArray(json.blocks)) result = fromBlocks(json)
  else return fail('blueprint needs either "layers" or "blocks"')
  // the from* helpers return either a plain placements array or a
  // { ok: false, error } explanation
  if (!Array.isArray(result)) return result
  const placements = result
  if (placements.length > MAX_PLACEMENTS) return fail(`blueprint has ${placements.length} cells, cap is ${MAX_PLACEMENTS}`)
  if (placements.length === 0) return fail('blueprint has no cells')

  let minX = Infinity; let minY = Infinity; let minZ = Infinity
  let maxX = -Infinity; let maxY = -Infinity; let maxZ = -Infinity
  for (const p of placements) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.z < minZ) minZ = p.z
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
    if (p.z > maxZ) maxZ = p.z
  }

  return {
    ok: true,
    blueprint: {
      name,
      size: { x: maxX - minX + 1, y: maxY - minY + 1, z: maxZ - minZ + 1 },
      min: { x: minX, y: minY, z: minZ },
      placements
    }
  }
}

module.exports = { parseBlueprint, MAX_DIM, MAX_PLACEMENTS, CLEAR_CHARS }
