'use strict'

// schematic parsing — every supported format round-trips into the
// blueprint shape the builder consumes. fixtures are written with
// prismarine-nbt itself (little-endian gzip for litematic/schem, big
// endian gzip for legacy), exactly how the real tools save them.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const zlib = require('zlib')
const nbt = require('prismarine-nbt')

const { parseSchematicBuffer, loadSchematicFile } = require('../src/util/schematics')
const { loadExplorefilter, parseChunkList } = require('../src/util/explorefilter')

function gz (buf) {
  return zlib.gzipSync(buf)
}

function writeTmp (name, buffer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minepilot-schem-'))
  const file = path.join(dir, name)
  fs.writeFileSync(file, buffer)
  return file
}

// ---------------------------------------------------------------- litematic

// a minimal little-endian nbt writer for fixtures — prismarine-nbt's own
// writer mangles lists of compounds, so the fixtures are serialized by
// hand (compound / string / int / longArray / list-of-compound only).
function u16 (v) {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(v)
  return b
}

function i32 (v) {
  const b = Buffer.alloc(4)
  b.writeInt32LE(v)
  return b
}

function i64 (v) {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(BigInt.asUintN(64, BigInt(v)))
  return b
}

function nbtString (name, value) {
  const s = Buffer.from(value, 'utf8')
  return Buffer.concat([Buffer.from([8]), u16(Buffer.byteLength(name)), Buffer.from(name), u16(s.length), s])
}

function nbtInt (name, value) {
  return Buffer.concat([Buffer.from([3]), u16(Buffer.byteLength(name)), Buffer.from(name), i32(value)])
}

function nbtLongArray (name, longs) {
  const parts = [Buffer.from([12]), u16(Buffer.byteLength(name)), Buffer.from(name), i32(longs.length)]
  for (const l of longs) parts.push(i64(l))
  return Buffer.concat(parts)
}

function nbtCompoundPayload (entries) {
  return Buffer.concat([...entries, Buffer.from([0])])
}

function nbtNamedCompound (name, entries) {
  return Buffer.concat([Buffer.from([10]), u16(Buffer.byteLength(name)), Buffer.from(name), nbtCompoundPayload(entries)])
}

function nbtListOfCompounds (name, compounds) {
  // each entry is a compound payload (nameless)
  const parts = [Buffer.from([9]), u16(Buffer.byteLength(name)), Buffer.from(name), Buffer.from([10]), i32(compounds.length)]
  for (const c of compounds) parts.push(nbtCompoundPayload(c))
  return Buffer.concat(parts)
}

function buildLitematic (blocks, dims) {
  // blocks: array of names, index = (y * dims.z + z) * dims.x + x (litematica order)
  const palette = [...new Set(['air', ...blocks])]
  const bits = Math.max(2, (palette.length - 1).toString(2).length)
  const perLong = Math.floor(64 / bits)
  const longs = []
  let packed = 0n
  let used = 0
  for (const b of blocks) {
    const pi = palette.indexOf(b)
    packed |= BigInt(pi) << BigInt(used * bits)
    used++
    if (used === perLong) {
      longs.push(packed)
      packed = 0n
      used = 0
    }
  }
  if (used > 0) longs.push(packed)

  const region = [
    nbtInt('x', dims.x), nbtInt('y', dims.y), nbtInt('z', dims.z)
  ]
  const sizeEntry = nbtNamedCompound('Size', region)
  const paletteEntry = nbtListOfCompounds('BlockStatePalette',
    palette.map((name) => [nbtString('Name', name)]))
  const statesEntry = nbtLongArray('BlockStates', longs)

  const metadata = nbtNamedCompound('Metadata', [
    nbtString('Name', 'testbuild'),
    nbtNamedCompound('EnclosingSize', [
      nbtInt('x', dims.x), nbtInt('y', dims.y), nbtInt('z', dims.z)
    ])
  ])
  const regions = nbtNamedCompound('Regions', [
    nbtNamedCompound('Main', [sizeEntry, paletteEntry, statesEntry])
  ])

  const root = nbtNamedCompound('Litematic', [metadata, regions, nbtInt('Version', 5)])
  return gz(root)
}

test('schematics: litematic round-trips with palette packing', async () => {
  // 3x1x2 (x=3, y=1, z=2): a tiny hut wall
  const dims = { x: 3, y: 1, z: 2 }
  const blocks = ['stone', 'stone', 'stone', 'air', 'air', 'air']
  const buffer = buildLitematic(blocks, dims)
  const r = await parseSchematicBuffer(buffer, 'litematic')
  assert.strictEqual(r.ok, true, r.error)
  assert.strictEqual(r.schematic.name, 'testbuild')
  assert.strictEqual(r.schematic.placements.length, 3)
  assert.ok(r.schematic.placements.every((p) => p.block === 'stone'))
  // index order: x fastest, then z, then y — first row is z=0
  assert.deepStrictEqual(r.schematic.placements.map((p) => [p.x, p.y, p.z]).sort(),
    [[0, 0, 0], [1, 0, 0], [2, 0, 0]])
})

test('schematics: litematic with a rich palette uses wider packing', async () => {
  const dims = { x: 4, y: 1, z: 1 }
  const blocks = ['stone', 'dirt', 'glass', 'oak_planks']
  const buffer = buildLitematic(blocks, dims)
  const r = await parseSchematicBuffer(buffer, 'litematic')
  assert.strictEqual(r.ok, true, r.error)
  assert.deepStrictEqual(r.schematic.placements.map((p) => p.block).sort(),
    ['dirt', 'glass', 'oak_planks', 'stone'])
})

// ---------------------------------------------------------------- sponge .schem

function buildSchem (blocks, dims) {
  const palette = [...new Set(['air', ...blocks])]
  if (palette.length > 256) throw new Error('fixture too rich')
  const ids = new Map(palette.map((name, i) => [name, i]))
  const data = Buffer.from(blocks.map((b) => ids.get(b)))
  const root = nbt.comp({
    Version: nbt.int(2),
    DataVersion: nbt.int(3700),
    Width: nbt.short(dims.x),
    Height: nbt.short(dims.y),
    Length: nbt.short(dims.z),
    Palette: nbt.comp(Object.fromEntries(palette.map((name, i) => ['minecraft:' + name, nbt.int(i)]))),
    BlockData: nbt.byteArray(data)
  })
  return gz(nbt.writeUncompressed({ ...root, name: 'Schematic' }, 'little'))
}

test('schematics: sponge .schem round-trips', async () => {
  const dims = { x: 2, y: 2, z: 1 }
  const blocks = ['cobblestone', 'air', 'glass', 'air']
  const buffer = buildSchem(blocks, dims)
  const r = await parseSchematicBuffer(buffer, 'schem')
  assert.strictEqual(r.ok, true, r.error)
  assert.strictEqual(r.schematic.placements.length, 2)
  assert.deepStrictEqual(r.schematic.placements.find((p) => p.block === 'cobblestone'), { x: 0, y: 0, z: 0, block: 'cobblestone' })
  assert.deepStrictEqual(r.schematic.placements.find((p) => p.block === 'glass'), { x: 0, y: 1, z: 0, block: 'glass' })
})

// ---------------------------------------------------------------- legacy .schematic

function buildLegacy (blocks, dims) {
  const LEGACY = { stone: 1, glass: 20, cobblestone: 4, dirt: 3, air: 0 }
  const root = nbt.comp({
    Width: nbt.short(dims.x),
    Height: nbt.short(dims.y),
    Length: nbt.short(dims.z),
    Blocks: nbt.byteArray(Buffer.from(blocks.map((b) => LEGACY[b] ?? 0))),
    Data: nbt.byteArray(Buffer.from(blocks.map(() => 0)))
  })
  return gz(nbt.writeUncompressed({ ...root, name: 'Schematic' }, 'big'))
}

test('schematics: legacy mcedit .schematic round-trips', async () => {
  const dims = { x: 3, y: 1, z: 1 }
  const blocks = ['stone', 'glass', 'air']
  const buffer = buildLegacy(blocks, dims)
  const r = await parseSchematicBuffer(buffer, 'schematic')
  assert.strictEqual(r.ok, true, r.error)
  assert.strictEqual(r.schematic.placements.length, 2)
  assert.deepStrictEqual(r.schematic.placements.map((p) => p.block).sort(), ['glass', 'stone'])
})

// ---------------------------------------------------------------- file loading

test('schematics: loadSchematicFile finds files by name with and without extension', async () => {
  const buffer = buildSchem(['stone', 'dirt'], { x: 2, y: 1, z: 1 })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minepilot-sch-'))
  const schematicsDir = path.join(dir, 'schematics')
  fs.mkdirSync(schematicsDir)
  fs.writeFileSync(path.join(schematicsDir, 'tiny.schem'), buffer)
  const cwd = process.cwd()
  process.chdir(dir)
  try {
    const withExt = await loadSchematicFile('tiny.schem')
    assert.strictEqual(withExt.ok, true, withExt.error)
    assert.strictEqual(withExt.schematic.placements.length, 2)
    const withoutExt = await loadSchematicFile('tiny')
    assert.strictEqual(withoutExt.ok, true, withoutExt.error)
    const missing = await loadSchematicFile('nope')
    assert.strictEqual(missing.ok, false)
  } finally {
    process.chdir(cwd)
  }
})

test('schematics: garbage input is rejected honestly', async () => {
  const r = await parseSchematicBuffer(Buffer.from('this is not nbt at all'))
  assert.strictEqual(r.ok, false)
  assert.ok(r.error.includes('not valid nbt'))
})

// ---------------------------------------------------------------- explorefilter

test('explorefilter: chunk lists parse in every accepted shape', () => {
  let r = parseChunkList(['1,2', '-3,4'])
  assert.strictEqual(r.ok, true)
  assert.deepStrictEqual(r.chunks, [[1, 2], [-3, 4]])
  r = parseChunkList({ chunks: ['0,0'] })
  assert.strictEqual(r.ok, true)
  assert.deepStrictEqual(r.chunks, [[0, 0]])
  r = parseChunkList({ x: [5, -5], z: [6, -6] })
  assert.strictEqual(r.ok, true)
  assert.deepStrictEqual(r.chunks, [[5, 6], [-5, -6]])
  assert.strictEqual(parseChunkList(['not a chunk']).ok, false)
  assert.strictEqual(parseChunkList({ x: [1], z: [1, 2] }).ok, false)
  assert.strictEqual(parseChunkList('nope').ok, false)
})

test('explorefilter: files load and filter correctly with invert', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minepilot-ef-'))
  const file = path.join(dir, 'filter.json')
  fs.writeFileSync(file, JSON.stringify({ chunks: ['0,0', '1,0'] }))
  const cwd = process.cwd()
  process.chdir(dir)
  try {
    const r = loadExplorefilter('filter.json', false)
    assert.strictEqual(r.ok, true, r.error)
    assert.strictEqual(r.count, 2)
    assert.strictEqual(r.filter(0, 0), false, 'listed chunks are skipped')
    assert.strictEqual(r.filter(2, 0), true, 'everything else is allowed')
    const inv = loadExplorefilter('filter.json', true)
    assert.strictEqual(inv.filter(0, 0), true, 'inverted: only listed chunks')
    assert.strictEqual(inv.filter(2, 0), false)
    const missing = loadExplorefilter('missing.json', false)
    assert.strictEqual(missing.ok, false)
  } finally {
    process.chdir(cwd)
  }
})

// ---------------------------------------------------------------- farm origin

test('farm: waypoint origin centers the scan instead of the bot', () => {
  const { Vec3 } = require('vec3')
  const { FakeBot, VoxelWorld } = require('./helpers/fake')
  const { createDefaultSettings } = require('../src/settings')
  const { Autopilot } = require('../src/autopilot')
  const { scan } = require('../src/processes/farm')

  const w = new VoxelWorld()
  w.fill(-30, 58, -30, 30, 63, 30, 'grass_block')
  w.fill(-30, 64, -30, 30, 70, 30, 'air')
  // mature wheat far away from the bot, near the waypoint
  w.setBlock(20, 64, 20, 'wheat')
  const block = w.blockAtXYZ(20, 64, 20)
  block.properties = { age: '7' }
  const bot = new FakeBot({ username: 'F', version: '1.21.4' }, w)
  bot.spawnAt(0, 64, 0)
  const settings = createDefaultSettings()
  const pilot = new Autopilot({ bot, deps: { Vec3 }, settings })

  // without origin, radius 10 from the bot: nothing (the crop is ~28 away)
  const fromBot = scan(pilot, 10, null)
  assert.strictEqual(fromBot.length, 0)
  // with the waypoint origin at the crop: found
  const fromWaypoint = scan(pilot, 10, { x: 20, y: 64, z: 20 })
  assert.strictEqual(fromWaypoint.length, 1)
  bot.disposePhysics()
})
