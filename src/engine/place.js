'use strict'

// shared placing helpers for everything that puts a block into the world
// (the executor's pillar/bridge movements and the builder process).
// mineflayer places whatever item is in hand, so every placement equips
// first — either the exact block asked for, or any placeable block when
// the caller does not care. "placeable" means the item name maps to a
// known block in the registry the world view carries.

const PREFERRED_FILL = ['cobblestone', 'dirt', 'netherrack', 'stone', 'oak_planks']

function inventoryOf (bot) {
  try { return (bot.inventory && bot.inventory.items()) || [] } catch (e) { return [] }
}

// find an inventory item by exact name (or null)
function findItem (bot, name) {
  return inventoryOf(bot).find((it) => it && it.name === name) || null
}

// find any item that is a placeable block; preferred fill blocks first
function findAnyBlockItem (bot, view) {
  const items = inventoryOf(bot)
  const reg = view && view.registry
  const known = (n) => !!(reg && reg.blocksByName && reg.blocksByName[n])
  for (const pref of PREFERRED_FILL) {
    const hit = items.find((it) => it && it.name === pref)
    if (hit) return hit
  }
  return items.find((it) => it && known(it.name)) || null
}

// equip for a placement. when blockName is given, that exact item must be
// in the inventory (returns null otherwise — the caller reports honestly).
// when blockName is null, any placeable block is equipped.
async function equipForPlace (view, bot, blockName) {
  let item = blockName ? findItem(bot, blockName) : findAnyBlockItem(bot, view)
  if (!item) return null
  try {
    if (bot.equip) await bot.equip(item, 'hand')
  } catch (e) { /* fake bots and some edge states may not equip */ }
  return item
}

// solid neighbor faces of a cell that a placement can click against,
// ordered up first (safest: no sneak needed), then sides, then down.
// returns [{ ref: {x,y,z}, face: {x,y,z} }]
const FACE_ORDER = [
  { x: 0, y: 1, z: 0 },
  { x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 },
  { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 },
  { x: 0, y: -1, z: 0 }
]

function anchorsFor (view, cell) {
  const out = []
  for (const f of FACE_ORDER) {
    const rx = cell.x + f.x
    const ry = cell.y + f.y
    const rz = cell.z + f.z
    if (view.solid(rx, ry, rz)) {
      out.push({ ref: { x: rx, y: ry, z: rz }, face: { x: -f.x, y: -f.y, z: -f.z } })
    }
  }
  return out
}

// can the bot reach the center of this cell with a block placement / dig?
function withinReach (pilot, cell) {
  const p = pilot.pos()
  if (!p) return false
  const dx = (cell.x + 0.5) - p.x
  const dy = (cell.y + 0.5) - (p.y + 1.6)
  const dz = (cell.z + 0.5) - p.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz) <= 4.2
}

module.exports = { findItem, findAnyBlockItem, equipForPlace, anchorsFor, withinReach, FACE_ORDER }
