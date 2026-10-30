'use strict'

// a kinematic fake mineflayer bot + voxel world for offline testing of the
// pilot engine. the fake implements exactly the surface the executor and
// the world view touch (look, controls, dig, placeBlock, findBlocks,
// world.getBlock, entity with position/velocity/yaw), with a 20 Hz physics
// approximation: gravity, ground collision, jump arc, blocked horizontal
// movement until the feet clear the obstacle, water buoyancy, ladders.
// real physics correctness is proven by the live suite against a genuine
// vanilla server; this fake proves the DECISIONS are right, fast.

const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')
const mcData = require('minecraft-data')('1.21.4')
const { NON_SOLID, CLIMBABLE } = require('../../src/engine/world')

const AIR_LIKE = new Set(['air', 'cave_air', 'void_air', 'light'])

function defaultBox (name) {
  if (AIR_LIKE.has(name)) return 'empty'
  if (NON_SOLID.has(name)) return 'empty'
  return 'full'
}

function makeBlock (name, x, y, z, registry, box, properties) {
  const meta = registry.blocksByName[name]
  const block = {
    name,
    id: meta ? meta.id : -1,
    hardness: meta && Number.isFinite(meta.hardness) ? meta.hardness : 1,
    boundingBox: box || defaultBox(name),
    position: new Vec3(x, y, z)
  }
  if (properties) block.properties = properties
  return block
}

class VoxelWorld {
  constructor (registry) {
    this.registry = registry || mcData
    this.blocks = new Map()
  }

  static key (x, y, z) {
    return x + ',' + y + ',' + z
  }

  setBlock (x, y, z, name, box, properties) {
    this.blocks.set(VoxelWorld.key(x, y, z), makeBlock(name, x, y, z, this.registry, box, properties))
    return this
  }

  removeBlock (x, y, z) {
    // a dug cell in a loaded chunk reads back as air, the way a real
    // server reports it — never as an unknown/null cell
    this.blocks.set(VoxelWorld.key(x, y, z), makeBlock('air', x, y, z, this.registry))
    return this
  }

  fill (x0, y0, z0, x1, y1, z1, name, box) {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        for (let z = z0; z <= z1; z++) this.setBlock(x, y, z, name, box)
      }
    }
    return this
  }

  // classic test scenario: a grass floor at floorY, air above it
  ground (x0, z0, x1, z1, floorY = 63, name = 'grass_block') {
    this.fill(x0, floorY, z0, x1, floorY, z1, name)
    this.fill(x0, floorY + 1, z0, x1, floorY + 8, z1, 'air')
    return this
  }

  getBlock (v) {
    return this.blocks.get(VoxelWorld.key(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z))) || null
  }

  blockAtXYZ (x, y, z) {
    return this.blocks.get(VoxelWorld.key(x, y, z)) || null
  }
}

// items that plant a crop when placed on soil — the server decides the
// resulting block in real minecraft; the fake mirrors that mapping
const SEED_BLOCKS = {
  wheat_seeds: 'wheat',
  carrot: 'carrots',
  potato: 'potatoes',
  beetroot_seeds: 'beetroots',
  nether_wart: 'nether_wart'
}

class FakeBot extends EventEmitter {
  constructor (opts, world) {
    super()
    this.username = opts.username
    this.options = opts
    this.world = world || new VoxelWorld()
    this.registry = this.world.registry
    this.entity = null
    this.players = {}
    this.entities = {}
    this.health = null
    this.food = null
    this.version = '1.21.4'
    this.chats = []
    this.quitCalled = false
    this.inventory = { items: () => [] }
    this.heldItem = null
    this.equips = []
    this.controls = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }
    this.looks = []
    this.digs = []
    this.physicsTimer = setInterval(() => this.physicsTick(0.05), 50)
    // never let a forgotten fake bot hold the test process open
    if (this.physicsTimer.unref) this.physicsTimer.unref()
    this.on('end', () => this.disposePhysics())
  }

  // ---- api surface -----------------------------------------------------

  blockAt (v) {
    return this.world.getBlock(v)
  }

  chat (msg) { this.chats.push(msg) }

  setInventory (items) {
    this.inventory.items = () => items
  }

  async equip (item) {
    this.equips.push(item ? item.name : null)
    this.heldItem = item
    return true
  }

  quit () {
    this.quitCalled = true
    this.disposePhysics()
    this.emit('end')
  }

  disposePhysics () {
    if (this.physicsTimer) clearInterval(this.physicsTimer)
    this.physicsTimer = null
  }

  spawnAt (x, y, z) {
    this.entity = {
      position: new Vec3(x, y, z),
      velocity: new Vec3(0, 0, 0),
      yaw: 0,
      pitch: 0
    }
    this.health = 20
    this.food = 20
    this.emit('spawn')
  }

  setControlState (key, on) {
    this.controls[key] = !!on
  }

  clearControlStates () {
    for (const k of Object.keys(this.controls)) this.controls[k] = false
  }

  look (yaw, pitch) {
    if (this.entity) {
      this.entity.yaw = yaw
      this.entity.pitch = pitch
    }
    this.looks.push([+Number(yaw).toFixed(2), +Number(pitch || 0).toFixed(2)])
  }

  lookAt (v) {
    const p = this.entity.position
    const dx = v.x - p.x
    const dz = v.z - p.z
    const dy = v.y - (p.y + 1.6)
    const horz = Math.sqrt(dx * dx + dz * dz)
    this.look(Math.atan2(-dx, dz), Math.atan2(dy, horz))
  }

  async dig (block) {
    this.digs.push(block.name)
    await new Promise((r) => setTimeout(r, 60))
    this.world.removeBlock(block.position.x, block.position.y, block.position.z)
  }

  async placeBlock (ref, face) {
    // the held item decides what lands in the world, like a real bot;
    // seeds plant crops, non-block items (or an empty hand) fall back to stone
    let held = null
    if (this.heldItem) {
      held = SEED_BLOCKS[this.heldItem.name] ||
        (this.registry.blocksByName[this.heldItem.name] ? this.heldItem.name : null)
    }
    this.world.setBlock(
      ref.position.x + face.x,
      ref.position.y + face.y,
      ref.position.z + face.z,
      held || 'stone'
    )
    return true
  }

  findBlocks ({ matching, maxDistance = 64, count = 16 }) {
    const p = this.entity ? this.entity.position : new Vec3(0, 64, 0)
    const wantedIds = new Set(matching)
    const out = []
    for (const b of this.world.blocks.values()) {
      if (!wantedIds.has(b.id)) continue
      const d = b.position.distanceTo(p)
      if (d <= maxDistance) out.push({ v: b.position, d })
    }
    out.sort((a, b) => a.d - b.d)
    return out.slice(0, count).map((o) => o.v)
  }

  // ---- kinematics ------------------------------------------------------

  blockNameAt (x, y, z) {
    const b = this.world.blockAtXYZ(Math.floor(x), Math.floor(y), Math.floor(z))
    return b ? b.name : null
  }

  solidAt (x, y, z) {
    const b = this.world.blockAtXYZ(Math.floor(x), Math.floor(y), Math.floor(z))
    return !!b && b.boundingBox === 'full'
  }

  groundBelow (p) {
    const x = Math.floor(p.x)
    const z = Math.floor(p.z)
    const start = Math.floor(p.y)
    for (let y = start; y >= start - 8; y--) {
      const b = this.world.blockAtXYZ(x, y, z)
      if (b && b.boundingBox !== 'empty' && !NON_SOLID.has(b.name)) return y + 1
    }
    return null
  }

  physicsTick (dt) {
    const e = this.entity
    if (!e) return
    const p = e.position
    const c = this.controls

    const feetName = this.blockNameAt(p.x, p.y + 0.1, p.z)
    const inWater = feetName === 'water'
    const onLadder = CLIMBABLE.has(feetName)

    let vy = e.velocity.y
    const ground = this.groundBelow(p)
    const onGround = ground !== null && p.y <= ground + 0.01

    if (inWater) {
      vy = c.jump ? 2.0 : 0.0
      // pushing forward against a bank while jumping: hop out of the water
      if (c.jump && c.forward) {
        const fx = p.x - Math.sin(e.yaw) * 0.45
        const fz = p.z - Math.cos(e.yaw) * 0.45
        if (this.solidAt(fx, p.y - 0.1, fz) || this.solidAt(fx, p.y + 0.1, fz)) {
          vy = 8.5
        }
      }
    } else if (onLadder) {
      vy = (c.jump || c.forward) ? 2.2 : Math.max(-2.2, vy - 8 * dt)
    } else if (c.jump && onGround) {
      vy = 8.5
    } else {
      vy = Math.max(-45, vy - 32 * dt)
    }

    const speed = inWater ? 2.2 : (c.sprint ? 5.6 : 4.3)
    if (c.forward) {
      // matches mineflayer's yaw convention: facing = (-sin(yaw), -cos(yaw))
      const dx = -Math.sin(e.yaw) * speed * dt
      const dz = -Math.cos(e.yaw) * speed * dt
      const nx = p.x + dx
      const nz = p.z + dz
      const blockedLow = this.solidAt(nx, p.y + 0.1, nz)
      const blockedHigh = this.solidAt(nx, p.y + 1.1, nz)
      if (!blockedLow && !blockedHigh) {
        p.x = nx
        p.z = nz
      }
    }

    let ny = p.y + vy * dt
    if (vy <= 0 && !inWater && !onLadder) {
      const g = this.groundBelow({ x: p.x, y: ny, z: p.z })
      if (g !== null && ny <= g) {
        ny = g
        vy = 0
      }
    }
    if (ny < -64) {
      ny = -64
      vy = 0
    }
    p.x = +p.x.toFixed(4)
    p.y = +ny.toFixed(4)
    p.z = +p.z.toFixed(4)
    e.velocity.x = 0
    e.velocity.y = vy
    e.velocity.z = 0
  }
}

module.exports = { FakeBot, VoxelWorld, mcData, makeBlock }
