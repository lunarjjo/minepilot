'use strict'

// elytra flight — minepilot's port of baritone's ElytraProcess.
// full trajectory-search flight lands with the elytra phase; the command
// entry point and honest interim reply live here now so the grammar,
// the console and the web UI all have a stable target.

function commandElytra (pilot, x, y, z) {
  void pilot
  void x
  void y
  void z
  return {
    ok: false,
    error: 'elytra flight lands in the elytra phase (next pushes) — the command, grammar and UI wiring are ready'
  }
}

module.exports = { commandElytra }
