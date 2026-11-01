'use strict'

// the goal system. a goal answers two questions for any standing position:
//   heuristic(x, y, z) — a LOWER BOUND on remaining cost; admissible so the
//     A* stays optimal (never overestimates)
//   isMet(x, y, z)     — is the goal satisfied standing here?
// composite and inverted goals compose the primitives, the same way
// baritone composes GoalBlock / GoalNear / GoalXZ / GoalRunAway.

const SQRT2 = Math.SQRT2

// baritone's COST_HEURISTIC is sprint-based (3.563 ticks/block vs walking
// 4.633): a heuristic priced at walking speed OVERestimates any route the
// bot can sprint, and an overestimating heuristic makes A* settle for
// worse paths. 0.8 keeps the bound under the sprint-jump pace so the
// search stays admissible AND optimal.
const SPRINT_FACTOR = 0.8

function octile (dx, dz) {
  const ax = Math.abs(dx)
  const az = Math.abs(dz)
  return Math.max(ax, az) + (SQRT2 - 1) * Math.min(ax, az)
}

class Goal {
  constructor (label) {
    this.labelText = label
  }

  label () {
    return this.labelText
  }
}

// one exact block. every vertical change costs at least 1 (down) or 2 (up),
// so octile + |dy| never overestimates.
class GoalBlock extends Goal {
  constructor (x, y, z) {
    super(`block ${x} ${y} ${z}`)
    this.x = x
    this.y = y
    this.z = z
  }

  heuristic (x, y, z) {
    return octile(x - this.x, z - this.z) * SPRINT_FACTOR + Math.abs(y - this.y)
  }

  isMet (x, y, z) {
    return x === this.x && y === this.y && z === this.z
  }
}

// within a radius (3d) of a point. the radius shaves the bound.
class GoalNear extends Goal {
  constructor (x, y, z, r) {
    super(`near ${x} ${y} ${z} r${r}`)
    this.x = x
    this.y = y
    this.z = z
    this.r = r
  }

  heuristic (x, y, z) {
    const h = octile(x - this.x, z - this.z) * SPRINT_FACTOR + Math.abs(y - this.y)
    return Math.max(0, h - this.r)
  }

  isMet (x, y, z) {
    const dx = x - this.x
    const dy = y - this.y
    const dz = z - this.z
    return dx * dx + dy * dy + dz * dz <= this.r * this.r
  }
}

// horizontal position, any height.
class GoalXZ extends Goal {
  constructor (x, z) {
    super(`xz ${x} ${z}`)
    this.x = x
    this.z = z
  }

  heuristic (x, y, z) {
    return octile(x - this.x, z - this.z) * SPRINT_FACTOR
  }

  isMet (x, y, z) {
    return x === this.x && z === this.z
  }
}

// reach a y level, anywhere.
class GoalYLevel extends Goal {
  constructor (y) {
    super(`y ${y}`)
    this.y = y
  }

  heuristic (x, y, z) {
    return Math.abs(y - this.y)
  }

  isMet (x, y, z) {
    return y === this.y
  }
}

// satisfied when ANY sub-goal is satisfied. the bound is the cheapest one.
// baritone calls this GoalComposite; minepilot also exports it as
// GoalCompositeOr for readability next to GoalCompositeAnd.
class GoalComposite extends Goal {
  constructor (...goals) {
    super(`any(${goals.map((g) => g.label()).join(' | ')})`)
    this.goals = goals
  }

  heuristic (x, y, z) {
    let best = Infinity
    for (const g of this.goals) {
      const h = g.heuristic(x, y, z)
      if (h < best) best = h
    }
    return best === Infinity ? 0 : best
  }

  isMet (x, y, z) {
    return this.goals.some((g) => g.isMet(x, y, z))
  }
}

// satisfied when ALL sub-goals are satisfied. the bound is the most
// expensive one (the sum could overestimate when goals share distance).
class GoalCompositeAnd extends Goal {
  constructor (...goals) {
    super(`all(${goals.map((g) => g.label()).join(' & ')})`)
    this.goals = goals
  }

  heuristic (x, y, z) {
    let worst = 0
    for (const g of this.goals) {
      const h = g.heuristic(x, y, z)
      if (h > worst) worst = h
    }
    return worst
  }

  isMet (x, y, z) {
    return this.goals.every((g) => g.isMet(x, y, z))
  }
}

// baritone's GoalTwoBlocks: same block column, either feet or head level
// (standing on it or inside it, the way you "reach" a chest).
class GoalTwoBlocks extends Goal {
  constructor (x, y, z) {
    super(`twoblocks ${x} ${y} ${z}`)
    this.x = x
    this.y = y
    this.z = z
  }

  heuristic (x, y, z) {
    return octile(x - this.x, z - this.z) * SPRINT_FACTOR + Math.min(Math.abs(y - this.y), Math.abs(y - (this.y - 1)))
  }

  isMet (x, y, z) {
    return x === this.x && z === this.z && (y === this.y || y === this.y - 1)
  }
}

// baritone's GoalAxis: reach the nearest axis (x=0 or z=0), any position
// along it. the heuristic must never overestimate: the true distance is
// min(|x|, |z|) on the same plane (no diagonal saving once you commit to
// the axis line, so plain |x| / |z| is admissible).
class GoalAxis extends Goal {
  constructor (y) {
    super(`axis${y === undefined ? '' : ' y' + y}`)
    this.y = y === undefined ? null : y
  }

  heuristic (x, y, z) {
    const axis = Math.min(Math.abs(x), Math.abs(z))
    const dy = this.y === null ? 0 : Math.abs(y - this.y)
    return axis * SPRINT_FACTOR + dy
  }

  isMet (x, y, z) {
    if (this.y !== null && y !== this.y) return false
    return x === 0 || z === 0
  }
}

// baritone's GoalStrictDirection: get to ANY block in a strict direction
// from an anchor (used by #thisway). the heuristic is the plane distance
// once you are past the anchor along the direction, 0 before it.
class GoalStrictDirection extends Goal {
  // direction: { x, z } — a cardinal or diagonal unit vector
  constructor (originX, y, originZ, direction) {
    super(`strictdir ${direction.x},${direction.z}`)
    this.ox = originX
    this.y = y
    this.oz = originZ
    this.dx = direction.x
    this.dz = direction.z
  }

  heuristic (x, y, z) {
    const dy = this.y === null ? 0 : Math.abs(y - this.y)
    // progress along the direction; negative means behind the origin
    const along = (x - this.ox) * this.dx + (z - this.oz) * this.dz
    if (along <= 0) return dy
    // perpendicular distance to the ray (how far off the line we are)
    const perp = Math.abs((x - this.ox) * this.dz - (z - this.oz) * this.dx)
    // remaining along-distance (bounded by straight-line distance so it
    // stays admissible)
    const straight = octile(x - this.ox, z - this.oz) * SPRINT_FACTOR
    return Math.min(straight, along) + perp + dy
  }

  isMet (x, y, z) {
    if (this.y !== null && y !== this.y) return false
    const along = (x - this.ox) * this.dx + (z - this.oz) * this.dz
    if (along <= 0) return false // must be strictly past the origin
    // strictly on the ray: for cardinals the cross coordinate matches,
    // for diagonals the offsets stay equal
    const perp = Math.abs((x - this.ox) * this.dz - (z - this.oz) * this.dx)
    return perp === 0
  }
}

// baritone's GoalGetToBlock: stand where you can touch the block — feet
// at its level (or one below, head at its level), within one block
// horizontally. the exact baritone formula is
//   |dx| + |(dy < 0 ? dy + 1 : dy)| + |dz| <= 1
// which also counts standing inside / directly under the cell itself.
class GoalGetToBlock extends Goal {
  constructor (x, y, z) {
    super(`getto ${x} ${y} ${z}`)
    this.x = x
    this.y = y
    this.z = z
  }

  // the vertical difference counted the way baritone counts it: being
  // one below the block reads as level, because the head is at block level
  vert (y) {
    const dy = y - this.y
    return dy < 0 ? dy + 1 : dy
  }

  heuristic (x, y, z) {
    return octile(x - this.x, z - this.z) * SPRINT_FACTOR + Math.abs(this.vert(y))
  }

  isMet (x, y, z) {
    return Math.abs(x - this.x) + Math.abs(this.vert(y)) + Math.abs(z - this.z) <= 1
  }
}

// satisfied when the inner goal is NOT. has no admissible bound (any move
// could be the last one needed), so it degrades the search to dijkstra —
// same trade-off baritone makes for GoalRunAway.
class GoalInverted extends Goal {
  constructor (inner) {
    super(`not(${inner.label()})`)
    this.inner = inner
  }

  heuristic () {
    return 0
  }

  isMet (x, y, z) {
    return !this.inner.isMet(x, y, z)
  }
}

// run away from a point until outside a radius.
class GoalRunAway extends Goal {
  constructor (x, z, r) {
    super(`away ${x} ${z} r${r}`)
    this.x = x
    this.z = z
    this.r = r
  }

  heuristic () {
    return 0
  }

  isMet (x, y, z) {
    const dx = x - this.x
    const dz = z - this.z
    return dx * dx + dz * dz >= this.r * this.r
  }
}

// a dynamic goal: getPosition() is re-read on every replan, so the target
// can walk around. internally evaluated as GoalNear with a slack radius.
class GoalFollow extends Goal {
  constructor (getPosition, r) {
    super(`follow r${r}`)
    this.getPosition = getPosition
    this.r = r
    this.last = null
  }

  target () {
    const p = this.getPosition()
    if (p) this.last = p
    return this.last
  }

  heuristic (x, y, z) {
    const p = this.target()
    if (!p) return 0
    const h = octile(x - p.x, z - p.z) * SPRINT_FACTOR + Math.abs(y - (p.y || y))
    return Math.max(0, h - this.r)
  }

  isMet (x, y, z) {
    const p = this.target()
    if (!p) return false
    const dx = x - p.x
    const dy = y - (p.y || y)
    const dz = z - p.z
    return dx * dx + dy * dy + dz * dz <= this.r * this.r
  }
}

module.exports = {
  octile,
  SPRINT_FACTOR,
  Goal,
  GoalBlock,
  GoalNear,
  GoalXZ,
  GoalYLevel,
  GoalComposite,
  GoalCompositeOr: GoalComposite,
  GoalCompositeAnd,
  GoalTwoBlocks,
  GoalAxis,
  GoalStrictDirection,
  GoalGetToBlock,
  GoalInverted,
  GoalRunAway,
  GoalFollow
}
