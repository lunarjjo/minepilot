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

// an item stack shaped like mineflayer's: name, count, slot, numeric type
function mkItem (name, count, slot) {
  const registry = require('minecraft-data')('1.21.4')
  const meta = registry.itemsByName[name]
  return { name, count: count || 1, slot: slot === undefined ? -1 : slot, type: meta ? meta.id : -1 }
}

// fake container windows — the same surface the station manager touches
// (items/deposit/withdraw for chests, inputItem/putInput/... + progress for
// furnaces, trades for villagers), moving stacks between the bot's
// inventory and the container's storage for real, so tests assert on state
class FakeWindow extends EventEmitter {
  constructor (bot, kind) {
    super()
    this.bot = bot
    this.kind = kind
    this.storage = [] // item stacks
    this.closed = false
    this.progress = 0
    this.fuel = 0
    this.trades = []
    // window layout constants (furnace: slots 0/1/2, player range after)
    this.inventoryStart = 3
    this.inventoryEnd = 39
  }

  close () {
    if (this.closed) return
    this.closed = true
    this.emit('close')
  }

  // real mineflayer windows: items() = the PLAYER range inside the window
  // (LIVE — bot.inventory itself is frozen while the window is open),
  // containerItems() = the container's own slots. the fake mirrors both
  // semantics against the fake bot's live arrays.
  items () { return this.bot.inventory.items() }

  containerItems () { return this.storage.filter(Boolean) }

  deposit (itemType, metadata, count) {
    const stack = this.bot.inventory.items().find((it) => it.type === itemType)
    if (!stack) throw new Error(`no item type ${itemType} to deposit`)
    const move = Math.min(stack.count, count === null ? stack.count : count)
    stack.count -= move
    if (stack.count <= 0) this.bot.removeStack(stack)
    const existing = this.storage.find((it) => it && it.name === stack.name && it.count < 64)
    if (existing) existing.count += move
    else this.storage.push({ ...stack, count: move, slot: this.storage.length })
    this.emit('update')
  }

  withdraw (itemType, metadata, count) {
    const stack = this.storage.find((it) => it && it.type === itemType)
    if (!stack) throw new Error(`no item type ${itemType} in the container`)
    const move = Math.min(stack.count, count === null ? stack.count : count)
    stack.count -= move
    if (stack.count <= 0) this.storage.splice(this.storage.indexOf(stack), 1)
    this.bot.addStack({ ...stack, count: move })
    this.emit('update')
  }

  // ---- furnace surface
  inputItem () { return this.storage.find((s) => s && s.role === 'input') || null }
  fuelItem () { return this.storage.find((s) => s && s.role === 'fuel') || null }
  outputItem () { return this.storage.find((s) => s && s.role === 'output') || null }

  putSlot (role, itemType, count) {
    const stack = this.bot.inventory.items().find((it) => it.type === itemType)
    if (!stack) throw new Error(`no item type ${itemType}`)
    const move = Math.min(stack.count, count)
    stack.count -= move
    if (stack.count <= 0) this.bot.removeStack(stack)
    this.storage = this.storage.filter((s) => !s || s.role !== role)
    this.storage.push({ ...stack, count: move, role })
    this.emit('update')
  }

  takeSlot (role) {
    const it = this.storage.find((s) => s && s.role === role)
    if (!it) throw new Error(`nothing in the ${role} slot`)
    this.storage.splice(this.storage.indexOf(it), 1)
    this.bot.addStack({ name: it.name, count: it.count, type: it.type })
    this.emit('update')
    return it
  }

  putInput (itemType, metadata, count) { return this.putSlot('input', itemType, count) }
  putFuel (itemType, metadata, count) { return this.putSlot('fuel', itemType, count) }
  takeInput () { return this.takeSlot('input') }
  takeFuel () { return this.takeSlot('fuel') }
  takeOutput () { return this.takeSlot('output') }

  // smelt step for tests: consume input + fuel over time, produce output
  smeltTick (outputName) {
    const input = this.inputItem()
    const fuel = this.fuelItem()
    if (!input) { this.progress = 0; this.emit('update'); return }
    if (this.fuel <= 0) {
      if (!fuel) { this.emit('update'); return }
      this.takeSlotSilent('fuel')
      this.fuel = 1
    }
    this.fuel = Math.max(0, this.fuel - 0.1)
    this.progress = Math.min(1, this.progress + 0.25)
    if (this.progress >= 1) {
      this.takeSlotSilent('input')
      this.storage.push({ name: outputName, count: 1, type: -2, role: 'output' })
      this.progress = 0
    }
    this.emit('update')
  }

  takeSlotSilent (role) {
    const it = this.storage.find((s) => s && s.role === role)
    if (it) this.storage.splice(this.storage.indexOf(it), 1)
  }
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

  addStack (stack) {
    const items = this.inventory.items()
    const existing = items.find((it) => it.name === stack.name && it.count + stack.count <= 64)
    if (existing) existing.count += stack.count
    else items.push(stack)
  }

  removeStack (stack) {
    const items = this.inventory.items()
    const i = items.indexOf(stack)
    if (i >= 0) items.splice(i, 1)
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
    // real mineflayer takes a single id, an array or null (any block)
    const wantedIds = matching === null || matching === undefined ? null : new Set(Array.isArray(matching) ? matching : [matching])
    const out = []
    for (const b of this.world.blocks.values()) {
      if (wantedIds && !wantedIds.has(b.id)) continue
      const d = b.position.distanceTo(p)
      if (d <= maxDistance) out.push({ v: b.position, d })
    }
    out.sort((a, b) => a.d - b.d)
    return out.slice(0, count).map((o) => o.v)
  }

  // ---- container windows ------------------------------------------------

  async openChest (block) {
    const w = new FakeWindow(this, 'chest')
    this.chestWindows = this.chestWindows || []
    this.chestWindows.push(w)
    return w
  }

  async openFurnace (block) {
    const w = new FakeWindow(this, 'furnace')
    this.furnaceWindows = this.furnaceWindows || []
    this.furnaceWindows.push(w)
    return w
  }

  async openCraftingTable (block) {
    const w = new FakeWindow(this, 'crafting_table')
    this.tableWindows = this.tableWindows || []
    this.tableWindows.push(w)
    return w
  }

  async openVillager (entity) {
    const w = new FakeWindow(this, 'villager')
    w.trades = (entity && entity.trades) || []
    this.villagerWindows = this.villagerWindows || []
    this.villagerWindows.push(w)
    return w
  }

  async trade (villagerWindow, index, times) {
    const tr = (villagerWindow.trades || [])[index]
    if (!tr) throw new Error(`no trade ${index}`)
    for (let i = 0; i < (times || 1); i++) {
      const pay = (item) => {
        const stack = this.inventory.items().find((it) => it.name === item.name && it.count >= item.count)
        if (!stack) throw new Error(`missing ${item.count} ${item.name}`)
        stack.count -= item.count
        if (stack.count <= 0) this.removeStack(stack)
      }
      pay(tr.inputItem1)
      if (tr.inputItem2) pay(tr.inputItem2)
      this.addStack({ ...tr.outputItem })
    }
    villagerWindow.emit('update')
  }

  // the click-out/click-in primitive the station manager uses for furnace
  // takes (mirrors mineflayer's bot.transfer for the furnace slot layout)
  async transfer (options) {
    const w = options.window
    const slot = options.sourceStart
    const roles = ['input', 'fuel', 'output']
    if (w.kind !== 'furnace' || !Number.isInteger(slot) || slot < 0 || slot > 2) {
      throw new Error('fake transfer only handles furnace slots 0-2')
    }
    return w.takeSlot(roles[slot])
  }

  // ---- entity + block interactions ---------------------------------

  async activateEntity (entity) {
    this.activatedEntities = this.activatedEntities || []
    this.activatedEntities.push(entity.name || entity.type || String(entity.id))
    // feeding consumes one unit of the held item, the way a server does
    if (this.heldItem) {
      const items = this.inventory.items()
      const stack = items.find((it) => it.name === this.heldItem.name)
      if (stack) {
        stack.count -= 1
        if (stack.count <= 0) this.removeStack(stack)
      }
    }
    return true
  }

  async activateBlock (block) {
    this.activatedBlocks = this.activatedBlocks || []
    this.activatedBlocks.push(block.name)
    return true
  }

  async sleep (bedBlock) {
    this.isSleeping = true
    this.emit('sleep')
    return true
  }

  async wake () {
    if (!this.isSleeping) throw new Error('not sleeping')
    this.isSleeping = false
    return true
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

module.exports = { FakeBot, VoxelWorld, mcData, makeBlock, mkItem, FakeWindow }
