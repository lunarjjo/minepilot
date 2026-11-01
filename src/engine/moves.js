'use strict'

// movement generation — the heart of the pathfinder, in the spirit of
// baritone's Movement classes. from a standing position, enumerate every
// legal minecraft movement with its true-ish cost:
//
//   traverse   walk one cardinal block flat (cost 1)
//   diagonal   45 degree step, both corners clear (cost sqrt2)
//   ascend     step up one block with a jump (cost 2)
//   ascendPlace  step up onto a block we place ourselves (staircase up)
//   descend    walk off a one block ledge (cost 0.8, baritone's
//              WALK_OFF_BLOCK_COST — walking off an edge is faster)
//   fall       drop n blocks into a safe landing (cost 1 + 0.1n)
//   swim       traverse through water (cost 2.2)
//   climb      go up/down a ladder or vine column (cost 1.2)
//   parkour    sprint-jump a one block gap (cost 2.5, opt-in)
//   pillar     jump and place a block under yourself (needs blocks)
//   bridge     place a block ahead over a bottomless gap — or a drop too
//              deep to survive — and walk it (staircase down)
//
// any solid block in the way may be broken through when allowBreak is on:
// its cost is the dig time with the BEST TOOL THE BOT CARRIES (baritone
// plans with tool multipliers; a pickaxe turns 7.5s of hand-mining into
// under a second, and a planner that pretends otherwise routes around
// stone it should simply dig through). hardness >= 1 is "needs a tool"
// -> *5 without one, minecraft's formula. unknown / unloaded space is a
// wall: the fleet never paths into the fog.

const { materialClass } = require('../autotool')

const SQRT2 = Math.SQRT2

const CARDINALS = [
  { dx: 0, dz: -1, n: 'north' },
  { dx: 1, dz: 0, n: 'east' },
  { dx: 0, dz: 1, n: 'south' },
  { dx: -1, dz: 0, n: 'west' }
]

const DIAGONALS = [
  { dx: 1, dz: -1 },
  { dx: 1, dz: 1 },
  { dx: -1, dz: 1 },
  { dx: -1, dz: -1 }
]

const DEFAULTS = {
  allowBreak: true, // dig through breakable blocks when it is worth it
  allowPlace: true, // pillar up / bridge over gaps using inventory blocks
  allowParkour: false, // sprint-jump one block gaps
  allowParkourAscend: false, // parkour jumps that gain height
  allowPillar: true, // pillar straight up by placing blocks (verified live-anchor placement made this safe)
  allowWater: true, // swimming is legal
  allowFallDamage: false, // never take fall damage by default
  allowSprint: true, // sprint while walking
  allowDiagonalAscend: true, // 45 degree ascents
  allowDiagonalDescend: true, // 45 degree descents
  allowSprintJump: true, // bunny-hop while sprinting flat straights (the baritone speed trick)
  autoTool: true, // the executor equips the best carried tool before each dig
  maxDigDown: 8, // deepest straight-down shaft the planner will offer (digFall)
  maxFallNoDamage: 3, // vanilla: 4+ blocks starts hurting
  maxFallWithDamage: 8, // even when allowed, do not gamble everything
  maxWaterLanding: 20, // deep water landings are fine up to this
  walkCost: 1,
  swimCost: 2.2,
  climbCost: 1.2,
  descendCost: 0.8, // baritone WALK_OFF_BLOCK_COST = walk * 0.8
  ascendCost: 2,
  parkourCost: 2.5,
  fallCostPerBlock: 0.1,
  fallDamageCost: 0.5, // per half heart of expected damage
  walkBlocksPerSecond: 5.6, // converts dig seconds into cost units (sprint pace)
  blockBreakAdditionalPenalty: 2, // flat penalty per dig (baritone default)
  blockPlacementPenalty: 4, // flat penalty per placement (baritone 20; minepilot bridges slower, tuned down)
  jumpPenalty: 0, // ascendCost already prices the jump; extra hunger penalty only if you ask
  toolMults: null // { pickaxe: 6, axe: 6, shovel: 6, hoe: 1 } — computed by the autopilot from the live inventory
}

// the tool speed multiplier a block's material class gets, given the
// mults the autopilot computed from the live inventory (or 1: bare hands)
function toolMultFor (name, settings) {
  if (!name || !settings || !settings.toolMults) return 1
  const cls = materialClass(name)
  if (!cls || !settings.toolMults[cls]) return 1
  return settings.toolMults[cls]
}

// hand dig time (seconds) for a hardness value. approximate: harvestable
// with bare hands (dirt-like) uses *1.5, tool-gated (stone-like) uses *5,
// and a carried tool of the right class divides by its multiplier — the
// way baritone prices digs with the player's actual tools.
function digSeconds (hardness, toolMult) {
  if (hardness < 0) return Infinity
  const mult = toolMult && toolMult > 1 ? toolMult : 1
  return hardness >= 1 ? hardness * 5 / mult : hardness * 1.5 / mult
}

function digCost (b, settings) {
  const hardness = typeof b === 'number' ? b : b.hardness
  const mult = typeof b === 'object' && b ? toolMultFor(b.name, settings) : 1
  let cost = digSeconds(hardness, mult) * settings.walkBlocksPerSecond +
    (settings.blockBreakAdditionalPenalty || 0)
  if (b && typeof b === 'object' && b.avoided) {
    cost += hardness * (b.avoidMultiplier || 0) * settings.walkBlocksPerSecond
  }
  return cost
}

// the blocks a movement must break to clear the way, or null if impossible.
function breakables (view, cells, settings) {
  const out = []
  for (const c of cells) {
    if (view.passable(c.x, c.y, c.z)) continue
    if (!settings.allowBreak) return null
    const info = view.breakInfo(c.x, c.y, c.z)
    if (!info || !info.breakable) return null
    if (info.hardness > 50) return null // obsidian-class: pretend impossible
    out.push({
      x: c.x, y: c.y, z: c.z, hardness: info.hardness, name: info.name,
      avoided: !!info.avoided, avoidMultiplier: info.avoidMultiplier || 0
    })
  }
  return out
}

function movement (type, from, to, cost, toBreak, extra) {
  const m = { type, from, to, cost, toBreak: toBreak || [] }
  if (extra) Object.assign(m, extra)
  // a move that places a block CREATES the support its destination stands
  // on. the search marks that on the destination node so the next movement
  // generated from there knows the floor is real — without this, chained
  // bridges were unplannable (the world does not contain the block yet)
  // and the executor had to replan after every single placement.
  if (m.toPlace && m.toPlace.length) m.to.placedSupport = true
  return m
}

// scan down a column for what the feet would find: the first standable
// cell, a deep-enough water surface, or a climbable block. returns
// { y, kind } where kind is 'solid' | 'water' | 'ladder', or null.
function landing (view, x, yTop, z, settings) {
  let waterTop = null
  let waterDepth = 0
  for (let y = yTop; y > yTop - settings.maxWaterLanding - 4; y--) {
    if (view.lava(x, y, z)) return null // never land in lava
    if (view.water(x, y, z)) {
      if (waterTop === null) waterTop = y
      waterDepth++
      // two stacked water blocks cushion any fall minecraft cares about
      if (waterDepth >= 2) return { y: waterTop, kind: 'water', waterTop }
      continue
    }
    if (view.standable(x, y, z)) {
      // shallow water over solid: land on the solid, through the water
      return { y: y + 1, kind: 'solid', waterTop }
    }
    if (view.climbable(x, y, z)) return { y, kind: 'ladder' }
  }
  return null
}

function generate (view, node, settings) {
  const out = []
  const s = settings
  const x = node.x
  const y = node.y
  const z = node.z
  const inWater = view.water(x, y, z)
  const onLadder = view.climbable(x, y, z)
  // nodes reached by a placement stand on a block that exists only in the
  // plan — treat it as solid ground for chaining (the executor places it
  // for real before ever stepping there)
  const supportedHere = view.solid(x, y - 1, z) || node.placedSupport === true

  // standing inside a ladder/vine column: straight up and down
  if (onLadder) {
    if (view.climbable(x, y + 1, z) || view.passable(x, y + 1, z)) {
      out.push(movement('climb', node, { x, y: y + 1, z }, s.climbCost))
    }
    if (view.climbable(x, y - 1, z) || view.passable(x, y - 1, z)) {
      out.push(movement('climb', node, { x, y: y - 1, z }, s.climbCost * 0.8))
    }
  }

  // dig straight down (baritone's digdown): break the column beneath the
  // feet one block at a time — the body drops one per break, so there is
  // never a real fall and never fall damage. this is how a height-aware
  // bot reaches goals BELOW it through diggable ground (caves, ravines,
  // mineshafts) instead of walking off edges and hoping. air, water or
  // lava in the column stops the shaft: only solid breakable ground is
  // dug, and the floor under the chosen depth must be standable.
  if (s.allowBreak && !inWater && !onLadder) {
    const cells = []
    let digCosts = 0
    for (let d = 1; d <= (s.maxDigDown || 8); d++) {
      if (!view.solid(x, y - d, z)) break // air/liquid/fog: the shaft ends here
      const info = view.breakInfo(x, y - d, z)
      if (!info || !info.breakable || info.hardness < 0) break // bedrock stops it too
      cells.push({ x, y: y - d, z, hardness: info.hardness, name: info.name,
        avoided: !!info.avoided, avoidMultiplier: info.avoidMultiplier || 0 })
      digCosts += digCost(cells[cells.length - 1], s)
      // the shaft needs a floor to land on at depth d
      if (view.standable(x, y - d - 1, z)) {
        const cost = s.walkCost + d * 0.5 + digCosts
        out.push(movement('digFall', node, { x, y: y - d, z }, cost, cells.slice()))
      }
    }
  }

  for (const d of CARDINALS) {
    const nx = x + d.dx
    const nz = z + d.dz

    // ladder in the wall ahead: enter and go up
    if (view.climbable(nx, y, nz) && !view.standable(nx, y - 1, nz)) {
      if (view.climbable(nx, y + 1, nz) || view.passable(nx, y + 1, nz)) {
        out.push(movement('climb', node, { x: nx, y: y + 1, z: nz }, s.climbCost))
        continue
      }
    }

    // same-level swim: the destination feet cell is water — either we are
    // floating on the surface already, or the bank happens to sit level
    // with the water. no support needed: the bot floats.
    if (s.allowWater && view.water(nx, y, nz)) {
      const toBreak = breakables(view, [{ x: nx, y, z: nz }, { x: nx, y: y + 1, z: nz }], s)
      if (toBreak) {
        let cost = s.swimCost
        for (const b of toBreak) cost += digCost(b, s)
        out.push(movement('swim', node, { x: nx, y, z: nz }, cost, toBreak))
      }
    }

    // while afloat we never dive: no descend/fall/landing moves from a
    // water node — only swimming at the surface, and climbing out
    if (!inWater) {
      // level support ahead: traverse, descend one, or fall n
      const land = landing(view, nx, y - 1, nz, s)
      if (land && land.kind === 'solid') {
      const drop = y - land.y
      if (drop === 0) {
        const toBreak = breakables(view, [{ x: nx, y, z: nz }, { x: nx, y: y + 1, z: nz }], s)
        if (toBreak) {
          const swim = view.water(nx, y, nz)
          if (!swim) {
            let cost = s.walkCost
            for (const b of toBreak) cost += digCost(b, s)
            out.push(movement('traverse', node, { x: nx, y, z: nz }, cost, toBreak))
          }
        }
      } else if (drop === 1) {
        const toBreak = breakables(view, [{ x: nx, y: y - 1, z: nz }, { x: nx, y, z: nz }], s)
        if (toBreak) {
          out.push(movement('descend', node, { x: nx, y: y - 1, z: nz }, s.descendCost || s.walkCost * 0.8, toBreak))
        }
      } else {
        // fall n: the column above the landing must be clear
        const cells = []
        for (let yy = land.y + 1; yy <= y; yy++) cells.push({ x: nx, y: yy, z: nz })
        cells.push({ x: nx, y: y + 1, z: nz })
        const toBreak = breakables(view, cells, s)
        if (toBreak) {
          const damage = Math.max(0, drop - s.maxFallNoDamage)
          if (damage === 0 || s.allowFallDamage) {
            if (damage === 0 || drop <= s.maxFallWithDamage) {
              const cost = s.walkCost + drop * s.fallCostPerBlock +
                damage * s.fallDamageCost
              out.push(movement('fall', node, { x: nx, y: land.y, z: nz }, cost, toBreak))
            }
          }
        }
      }
    }

    // deep water ahead: any drop onto a 2+ deep surface is safe
    if (land && land.kind === 'water') {
      const drop = y - land.y
      if (drop >= 1 && drop <= s.maxWaterLanding) {
        const cells = []
        for (let yy = land.y + 1; yy <= y; yy++) cells.push({ x: nx, y: yy, z: nz })
        cells.push({ x: nx, y: y + 1, z: nz })
        const toBreak = breakables(view, cells, s)
        if (toBreak) {
          const cost = s.walkCost + drop * s.fallCostPerBlock
          out.push(movement('fall', node, { x: nx, y: land.y, z: nz }, cost, toBreak, { water: true }))
        }
      }
    }

    // a ladder in the column ahead: step onto it and start climbing
    if (land && land.kind === 'ladder') {
      if (view.climbable(nx, land.y + 1, nz) || view.passable(nx, land.y + 1, nz)) {
        out.push(movement('climb', node, { x: nx, y: land.y + 1, z: nz }, s.climbCost))
      }
    }

    // bridge: place a block at foot level ahead, anchored on the side
    // face of the block we are standing on, and walk it. two triggers:
    //   1. the gap ahead has no bottom within scan range (void, fog, or
    //      lava underneath) — baritone does exactly this across breaks
    //      in terrain;
    //   2. the drop IS survivable-scanned but deeper than the no-damage
    //      budget — staircasing down one block at a time is the safe way
    //      down a cliff, and the only alternative is tunneling sideways.
    const deepDrop = land && land.kind === 'solid' &&
      (y - land.y) > (s.maxFallNoDamage || 3) && !s.allowFallDamage
    if (s.allowPlace && (!land || deepDrop)) {
      const feetClear = view.passable(nx, y, nz) && view.passable(nx, y + 1, nz)
      if (feetClear && supportedHere) {
        out.push(movement('bridge', node, { x: nx, y, z: nz },
          s.walkCost + s.ascendCost * 2 + 0.4 + (s.blockPlacementPenalty || 0), [], {
          toPlace: [{
            x: nx, y: y - 1, z: nz,
            ref: { x, y: y - 1, z },
            face: { x: d.dx, y: 0, z: d.dz }
          }],
          placeKind: 'bridge'
        }))
      }
    }
    } // end of the !inWater block

    // support one higher: ascend (step up with a jump) — also the way
    // out of the water onto a bank at the same level as the surface
    if (view.standable(nx, y, nz)) {
      const toBreak = breakables(view, [
        { x: nx, y: y + 1, z: nz },
        { x: nx, y: y + 2, z: nz },
        { x, y: y + 2, z }
      ], s)
      if (toBreak) {
        const feet = view.water(nx, y + 1, nz)
        if (!feet || s.allowWater) {
          let cost = s.ascendCost + (s.jumpPenalty || 0)
          for (const b of toBreak) cost += digCost(b, s)
          out.push(movement(feet ? 'swim' : 'ascend', node, { x: nx, y: y + 1, z: nz }, cost, toBreak))
        }
      }
    } else if (s.allowPlace && view.passable(nx, y, nz)) {
      // ascend with placement — the staircase up. no support at (nx, y)
      // (a ledge, a cliff edge, a one-wide gap in the climb): place a
      // block there ourselves, then step up onto it. two guards keep it
      // from hijacking gap crossings (the sky-staircase bug): there must
      // be a SOLID face-adjacent anchor to place against, and it costs
      // double the placement penalty — it is a recovery move for broken
      // terrain, never a cheaper alternative to bridging.
      const anchorSides = [
        { x: nx, y: y - 1, z: nz }, // below: a shelf under the gap (the common case)
        { x: nx + 1, y, z: nz }, { x: nx - 1, y, z: nz },
        { x: nx, y, z: nz + 1 }, { x: nx, y, z: nz - 1 }
      ]
      const anchorExists = anchorSides.some((c) => view.solid(c.x, c.y, c.z))
      if (anchorExists) {
        const toBreak = breakables(view, [
          { x: nx, y: y + 1, z: nz },
          { x: nx, y: y + 2, z: nz },
          { x, y: y + 2, z }
        ], s)
        if (toBreak) {
          let cost = s.ascendCost + 0.4 + (s.blockPlacementPenalty || 0) * 2 + (s.jumpPenalty || 0)
          for (const b of toBreak) cost += digCost(b, s)
          out.push(movement('ascendPlace', node, { x: nx, y: y + 1, z: nz }, cost, toBreak, {
            toPlace: [{ x: nx, y, z: nz }],
            placeKind: 'ascend'
          }))
        }
      }
    }

    // parkour: sprint-jump a one block gap at the same height
    if (s.allowParkour) {
      const gx = x + d.dx * 2
      const gz = z + d.dz * 2
      const gapFeet = view.passable(nx, y, nz)
      const gapBelow = !view.standable(nx, y - 1, nz) && !view.water(nx, y - 1, nz)
      const destClear = view.passable(gx, y, gz) && view.passable(gx, y + 1, gz)
      const destSupport = view.standable(gx, y - 1, gz)
      const headroom = view.passable(x, y + 2, z) && view.passable(nx, y + 2, nz)
      if (gapFeet && gapBelow && destClear && destSupport && headroom) {
        out.push(movement('parkour', node, { x: gx, y, z: gz }, s.parkourCost))
      }
    }

    // pillar: jump and place a block beneath yourself (needs inventory).
    // opt-in via allowPillar — see settings.js for the why.
    if (s.allowPlace && s.allowPillar && !inWater && !onLadder) {
      const clear = view.passable(x, y + 1, z) && view.passable(x, y + 2, z)
      if (clear) {
        out.push(movement('pillar', node, { x, y: y + 1, z },
          s.ascendCost + 0.4 + (s.jumpPenalty || 0) + (s.blockPlacementPenalty || 0), [], {
          toPlace: [{ x, y, z }]
        }))
      }
    }
  }

  // diagonals: 45 degrees, same level or one lower, both corners clear
  if (!onLadder) {
    for (const d of DIAGONALS) {
      const nx = x + d.dx
      const nz = z + d.dz
      const corners = [
        { x: nx, y, z }, { x: nx, y: y + 1, z },
        { x, y, z: nz }, { x, y: y + 1, z: nz }
      ]
      const cornerBreak = breakables(view, corners, s)
      if (!cornerBreak) continue
      const toBreak = cornerBreak

      // surface diagonal swim: afloat crossing, or a level bank-to-water cut
      if (s.allowWater && view.water(nx, y, nz)) {
        const feetBreak = breakables(view, [{ x: nx, y, z: nz }, { x: nx, y: y + 1, z: nz }], s)
        if (feetBreak) {
          for (const b of feetBreak) toBreak.push(b)
          let cost = s.swimCost * SQRT2
          for (const b of toBreak) cost += digCost(b, s)
          out.push(movement('swim', node, { x: nx, y, z: nz }, cost, toBreak))
        }
        continue
      }
      if (inWater) continue // afloat: no underwater walk diagonals

      // 45 degree ascent FIRST: support exists at (nx, y) → destination
      // (nx, y + 1). clearing the cells above the step (never the support
      // itself) is what makes smooth slopes climbable instead of being
      // tunneled through. corner columns checked at every level the body
      // sweeps, plus jump headroom above the source cell.
      if (s.allowDiagonalAscend !== false && view.standable(nx, y, nz)) {
        const upBreak = breakables(view, [
          { x: nx, y: y + 1, z: nz }, { x: nx, y: y + 2, z: nz },
          { x: nx, y: y + 1, z }, { x: nx, y: y + 2, z },
          { x, y: y + 1, z: nz }, { x, y: y + 2, z: nz },
          { x, y: y + 2, z }
        ], s)
        if (upBreak) {
          for (const b of upBreak) toBreak.push(b)
          let cost = s.ascendCost * 1.25
          for (const b of toBreak) cost += digCost(b, s)
          out.push(movement('diagonal', node, { x: nx, y: y + 1, z: nz }, cost, toBreak))
          continue // an ascent exists here; don't also tunnel through it
        }
      }

      const land = landing(view, nx, y - 1, nz, s)
      if (!land || land.kind !== 'solid') continue
      const drop = y - land.y
      if (drop === 0) {
        const feetBreak = breakables(view, [{ x: nx, y, z: nz }, { x: nx, y: y + 1, z: nz }], s)
        if (!feetBreak) continue
        for (const b of feetBreak) toBreak.push(b)
        let cost = s.walkCost * SQRT2
        for (const b of toBreak) cost += digCost(b, s)
        out.push(movement('diagonal', node, { x: nx, y, z: nz }, cost, toBreak))
      } else if (drop === 1 && s.allowDiagonalDescend !== false) {
        const feetBreak = breakables(view, [{ x: nx, y: y - 1, z: nz }, { x: nx, y, z: nz }], s)
        if (!feetBreak) continue
        for (const b of feetBreak) toBreak.push(b)
        let cost = s.walkCost * SQRT2
        for (const b of toBreak) cost += digCost(b, s)
        out.push(movement('diagonal', node, { x: nx, y: y - 1, z: nz }, cost, toBreak))
      }
    }
  }

  return out
}

// re-check an existing movement against the live world. used by the
// executor every tick: the first move that no longer validates forces a
// splice (replan from the current position), never a blind walk into a
// wall the world just placed there.
function stillValid (view, m, settings) {
  const fresh = generate(view, m.from, settings)
  return fresh.some((c) =>
    c.to.x === m.to.x && c.to.y === m.to.y && c.to.z === m.to.z && c.type === m.type)
}

// CHEAP move validation — the fix for the splice storm. regenerating the
// full movement list from a planned node (stillValid) asks "would the
// planner, standing at m.from TODAY, produce this exact move again?" —
// which is the wrong question mid-execution: a chained bridge's support
// does not exist yet because THIS move's predecessor places it, so every
// lookahead bridge failed validation and the executor replanned forever
// without ever placing the first block. this validator instead checks
// what actually matters for executing the move in order:
//
//   - the destination cells are not occupied by something foreign
//     (solid blocks we did not plan to break)
//   - every planned break is still breakable (no bedrock materialized)
//   - a fall's landing did not turn into lava
//   - placement cells are free (or already ours from an earlier attempt)
//
// support blocks placed by EARLIER moves in the queue are fine — that is
// the whole point of chains.
function validateMove (view, m) {
  const planned = (c) => m.toBreak && m.toBreak.some((b) => b.x === c.x && b.y === c.y && b.z === c.z)
  const occupied = (c) => view.solid(c.x, c.y, c.z) && !planned(c)
  if (occupied({ x: m.to.x, y: m.to.y, z: m.to.z })) return false
  if (occupied({ x: m.to.x, y: m.to.y + 1, z: m.to.z })) return false
  // jumping moves need the headroom above the source cell too
  if (m.type === 'ascend' || m.type === 'ascendPlace' || m.type === 'diagonal' && m.to.y > m.from.y) {
    if (occupied({ x: m.from.x, y: m.from.y + 2, z: m.from.z })) return false
  }
  for (const b of m.toBreak || []) {
    if (view.solid(b.x, b.y, b.z)) {
      const info = view.breakInfo(b.x, b.y, b.z)
      if (!info || !info.breakable) return false
    }
  }
  if (m.type === 'fall' && view.lava(m.to.x, m.to.y - 1, m.to.z)) return false
  // placement cells are deliberately NOT checked: a solid block in one
  // means support already exists (the move degrades to a walk), an
  // unknown cell is the bridging-into-fog contract, and a missing anchor
  // is the executor's runtime problem (bumpPlaceTries → splice), not a
  // reason to invalidate the whole plan every tick
  return true
}

module.exports = { generate, stillValid, validateMove, digSeconds, digCost, toolMultFor, DEFAULTS, CARDINALS }

