'use strict'

// version-compat: keeps botfleet current with new Minecraft releases even
// before the upstream prismarine stack ships protocol data for them.
//
//   1. vendored protocol/registry data for pending versions lives in
//      ./data/pc/<version>/ (see ./data/README.md for provenance)
//   2. ensureVersionSupport() registers any vendored version the installed
//      minecraft-data does not know yet, and applies the runtime patches the
//      prismarine stack needs to accept it (version gates, chunk dispatch,
//      physics features, the 26.3 entityDelta native type)
//   3. applyClientCompat(bot) wraps the bot's outgoing packets with the
//      behavioral fixes each version needs (26.3: teleport echo, tick_end,
//      dig status shift) and translates incoming entity-movement packets
//      (VecDelta / stepped PositionPath) into the shapes mineflayer consumes
//
// the overlay self-disables per version: once the installed minecraft-data
// ships a version natively, the vendored copy is skipped entirely. real.js
// requires this module before mineflayer so every bot creation path is
// covered (fleet, tests, examples, BOTS env seeds).

const path = require('path')
const fs = require('fs')

const DATA_ROOT = path.join(__dirname, 'data', 'pc')

// files each vendored version owns; every other data type resolves to the
// shared set below, mirroring upstream dataPaths.json for these versions
const OWN_FILES = {
  '26.2': [
    'attributes', 'blockCollisionShapes', 'blocks', 'blockLoot', 'biomes', 'commands',
    'entities', 'entityLoot', 'foods', 'items', 'language', 'loginPacket', 'materials',
    'particles', 'protocol', 'recipes', 'sounds', 'tints', 'version'
  ],
  '26.3': ['blockCollisionShapes', 'blocks', 'entities', 'foods', 'items', 'protocol', 'recipes', 'version']
}

// data types shared with older versions that the installed minecraft-data
// already ships (same mapping as upstream dataPaths.json for 26.2/26.3)
const SHARED_TYPES = {
  effects: '26.1',
  enchantments: '26.1',
  instruments: '26.1',
  mapIcons: '1.20.2',
  windows: '1.20.3'
}

// versions whose vendored files another vendored version borrows for the
// non-shared types it does not own (26.3 maps most registries to pc/26.2)
const BORROWS = { '26.3': '26.2' }

// the version whose chunk implementation and physics feature set the
// overlaid versions reuse (the wire formats are identical there)
const BASE_VERSION = '26.1'

// behavioral fixes per version, discovered by live-testing against real
// vanilla servers (26.3 changes are documented in minecraft-data PR #1301
// and node-minecraft-protocol PR #1538):
//   teleportConfirmEcho — serverbound teleport_confirm must echo the
//     position+rotation the server teleported us to
//   clientTickEnd — the server rejects the second position-bearing packet
//     unless an empty tick_end follows each client tick
//   playerActionShift — block_dig status enum gained CHANGE_DESTROY_DIRECTION
//     at id 1, so abort/finish moved from 1/2 to 2/3
//   entityDeltaPackets — rel_entity_move / entity_move_look carry the new
//     VecDelta encoding and sync_entity_position a stepped PositionPath;
//     both are translated back to the flat shapes mineflayer understands
const BEHAVIORS = {
  '26.3': { teleportConfirmEcho: true, clientTickEnd: true, playerActionShift: true, entityDeltaPackets: true }
}

const MOVEMENT_PACKETS = ['position', 'position_look', 'look', 'flying']
const DEBUG = process.env.BOTFLEET_COMPAT_DEBUG === '1'
const ENTITY_MOVE_PACKETS = ['rel_entity_move', 'entity_move_look', 'sync_entity_position']

let ensured = false
let injected = [] // versions this process actually injected
let nativeSnapshot = null // versions the installed minecraft-data ships on its own

function ownFilesFor (version) {
  return OWN_FILES[version] || []
}

function vendoredDir (version) {
  return path.join(DATA_ROOT, version)
}

// ---- version resolution / injection ------------------------------------

function officialData () {
  return require('minecraft-data/data.js')
}

function snapshotNatives () {
  if (nativeSnapshot === null) {
    nativeSnapshot = new Set(Object.keys(officialData().pc))
  }
  return nativeSnapshot
}

function isNativelySupported (version) {
  // measured against the pre-injection snapshot: once the overlay has
  // registered a version, data.pc[version] exists but is NOT official
  if (nativeSnapshot !== null) return nativeSnapshot.has(version)
  return Boolean(officialData().pc[version])
}

function hasVendoredData (version) {
  try {
    return fs.existsSync(path.join(vendoredDir(version), 'protocol.json'))
  } catch (e) {
    return false
  }
}

function buildVersionEntry (version) {
  const data = officialData()
  const entry = {}
  const borrowFrom = BORROWS[version]
  const addFile = (key, file) => {
    Object.defineProperty(entry, key, {
      enumerable: true,
      get () { return require(file) }
    })
  }
  for (const key of ownFilesFor(version)) {
    addFile(key, path.join(vendoredDir(version), `${key}.json`))
  }
  if (borrowFrom && hasVendoredData(borrowFrom)) {
    for (const key of ownFilesFor(borrowFrom)) {
      if (!(key in entry)) addFile(key, path.join(vendoredDir(borrowFrom), `${key}.json`))
    }
  }
  for (const [key, officialVersion] of Object.entries(SHARED_TYPES)) {
    Object.defineProperty(entry, key, {
      enumerable: true,
      get () { return data.pc[officialVersion][key] }
    })
  }
  return entry
}

// ---- runtime patches for the prismarine stack ---------------------------

function patchVersionLists (versions) {
  const mfVersion = require('mineflayer/lib/version.js')
  for (const v of versions) {
    if (!mfVersion.testedVersions.includes(v)) mfVersion.testedVersions.push(v)
  }
  mfVersion.latestSupportedVersion = versions[versions.length - 1]
  // informational lists — docs/tests read these; keep them honest
  const protoVersion = require('minecraft-protocol/src/version.js')
  for (const v of versions) {
    if (!protoVersion.supportedVersions.includes(v)) protoVersion.supportedVersions.push(v)
  }
  const mcDataIndex = require('minecraft-data')
  const sv = mcDataIndex.supportedVersions.pc
  for (const v of versions) if (!sv.includes(v)) sv.push(v)
}

function patchPrismarineChunk (versions) {
  const resolved = require.resolve('prismarine-chunk')
  const real = require(resolved)
  const wrapped = function (registryOrVersion) {
    if (registryOrVersion && typeof registryOrVersion === 'object' && registryOrVersion.version) {
      if (versions.includes(registryOrVersion.version.majorVersion)) {
        const shim = Object.create(registryOrVersion)
        const versionShim = Object.create(registryOrVersion.version)
        versionShim.majorVersion = BASE_VERSION
        shim.version = versionShim
        return real(shim)
      }
    }
    return real(registryOrVersion)
  }
  Object.assign(wrapped, real)
  require.cache[resolved].exports = wrapped
}

function patchPrismarinePhysics (versions) {
  const features = require('prismarine-physics/lib/features.json')
  for (const f of features) {
    if (Array.isArray(f.versions) && f.versions.includes(BASE_VERSION)) {
      for (const v of versions) if (!f.versions.includes(v)) f.versions.push(v)
    }
  }
}

// 26.3 replaced the flat 3x i16 relative-entity-move delta with "VecDelta":
// a packed properties varint (bit 0 = onGround, bits 1+ = stepCount) followed
// by either the old flat 3x i16 (stepCount <= 0) or stepCount chained
// {ticks: varint, dX/dY/dZ: i16} entries. mirrors node-minecraft-protocol PR #1538.
function patchEntityDelta () {
  const [readVarInt, writeVarInt, sizeOfVarInt] = require('protodef').types.varint
  const PartialReadError = require('protodef').utils.PartialReadError

  function readEntityDelta (buffer, offset) {
    let cursor = offset
    const props = readVarInt(buffer, cursor)
    cursor += props.size
    const onGround = (props.value & 1) !== 0
    const stepCount = props.value >>> 1
    const steps = []
    if (stepCount <= 0) {
      if (cursor + 6 > buffer.length) throw new PartialReadError('unexpected end while reading entityDelta (linear)')
      steps.push({ dX: buffer.readInt16BE(cursor), dY: buffer.readInt16BE(cursor + 2), dZ: buffer.readInt16BE(cursor + 4), ticks: 0 })
      cursor += 6
    } else {
      for (let i = 0; i < stepCount; i++) {
        const ticksResult = readVarInt(buffer, cursor)
        cursor += ticksResult.size
        if (cursor + 6 > buffer.length) throw new PartialReadError('unexpected end while reading entityDelta (stepped)')
        steps.push({ dX: buffer.readInt16BE(cursor), dY: buffer.readInt16BE(cursor + 2), dZ: buffer.readInt16BE(cursor + 4), ticks: ticksResult.value })
        cursor += 6
      }
    }
    return { value: { onGround, steps }, size: cursor - offset }
  }

  function writeEntityDelta (value, buffer, offset) {
    const { onGround, steps } = value
    const useLinear = steps.length === 1 && steps[0].ticks === 0
    const stepCount = useLinear ? 0 : steps.length
    const properties = (onGround ? 1 : 0) | (stepCount << 1)
    offset = writeVarInt(properties, buffer, offset)
    if (useLinear) {
      buffer.writeInt16BE(steps[0].dX, offset)
      buffer.writeInt16BE(steps[0].dY, offset + 2)
      buffer.writeInt16BE(steps[0].dZ, offset + 4)
      offset += 6
    } else {
      for (const step of steps) {
        offset = writeVarInt(step.ticks, buffer, offset)
        buffer.writeInt16BE(step.dX, offset)
        buffer.writeInt16BE(step.dY, offset + 2)
        buffer.writeInt16BE(step.dZ, offset + 4)
        offset += 6
      }
    }
    return offset
  }

  function sizeOfEntityDelta (value) {
    const { onGround, steps } = value
    const useLinear = steps.length === 1 && steps[0].ticks === 0
    const stepCount = useLinear ? 0 : steps.length
    const properties = (onGround ? 1 : 0) | (stepCount << 1)
    let size = sizeOfVarInt(properties)
    if (useLinear) size += 6
    else for (const step of steps) size += sizeOfVarInt(step.ticks) + 6
    return size
  }

  const mcTypes = require('minecraft-protocol/src/datatypes/minecraft.js')
  if (mcTypes.entityDelta) return
  mcTypes.entityDelta = [readEntityDelta, writeEntityDelta, sizeOfEntityDelta]
  const compilerMc = require('minecraft-protocol/src/datatypes/compiler-minecraft.js')
  compilerMc.Read.entityDelta = ['native', readEntityDelta]
  compilerMc.Write.entityDelta = ['native', writeEntityDelta]
  compilerMc.SizeOf.entityDelta = ['native', sizeOfEntityDelta]
}

// ---- incoming packet translation ----------------------------------------

// flattens the 26.3 VecDelta ({onGround, steps[]}) into the cumulative
// dX/dY/dZ mineflayer's entity tracker consumes. interpolation timing is
// lost, the final position is exact.
function flattenEntityDelta (packet) {
  const move = packet.move
  if (!move || !Array.isArray(move.steps)) return packet
  let dX = 0
  let dY = 0
  let dZ = 0
  for (const s of move.steps) {
    dX += s.dX
    dY += s.dY
    dZ += s.dZ
  }
  const out = { ...packet, dX, dY, dZ, onGround: move.onGround }
  delete out.move
  return out
}

// 26.3's sync_entity_position switched to a PositionPath: "linear" keeps the
// flat x/y/z, "stepped" carries interpolation steps and NO x/y/z at all —
// which would leave mineflayer positioning entities at Vec3(undefined).
// the final step is the destination; velocity fields were dropped in 26.3
// and are zeroed so entity.velocity stays a number.
function flattenSyncPosition (packet) {
  if (packet.positionType === 'stepped' && Array.isArray(packet.steps) && packet.steps.length > 0) {
    const last = packet.steps[packet.steps.length - 1]
    const out = { ...packet, x: last.x, y: last.y, z: last.z, dx: 0, dy: 0, dz: 0 }
    delete out.steps
    return out
  }
  if (packet.positionType === 'linear' && packet.x !== undefined && packet.dx === undefined) {
    return { ...packet, dx: 0, dy: 0, dz: 0 }
  }
  return packet
}

// ---- public api ----------------------------------------------------------

function ensureVersionSupport () {
  if (ensured) return injected
  ensured = true
  snapshotNatives() // freeze what "official" means before we touch anything
  const data = officialData()
  const pending = []
  for (const version of Object.keys(OWN_FILES)) {
    if (!isNativelySupported(version) && hasVendoredData(version)) pending.push(version)
  }
  if (pending.length === 0) return injected
  // numeric-aware sort so 26.10 would still land after 26.3
  pending.sort((a, b) => a.split('.').map(Number)[1] - b.split('.').map(Number)[1])
  for (const version of pending) {
    data.pc[version] = buildVersionEntry(version)
    injected.push(version)
  }
  patchVersionLists(pending)
  patchPrismarineChunk(pending)
  patchPrismarinePhysics(pending)
  patchEntityDelta()
  return injected
}

function behaviorsFor (version) {
  return BEHAVIORS[version] || {}
}

// wraps a bot's outgoing packets with the behavioral fixes its version needs.
// call right after createBot; works with explicit and auto-detected versions.
function applyClientCompat (bot, requestedVersion) {
  let version = requestedVersion
  const conv = require('mineflayer/lib/conversions.js')
  const client = bot._client
  const origWrite = client.write.bind(client)
  client.write = function (name, params) {
    if (!version && client.version) version = String(client.version)
    const be = version ? behaviorsFor(version) : {}
    if (params && typeof params === 'object') {
      if (be.teleportConfirmEcho && name === 'teleport_confirm' && params.x === undefined && bot.entity) {
        const p = bot.entity.position
        params = {
          ...params,
          x: p.x,
          y: p.y,
          z: p.z,
          yRot: conv.toNotchianYaw(bot.entity.yaw),
          xRot: conv.toNotchianPitch(bot.entity.pitch)
        }
      }
      if (be.playerActionShift && name === 'block_dig' && typeof params.status === 'number') {
        const s = params.status
        params = { ...params, status: s === 1 ? 2 : (s === 2 ? 3 : s) }
      }
    }
    const r = origWrite(name, params)
    if (DEBUG) console.error(`[compat->] v=${version}|cv=${client.version} ${name} ${JSON.stringify(params).slice(0, 220)}`)
    if (be.clientTickEnd && MOVEMENT_PACKETS.includes(name)) {
      origWrite('tick_end', {})
    }
    return r
  }

  // incoming: translate VecDelta / PositionPath packets into the legacy flat
  // shapes before mineflayer's entity plugin sees them. extra emit args
  // (metadata, raw buffers — see the 'packet'/'raw' events) are preserved.
  // the version is only resolved here for entity-move packets: they never
  // arrive before the PLAY state, by which time client.version reflects the
  // negotiated version (early emits fire while it still holds the
  // constructor default, which would pin the closure to the wrong version
  // on the auto-detect path).
  const origEmit = client.emit.bind(client)
  client.emit = function (name, data, ...rest) {
    if (ENTITY_MOVE_PACKETS.includes(name)) {
      if (!version && client.version) version = String(client.version)
      if (version && behaviorsFor(version).entityDeltaPackets && data) {
        if (name === 'sync_entity_position') data = flattenSyncPosition(data)
        else if (data.move) data = flattenEntityDelta(data)
      }
    }
    return origEmit(name, data, ...rest)
  }

  return () => {
    client.write = origWrite
    client.emit = origEmit
  }
}

// which versions this botfleet can drive, and where the support comes from
function supportedVersions () {
  ensureVersionSupport()
  const mcDataIndex = require('minecraft-data')
  // the informational list got our overlay versions pushed into it for
  // honesty; peel them back off for the "official" answer
  const official = mcDataIndex.supportedVersions.pc.filter((v) => !injected.includes(v))
  const overlay = injected.slice()
  return { official, overlay, all: [...new Set([...official, ...overlay])] }
}

module.exports = {
  ensureVersionSupport,
  applyClientCompat,
  supportedVersions,
  behaviorsFor,
  isNativelySupported,
  hasVendoredData,
  OWN_FILES,
  BEHAVIORS,
  BASE_VERSION
}

// self-activate on first require so ordering bugs cannot happen: real.js
// requires this module before mineflayer, and any other entry point gets
// the same guarantee for free
ensureVersionSupport()
