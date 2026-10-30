'use strict'

// the world view: block semantics for the pathfinder, over either a real
// mineflayer bot or anything that answers getBlock(x, y, z). unknown /
// unloaded chunks answer null and the pathfinder treats them as walls —
// baritone instead charges them a heavy penalty and wanders hopefully;
// for a fleet console, refusing to path into the fog is the safer contract.

const AIR_LIKE = new Set(['air', 'cave_air', 'void_air', 'light', 'structure_void'])
const CLIMBABLE = new Set(['ladder', 'vine', 'twisting_vines', 'weeping_vines',
  'cave_vines', 'cave_vines_plant', 'scaffolding'])
const LIQUIDS = new Set(['water', 'flowing_water'])
const UNSAFE_LIQUIDS = new Set(['lava', 'flowing_lava'])

// blocks that are safe to walk INTO (the body can occupy the cell) even
// though they are not air: plants, rails, snow layers, liquids, ladders.
const NON_SOLID = new Set([...AIR_LIKE, ...CLIMBABLE, ...LIQUIDS, UNSAFE_LIQUIDS,
  'grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'dandelion',
  'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'oxeye_daisy',
  'cornflower', 'lily_of_the_valley', 'wither_rose', 'torchflower',
  'sunflower', 'lilac', 'rose_bush', 'peony', 'wheat', 'carrots', 'potatoes',
  'beetroots', 'torch', 'wall_torch', 'rail', 'powered_rail', 'detector_rail',
  'activator_rail', 'snow', 'sugar_cane', 'cobweb'])

class WorldView {
  // getBlock: (x, y, z) -> { name, hardness?, boundingBox? } | null
  // rules: optional live rule set from the settings registry:
  //   { avoid: Set, disallowBreak: Set, avoidBreak: Set,
  //     allowBreakAnyway: Set, avoidBreakingMultiplier: number }
  // it defaults to empty sets (nothing avoided, everything breakable).
  constructor (getBlock, opts) {
    this.getBlock = getBlock
    this.registry = (opts && opts.registry) || null
    this.rules = (opts && opts.rules) || null
  }

  static fromBot (bot, deps, rules) {
    const Vec3 = deps.Vec3
    return new WorldView((x, y, z) => {
      try {
        return bot.world ? bot.world.getBlock(new Vec3(x, y, z)) : (bot.blockAt ? bot.blockAt(new Vec3(x, y, z)) : null)
      } catch (e) {
        return null
      }
    }, { registry: bot.registry || null, rules: rules || null })
  }

  block (x, y, z) {
    return this.getBlock(x, y, z) || null
  }

  name (x, y, z) {
    const b = this.block(x, y, z)
    return b ? b.name : null
  }

  // can the body occupy the cell? null (unknown) answers false.
  passable (x, y, z) {
    const b = this.block(x, y, z)
    if (!b) return false
    if (b.boundingBox) return b.boundingBox === 'empty' || NON_SOLID.has(b.name)
    return AIR_LIKE.has(b.name) || NON_SOLID.has(b.name)
  }

  // unknown blocks count as impassable (never path into the fog).
  known (x, y, z) {
    return this.block(x, y, z) !== null
  }

  // can the cell be broken by hand within a sane time? consults the live
  // rule set: blocksToDisallowBreaking vetoes a dig outright (unless it is
  // also in allowBreakAnyway), blocksToAvoidBreaking only makes it costly.
  breakInfo (x, y, z) {
    const b = this.block(x, y, z)
    if (!b) return null
    let hardness = typeof b.hardness === 'number' ? b.hardness : null
    if (hardness === null && this.registry && this.registry.blocksByName) {
      const meta = this.registry.blocksByName[b.name]
      if (meta) hardness = meta.hardness
    }
    if (hardness === null || hardness === undefined) hardness = 1
    const r = this.rules
    const name = b.name
    let disallowed = false
    let avoided = false
    if (r) {
      if (r.disallowBreak && r.disallowBreak.has(name) && !(r.allowBreakAnyway && r.allowBreakAnyway.has(name))) {
        disallowed = true
      }
      if (r.avoidBreak && r.avoidBreak.has(name) && !(r.allowBreakAnyway && r.allowBreakAnyway.has(name))) {
        avoided = true
      }
    }
    return {
      name,
      hardness,
      breakable: hardness >= 0 && !disallowed,
      avoided,
      avoidMultiplier: r && Number.isFinite(r.avoidBreakingMultiplier) ? r.avoidBreakingMultiplier : 0
    }
  }

  solid (x, y, z) {
    const b = this.block(x, y, z)
    if (!b) return false
    if (b.boundingBox) return b.boundingBox !== 'empty' && !NON_SOLID.has(b.name)
    return !AIR_LIKE.has(b.name) && !NON_SOLID.has(b.name)
  }

  liquid (x, y, z) {
    const n = this.name(x, y, z)
    return LIQUIDS.has(n) || UNSAFE_LIQUIDS.has(n)
  }

  water (x, y, z) {
    const n = this.name(x, y, z)
    return LIQUIDS.has(n)
  }

  lava (x, y, z) {
    return UNSAFE_LIQUIDS.has(this.name(x, y, z))
  }

  climbable (x, y, z) {
    return CLIMBABLE.has(this.name(x, y, z))
  }

  // a cell the feet can rest ON: full/partial boxes that are not liquids
  // and not climbable. partial covers slabs, stairs, snow layers. blocks
  // in blocksToAvoid never count as support even when they are solid.
  standable (x, y, z) {
    const b = this.block(x, y, z)
    if (!b) return false
    if (this.rules && this.rules.avoid && this.rules.avoid.has(b.name)) return false
    if (b.boundingBox) return b.boundingBox !== 'empty' && !NON_SOLID.has(b.name)
    return !AIR_LIKE.has(b.name) && !NON_SOLID.has(b.name)
  }
}

module.exports = { WorldView, AIR_LIKE, CLIMBABLE, LIQUIDS, UNSAFE_LIQUIDS, NON_SOLID }

// build the live rule set the WorldView and the movement generator share,
// from the settings registry (or anything with .get(key)). exported so the
// autopilot can rebuild it whenever the user edits a block list.
function rulesFromSettings (settings) {
  const list = (key) => new Set(settings ? settings.get(key) : [])
  return {
    avoid: list('blocksToAvoid'),
    disallowBreak: list('blocksToDisallowBreaking'),
    avoidBreak: list('blocksToAvoidBreaking'),
    allowBreakAnyway: list('allowBreakAnyway'),
    avoidBreakingMultiplier: settings ? Number(settings.get('avoidBreakingMultiplier') || 0) : 0
  }
}

module.exports.rulesFromSettings = rulesFromSettings
