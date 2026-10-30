'use strict'

// the explore filter — minepilot's port of baritone's ExploreFilterCommand.
// a json file with a list of chunk coordinates restricts where the explore
// process will path: with "invert" the listed chunks are the ONLY places
// explored; without it, they are the places skipped.

const fs = require('fs')
const path = require('path')

const MAX_CHUNKS = 65536

// accepted shapes:
//   ["12,-3", "0,5"]                     — array of "x,z" strings
//   { "chunks": ["12,-3"] }
//   { "x": [12, 0], "z": [-3, 5] }       — paired arrays (same length)
function parseChunkList (json) {
  const out = []
  if (Array.isArray(json)) {
    for (const entry of json) {
      if (typeof entry !== 'string') return { ok: false, error: 'chunk list entries must be "x,z" strings' }
      const m = /^(-?\d+)\s*,\s*(-?\d+)$/.exec(entry.trim())
      if (!m) return { ok: false, error: `"${entry}" is not a chunk coordinate` }
      out.push([Number(m[1]), Number(m[2])])
    }
    return { ok: true, chunks: out }
  }
  if (json && typeof json === 'object') {
    if (Array.isArray(json.chunks)) {
      return parseChunkList(json.chunks)
    }
    if (Array.isArray(json.x) && Array.isArray(json.z)) {
      if (json.x.length !== json.z.length) return { ok: false, error: 'x and z arrays must be the same length' }
      for (let i = 0; i < json.x.length; i++) {
        const x = Number(json.x[i])
        const z = Number(json.z[i])
        if (!Number.isInteger(x) || !Number.isInteger(z)) return { ok: false, error: 'chunk coordinates must be integers' }
        out.push([x, z])
      }
      return { ok: true, chunks: out }
    }
  }
  return { ok: false, error: 'filter json needs a chunk list (array or {chunks})' }
}

function loadExplorefilter (file, invert) {
  const safe = String(file || '').replace(/[^A-Za-z0-9_\-./]/g, '')
  if (!safe) return { ok: false, error: 'no filter file' }
  const candidates = [
    path.join(process.cwd(), 'schematics', safe),
    path.join(process.cwd(), safe),
    path.join(__dirname, '..', '..', 'schematics', safe)
  ]
  let json = null
  for (const p of candidates) {
    try {
      json = JSON.parse(fs.readFileSync(p, 'utf8'))
      break
    } catch (e) { /* keep looking */ }
  }
  if (json === null) return { ok: false, error: `no filter file "${safe}" (looked in ./schematics and .)` }
  const parsed = parseChunkList(json)
  if (!parsed.ok) return parsed
  if (parsed.chunks.length > MAX_CHUNKS) {
    return { ok: false, error: `filter has ${parsed.chunks.length} chunks, cap is ${MAX_CHUNKS}` }
  }
  const set = new Set(parsed.chunks.map(([x, z]) => x + ',' + z))
  // filter(cx, cz): true when the chunk is ALLOWED as an explore target
  const filter = (cx, cz) => {
    const listed = set.has(cx + ',' + cz)
    return invert ? listed : !listed
  }
  return { ok: true, count: parsed.chunks.length, invert: !!invert, filter, chunks: parsed.chunks }
}

module.exports = { loadExplorefilter, parseChunkList }
