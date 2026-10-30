'use strict'

// schematic loading — minepilot's port of baritone's schematic system,
// covering the three formats people actually have on disk:
//
//   .litematic  litematica's own format: paletted long array with
//               no-straddle packing, regions, enclosing size metadata
//   .schem      the sponge/vanilla-adjacent format (worldedit): palette
//               map + byte/byte-array block data
//   .schematic  the legacy mcedit format: Blocks + Data byte arrays
//
// every parser returns the same blueprint the builder consumes:
//   { name, size: {x,y,z}, placements: [{x,y,z,block}] }
// with y-up, z as the long axis — converted per format as needed.

const fs = require('fs')
const nbt = require('prismarine-nbt')

// ---------------------------------------------------------------- helpers

function nbtGet (compound, key) {
  if (!compound || !compound.value || !compound.value[key]) return null
  return compound.value[key]
}

function nbtValue (compound, key) {
  const tag = nbtGet(compound, key)
  return tag ? tag.value : null
}

function simplifyRoot (parsed) {
  // prismarine-nbt 2.x: parse() -> { parsed, type }; older: { data }
  return parsed.parsed || parsed.data || parsed
}

// nbt files name their ROOT compound after the format ("Litematic",
// "Schematic") — the root itself carries the payload. some tools wrap it
// one level deeper, so accept both shapes.
function rootCompound (root, name) {
  if (root && root.name === name) return root
  const nested = nbtGet(root, name)
  return nested || root
}

// litematica stores longs; prismarine-nbt hands them back either as a
// BigInt, or as the classic [hi, lo] signed 32-bit pair. both go in as
// the unsigned 64-bit bit pattern.
function longToBits (v) {
  if (Array.isArray(v) && v.length === 2) {
    const hi = Number(v[0]) >>> 0
    const lo = Number(v[1]) >>> 0
    return (BigInt(hi) << 32n) | BigInt(lo)
  }
  try {
    return BigInt(v) & 0xffffffffffffffffn
  } catch (e) {
    return 0n
  }
}

// ---------------------------------------------------------------- litematic

function parseLitematic (root) {
  const comp = rootCompound(root, 'Litematic')
  if (!nbtGet(comp, 'Regions') && !nbtGet(comp, 'Metadata')) {
    return { ok: false, error: 'not a litematic (no Regions/Metadata)' }
  }
  const meta = nbtGet(comp, 'Metadata')
  const name = meta ? String(nbtValue(meta, 'Name') || 'unnamed') : 'unnamed'
  const sizeTag = meta ? nbtGet(meta, 'EnclosingSize') : null
  const size = sizeTag ? {
    x: nbtValue(sizeTag, 'x') || 0,
    y: nbtValue(sizeTag, 'y') || 0,
    z: nbtValue(sizeTag, 'z') || 0
  } : { x: 0, y: 0, z: 0 }

  // litematica stores the region payload directly under Regions
  const regionsTag = nbtGet(comp, 'Regions')
  if (!regionsTag || !regionsTag.value) return { ok: false, error: 'litematic has no regions' }
  const regions = regionsTag.value

  const placements = []
  for (const [regionName, regionTag] of Object.entries(regions)) {
    const rsize = nbtGet(regionTag, 'Size')
    if (!rsize) continue
    const rx = nbtValue(rsize, 'x') || 0
    const ry = nbtValue(rsize, 'y') || 0
    const rz = nbtValue(rsize, 'z') || 0
    if (rx <= 0 || ry <= 0 || rz <= 0) continue

    const paletteTag = nbtGet(regionTag, 'BlockStatePalette')
    if (!paletteTag) continue
    // nbt list tags hold { type, value: [...] } — normalize both shapes
    const paletteList = Array.isArray(paletteTag.value)
      ? paletteTag.value
      : (paletteTag.value && Array.isArray(paletteTag.value.value) ? paletteTag.value.value : null)
    if (!paletteList) continue
    // list entries arrive as bare value objects ({ Name: tag }) — some
    // readers wrap them as { value: { Name: tag } }; accept both
    const palette = paletteList.map((state) => {
      const nameTag = (state && state.value && state.value.Name) ? state.value.Name
        : (state && state.Name ? state.Name : null)
      return String(nameTag ? nameTag.value : 'air')
    })

    const statesTag = nbtGet(regionTag, 'BlockStates')
    if (!statesTag || !Array.isArray(statesTag.value)) continue
    const longs = statesTag.value

    // litematica packing: values never straddle a long boundary; each
    // long holds floor(64 / bits) palette indexes
    const bits = Math.max(2, (palette.length - 1).toString(2).length)
    const perLong = Math.floor(64 / bits)
    const mask = (1n << BigInt(bits)) - 1n
    const expected = rx * ry * rz
    let index = 0
    for (let li = 0; li < longs.length && index < expected; li++) {
      const packed = longToBits(longs[li])
      for (let s = 0; s < perLong && index < expected; s++) {
        const shift = BigInt(s * bits)
        const pi = Number((packed >> shift) & mask)
        const block = palette[pi] || 'air'
        if (block !== 'air') placements.push({ x: index % rx, y: Math.floor(index / (rx * rz)), z: Math.floor(index / rx) % rz, block })
        index++
      }
    }
    void regionName
  }

  if (placements.length === 0) {
    return { ok: false, error: `litematic "${name}" contains no blocks` }
  }
  return { ok: true, schematic: { name: name.replace(/[^\w.-]/g, '_').slice(0, 48), size, placements } }
}

// ---------------------------------------------------------------- sponge .schem

function parseSchem (root) {
  const comp = rootCompound(root, 'Schematic')
  const width = nbtValue(comp, 'Width') || 0
  const height = nbtValue(comp, 'Height') || 0
  const length = nbtValue(comp, 'Length') || 0
  const name = String(nbtValue(comp, 'Name') || nbtValue(comp, 'SchematicName') || 'unnamed')
  if (!width || !height || !length) return { ok: false, error: 'schem has no dimensions' }

  const paletteTag = nbtGet(comp, 'Palette')
  if (!paletteTag || !paletteTag.value) return { ok: false, error: 'schem has no palette' }
  // Palette: { "minecraft:stone": id }
  const idToName = new Map()
  for (const [blockName, idTag] of Object.entries(paletteTag.value)) {
    idToName.set(idTag.value, blockName.replace('minecraft:', ''))
  }

  const dataTag = nbtGet(comp, 'BlockData') || nbtGet(comp, 'Blocks')
  if (!dataTag) return { ok: false, error: 'schem has no block data' }
  const data = dataTag.value // byte array (Buffer or number[])

  // sponge v2: one byte per block when palette <= 256; v3 may use
  // varints in a byte array — handle the byte-per-block case (covers
  // worldedit exports) and the varint case
  const paletteMax = Math.max(...[...idToName.keys()])
  const placements = []
  if (paletteMax < 256 && data.length === width * height * length) {
    let i = 0
    for (let y = 0; y < height; y++) {
      for (let z = 0; z < length; z++) {
        for (let x = 0; x < width; x++) {
          const id = data[i++]
          const block = idToName.get(id)
          if (block && block !== 'air') {
            placements.push({ x, y, z, block })
          }
        }
      }
    }
  } else {
    // varint stream (sponge v3)
    let i = 0
    const readVarint = () => {
      let value = 0
      let shift = 0
      while (i < data.length) {
        const b = data[i++]
        value |= (b & 0x7f) << shift
        if ((b & 0x80) === 0) break
        shift += 7
      }
      return value
    }
    for (let y = 0; y < height; y++) {
      for (let z = 0; z < length; z++) {
        for (let x = 0; x < width; x++) {
          const id = readVarint()
          const block = idToName.get(id)
          if (block && block !== 'air') {
            placements.push({ x, y, z, block })
          }
        }
      }
    }
  }

  if (placements.length === 0) return { ok: false, error: `schem "${name}" contains no blocks` }
  return { ok: true, schematic: { name: name.replace(/[^\w.-]/g, '_').slice(0, 48), size: { x: width, y: height, z: length }, placements } }
}

// ---------------------------------------------------------------- legacy .schematic

function parseLegacySchematic (root) {
  const comp = rootCompound(root, 'Schematic')
  const width = nbtValue(comp, 'Width') || 0
  const height = nbtValue(comp, 'Height') || 0
  const length = nbtValue(comp, 'Length') || 0
  const name = String(nbtValue(comp, 'Name') || nbtValue(comp, 'SchematicName') || 'unnamed')
  if (!width || !height || !length) return { ok: false, error: 'schematic has no dimensions' }

  const blocksTag = nbtGet(comp, 'Blocks')
  if (!blocksTag) return { ok: false, error: 'schematic has no Blocks array' }
  const blocks = blocksTag.value
  const dataTag = nbtGet(comp, 'Data')
  const data = dataTag ? dataTag.value : null
  const addTag = nbtGet(comp, 'AddBlocks')
  const add = addTag ? addTag.value : null

  // legacy ids are numeric — without a full id->name table for every
  // minecraft version, we map the classic ids that matter and fall back
  // to a named placeholder the builder will refuse honestly
  const LEGACY = legacyIdTable()
  const placements = []
  let i = 0
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        let id = blocks[i]
        if (add) {
          const half = add[Math.floor(i / 2)]
          const nib = i % 2 === 0 ? half & 0x0f : half >> 4
          id |= nib << 8
        }
        const meta = data ? data[i] : 0
        i++
        const name2 = LEGACY[id]
        if (name2 && name2 !== 'air') {
          placements.push({ x, y, z, block: name2 })
        }
        void meta
      }
    }
  }
  if (placements.length === 0) return { ok: false, error: `schematic "${name}" contains no known blocks` }
  return { ok: true, schematic: { name: name.replace(/[^\w.-]/g, '_').slice(0, 48), size: { x: width, y: height, z: length }, placements } }
}

// classic numeric block ids (enough to load the average structure export)
function legacyIdTable () {
  const t = {}
  const add = (id, name) => { t[id] = name }
  add(0, 'air')
  add(1, 'stone'); add(2, 'grass_block'); add(3, 'dirt'); add(4, 'cobblestone')
  add(5, 'oak_planks'); add(8, 'water'); add(9, 'water'); add(10, 'lava'); add(11, 'lava')
  add(12, 'sand'); add(13, 'gravel'); add(17, 'oak_log'); add(18, 'oak_leaves')
  add(20, 'glass'); add(21, 'lapis_ore'); add(22, 'lapis_block')
  add(24, 'sandstone'); add(25, 'note_block'); add(29, 'sticky_piston')
  add(33, 'piston'); add(35, 'white_wool'); add(41, 'gold_block'); add(42, 'iron_block')
  add(43, 'double_stone_slab'); add(44, 'stone_slab'); add(45, 'bricks')
  add(46, 'tnt'); add(47, 'bookshelf'); add(48, 'mossy_cobblestone')
  add(49, 'obsidian'); add(50, 'torch'); add(52, 'spawner'); add(53, 'oak_stairs')
  add(54, 'chest'); add(56, 'diamond_ore'); add(57, 'diamond_block')
  add(58, 'crafting_table'); add(59, 'wheat'); add(60, 'farmland')
  add(61, 'furnace'); add(62, 'furnace'); add(63, 'sign'); add(64, 'oak_door')
  add(65, 'ladder'); add(66, 'rail'); add(67, 'cobblestone_stairs')
  add(69, 'lever'); add(70, 'stone_pressure_plate'); add(72, 'oak_pressure_plate')
  add(73, 'redstone_ore'); add(74, 'redstone_ore'); add(75, 'redstone_torch')
  add(76, 'redstone_torch'); add(77, 'stone_button'); add(78, 'snow')
  add(79, 'ice'); add(80, 'snow_block'); add(81, 'cactus'); add(82, 'clay')
  add(84, 'jukebox'); add(85, 'oak_fence'); add(86, 'carved_pumpkin')
  add(87, 'netherrack'); add(88, 'soul_sand'); add(89, 'glowstone')
  add(90, 'nether_portal'); add(91, 'jack_o_lantern'); add(92, 'cake')
  add(98, 'stone_bricks'); add(101, 'iron_bars'); add(102, 'glass_pane')
  add(103, 'melon'); add(112, 'nether_bricks'); add(113, 'nether_brick_fence')
  add(121, 'end_stone'); add(123, 'redstone_lamp'); add(124, 'redstone_lamp')
  add(129, 'emerald_ore'); add(133, 'emerald_block'); add(137, 'command_block')
  add(138, 'beacon'); add(145, 'anvil'); add(152, 'redstone_block')
  add(153, 'quartz_block'); add(159, 'white_terracotta'); add(170, 'hay_block')
  add(214, 'red_stained_glass'); add(42, 'iron_block')
  add(425, 'dark_oak_fence_gate'); add(426, 'end_crystal')
  return t
}

// ---------------------------------------------------------------- entry

// parse a schematic buffer. format is detected by content, extension wins
// when it is known. returns { ok, schematic } | { ok: false, error }.
async function parseSchematicBuffer (buffer, formatHint) {
  let parsed
  try {
    parsed = await nbt.parse(buffer)
  } catch (e) {
    return { ok: false, error: `not valid nbt: ${String(e.message || e).slice(0, 60)}` }
  }
  const root = simplifyRoot(parsed)

  const tryFormats = []
  if (formatHint === 'litematic' || root.name === 'Litematic') tryFormats.push(parseLitematic, parseSchem, parseLegacySchematic)
  else if (formatHint === 'schem' || (root.name === 'Schematic' && nbtGet(root, 'Palette'))) tryFormats.push(parseSchem, parseLitematic, parseLegacySchematic)
  else if (formatHint === 'schematic' || root.name === 'Schematic') tryFormats.push(parseLegacySchematic, parseSchem, parseLitematic)
  else tryFormats.push(parseLitematic, parseSchem, parseLegacySchematic)

  let lastError = 'unknown schematic format'
  for (const fn of tryFormats) {
    const r = fn(root)
    if (r.ok) return r
    lastError = r.error
  }
  return { ok: false, error: lastError }
}

// load from disk: ./schematics/<name> first, then the bundled library.
// name may include the extension; without one, .litematic/.schem/
// .schematic are tried in order.
async function loadSchematicFile (name) {
  const safe = String(name || '').toLowerCase().replace(/[^a-z0-9_\-./]/g, '')
  if (!safe) return { ok: false, error: 'no schematic name' }
  const exts = /\.(litematic|schem|schematic)$/.test(safe)
    ? ['']
    : ['.litematic', '.schem', '.schematic']
  const dirs = [
    process.cwd() + '/schematics',
    __dirname + '/../../schematics'
  ]
  let lastError = `no schematic named "${safe}"`
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = dir + '/' + safe + ext
      let raw
      try {
        raw = fs.readFileSync(p)
      } catch (e) { continue }
      const hint = (ext || safe).replace('.', '').replace('schematic', 'schematic')
      const r = await parseSchematicBuffer(raw, hint === '' ? null : hint.replace('.', ''))
      if (r.ok) return r
      lastError = r.error
    }
  }
  return { ok: false, error: lastError }
}

module.exports = { parseSchematicBuffer, loadSchematicFile, parseLitematic, parseSchem, parseLegacySchematic }
