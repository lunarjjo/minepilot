'use strict'

// movement generation — the heart of the pathfinder, in the spirit of
// baritone's Movement classes. from a standing position, enumerate every
// legal minecraft movement with its true-ish cost:
//
//   traverse   walk one cardinal block flat (cost 1)
//   diagonal   45 degree step, both corners clear (cost sqrt2)
//   ascend     step up one block with a jump (cost 2)
//   descend    walk off a one block ledge (cost 1)
//   fall       drop n blocks into a safe landing (cost 1 + 0.1n)
//   swim       traverse through water (cost 2.2)
//   climb      go up/down a ladder or vine column (cost 1.2)
//   parkour    sprint-jump a one block gap (cost 2.5, opt-in)
//   pillar     jump and place a block under yourself (needs blocks)
//   bridge     place a block ahead over a bottomless gap and walk it
//
// any solid block in the way may be broken through when allowBreak is on:
// its cost is the hand dig time converted to walk-equivalent blocks
// (hardness >= 1 is treated as "needs a tool" -> *5, minecraft's formula).
// unknown / unloaded space is a wall: the fleet never paths into the fog.

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
  allowPillar: false, // pillar straight up by placing blocks (opt-in: the headless placement ack is racy)
  allowWater: true, // swimming is legal
  allowFallDamage: false, // never take fall damage by default
  allowSprint: true, // sprint while walking
  allowDiagonalAscend: false, // 45 degree ascents
  allowDiagonalDescend: true, // 45 degree descents
  maxFallNoDamage: 3, // vanilla: 4+ blocks starts hurting
  maxFallWithDamage: 8, // even when allowed, do not gamble everything
  maxWaterLanding: 20, // deep water landings are fine up to this
  walkCost: 1,
  swimCost: 2.2,
  climbCost: 1.2,
  ascendCost: 2,
  parkourCost: 2.5,
  fallCostPerBlock: 0.1,
  fallDamageCost: 0.5, // per half heart of expected damage
  walkBlocksPerSecond: 4.3, // converts dig seconds into cost units
  blockBreakAdditionalPenalty: 2, // flat penalty per dig (baritone default)
  blockPlacementPenalty: 4, // flat penalty per placement (baritone 20; minepilot bridges slower, tuned down)
  jumpPenalty: 0 // ascendCost already prices the jump; extra hunger penalty only if you ask
}

// hand dig time (seconds) for a hardness value. approximate: harvestable
// with bare hands (dirt-like) uses *1.5, tool-gated (stone-like) uses *5.
function digSeconds (hardness) {
  if (hardness < 0) return Infinity
  return hardness >= 1 ? hardness * 5 : hardness * 1.5
}

function digCost (b, settings) {
  const hardness = typeof b === 'number' ? b : b.hardness
  let cost = digSeconds(hardness) * settings.walkBlocksPerSecond +
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

  // standing inside a ladder/vine column: straight up and down
  if (onLadder) {
    if (view.climbable(x, y + 1, z) || view.passable(x, y + 1, z)) {
      out.push(movement('climb', node, { x, y: y + 1, z }, s.climbCost))
    }
    if (view.climbable(x, y - 1, z) || view.passable(x, y - 1, z)) {
      out.push(movement('climb', node, { x, y: y - 1, z }, s.climbCost * 0.8))
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
          out.push(movement('descend', node, { x: nx, y: y - 1, z: nz }, s.walkCost, toBreak))
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

    // bridge: the gap ahead has no bottom within scan range (void, fog,
    // or lava underneath) — place a block at foot level ahead, anchored
    // on the side face of the block we are standing on, and walk it.
    // baritone does exactly this when building across breaks in terrain.
    if (s.allowPlace && !land) {
      const feetClear = view.passable(nx, y, nz) && view.passable(nx, y + 1, nz)
      const standingSolid = view.solid(x, y - 1, z)
      if (feetClear && standingSolid) {
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

module.exports = { generate, stillValid, digSeconds, digCost, DEFAULTS, CARDINALS }

