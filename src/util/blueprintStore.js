'use strict'

// blueprint lookup for the build command. a blueprint is a json file
// named <name>.json, searched in ./blueprints relative to the working
// directory first (user fleets can carry their own library), then in
// the repo's bundled blueprints/ directory. parse errors surface as
// honest strings, never throws.

const fs = require('fs')
const path = require('path')
const { parseBlueprint } = require('./blueprints')

function loadBlueprint (name) {
  const safe = String(name || '').toLowerCase()
  const candidates = [
    path.join(process.cwd(), 'blueprints', safe + '.json'),
    path.join(__dirname, '..', '..', 'blueprints', safe + '.json')
  ]
  let lastError = null
  for (const p of candidates) {
    let raw
    try {
      raw = fs.readFileSync(p, 'utf8')
    } catch (e) {
      continue
    }
    let json
    try {
      json = JSON.parse(raw)
    } catch (e) {
      lastError = `invalid json: ${String(e.message).slice(0, 60)}`
      continue
    }
    const parsed = parseBlueprint(json)
    if (parsed.ok) return parsed
    lastError = parsed.error
  }
  if (lastError) return { ok: false, error: `${safe}: ${lastError}` }
  return { ok: false, error: `no blueprint named "${safe}" (looked in ./blueprints and the bundled library)` }
}

module.exports = { loadBlueprint }
