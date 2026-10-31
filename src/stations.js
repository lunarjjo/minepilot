'use strict'

// the station manager — one open workstation at a time, driven from the
// cockpit instead of the command line: chests (deposit/withdraw grids),
// furnaces (input/fuel/output slots with live progress) and villager
// trades. the web console says "open the chest", walks the bot into
// reach, opens the window and streams frames over the cockpit protocol;
// every button in the ui maps to one action here.
//
// crafting has no station of its own: the craft tab walks the same
// `craft <item> <n>` path as the console (which finds a table when the
// recipe needs one), so there is exactly one crafting implementation.

const STATION_BLOCKS = {
  chest: 'chest',
  furnace: 'furnace',
  blast_furnace: 'blast_furnace',
  smoker: 'smoker',
  crafting_table: 'crafting_table'
}

function dist (a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

function itemType (bot, name) {
  const reg = bot.registry
  const meta = reg && reg.itemsByName ? reg.itemsByName[name] : null
  return meta ? meta.id : null
}

function createStationManager (ctx, broadcast, log) {
  const say = log || (() => {})
  let session = null // { kind, pos, window, entityId, closeTimer }
  let busy = false

  function botNow () { return ctx.bot }

  // the bot's inventory, LIVE: while a station window is open,
  // bot.inventory.items() is frozen (mineflayer only syncs the open
  // window's own player range) — the window's items() is the live view.
  // this is what the cockpit's inventory panel must show.
  function botItems () {
    if (session && session.window && typeof session.window.items === 'function') {
      try {
        const live = session.window.items()
        if (live) return live
      } catch (e) { /* fall through */ }
    }
    return (require('./inventory').items)(botNow())
  }

  function frame () {
    if (!session) return { t: 'station', open: false }
    const base = { t: 'station', open: true, kind: session.kind }
    if (session.pos) base.pos = [session.pos.x, session.pos.y, session.pos.z]
    try {
      base.botItems = botItems().map((it) => ({ name: it.name, count: it.count }))
      if (session.kind === 'chest') {
        // containerItems() is the chest's own storage; window.items() is
        // the PLAYER range inside the window — using it showed the bot's
        // own inventory as "chest contents" and withdraw then failed to
        // find the item in the real container slots
        const list = session.window.containerItems
          ? session.window.containerItems()
          : (session.window.items() || [])
        base.items = list.map((it) => ({ name: it.name, count: it.count, slot: it.slot }))
      } else if (session.kind === 'furnace') {
        const w = session.window
        base.input = w.inputItem() ? { name: w.inputItem().name, count: w.inputItem().count } : null
        base.fuel = w.fuelItem() ? { name: w.fuelItem().name, count: w.fuelItem().count } : null
        base.output = w.outputItem() ? { name: w.outputItem().name, count: w.outputItem().count } : null
        base.progress = Number.isFinite(w.progress) ? w.progress : 0
        base.burn = Number.isFinite(w.fuel) ? w.fuel : 0
      } else if (session.kind === 'villager') {
        base.trades = (session.window.trades || []).map((tr, i) => ({
          index: i,
          input1: tr.inputItem1 ? { name: tr.inputItem1.name, count: tr.inputItem1.count } : null,
          input2: tr.inputItem2 ? { name: tr.inputItem2.name, count: tr.inputItem2.count } : null,
          output: tr.outputItem ? { name: tr.outputItem.name, count: tr.outputItem.count } : null,
          disabled: !!tr.tradeDisabled,
          uses: tr.nbTradeUses || 0,
          maxUses: tr.maximumNbTradeUses || 0
        }))
      }
    } catch (e) { /* window died mid-frame */ }
    return base
  }

  function push () { broadcast(frame()) }

  // walk into interaction range of a block, the commandChest way
  async function walkToReach (target, reach) {
    const pilot = ctx.pilot
    const p = pilot && pilot.pos()
    if (!p) return false
    const far = dist({ x: target.x + 0.5, y: target.y + 0.5, z: target.z + 0.5 }, p) > reach
    if (!far) return true
    const { GoalGetToBlock } = require('./engine/goals')
    const r = pilot.driveTo(new GoalGetToBlock(target.x, target.y, target.z))
    if (!r || (r.status !== 'found' && r.status !== 'partial')) return false
    await pilot.waitArrival(30000)
    return true
  }

  function findStationBlock (kind, maxDistance) {
    const bot = botNow()
    if (!bot || !bot.entity) return null
    const reg = bot.registry || null
    const meta = reg && reg.blocksByName ? reg.blocksByName[STATION_BLOCKS[kind] || kind] : null
    if (!meta) return null
    if (typeof bot.findBlocks === 'function') {
      const found = bot.findBlocks({ matching: meta.id, maxDistance: maxDistance || 16, count: 4 })
      if (found && found.length > 0) return { x: found[0].x, y: found[0].y, z: found[0].z }
    }
    return null
  }

  function clearSession (announce) {
    if (!session) return
    if (session.closeTimer) clearInterval(session.closeTimer)
    const w = session.window
    session = null
    try { if (w && w.close) w.close() } catch (e) { /* already gone */ }
    // force the server to resend the player inventory. closing a container
    // leaves mineflayer's bot.inventory racing the trailing window packets
    // — stacks split, ingredients go phantom, and the next craft fails with
    // "missing ingredient" for items visibly carried (reproduced live).
    // the stateId -1 no-op click asks for the full window_items packet.
    const bot = botNow()
    try {
      if (bot && bot.inventory && typeof bot._syncWindow === 'function') {
        const p = bot._syncWindow(bot.inventory)
        if (p && p.catch) p.catch(() => {})
      }
    } catch (e) { /* older builds */ }
    if (announce) broadcast({ t: 'station', open: false })
  }

  // kind: 'chest' | 'furnace' | 'crafting_table' | 'villager'
  // pos: optional {x,y,z}; entityId: for villagers
  async function open (kind, pos, entityId) {
    const bot = botNow()
    if (!bot || !ctx.pilot) return { ok: false, error: 'not connected' }
    if (busy) return { ok: false, error: 'another station action is running' }
    busy = true
    try {
      clearSession(false)
      if (kind === 'villager') {
        let entity = null
        if (Number.isFinite(entityId)) {
          entity = (bot.entities || {})[entityId] || null
        }
        if (!entity) {
          // nearest villager in range
          const p = bot.entity.position
          let best = null
          let bestD = Infinity
          for (const e of Object.values(bot.entities || {})) {
            if (!e || !e.position) continue
            const n = String(e.name || e.type || '')
            if (n !== 'villager' && n !== 'villager_v2') continue
            const d = e.position.distanceTo(p)
            if (d < bestD) { bestD = d; best = e }
          }
          entity = best
        }
        if (!entity) return { ok: false, error: 'no villager in range' }
        if (entity.position.distanceTo(bot.entity.position) > 3.5) {
          const ok = await walkToReach(entity.position, 3.5)
          if (!ok) return { ok: false, error: 'cannot reach the villager' }
        }
        if (typeof bot.openVillager !== 'function') return { ok: false, error: 'this mineflayer build cannot trade' }
        const window = await bot.openVillager(entity)
        session = { kind: 'villager', window, entityId: entity.id, pos: entity.position.floored() }
        wire()
        say(`villager trading opened (${(session.window.trades || []).length} trades)`)
        push()
        return { ok: true }
      }

      const blockName = STATION_BLOCKS[kind] || kind
      let target = pos
      if (!target && kind !== 'crafting_table') target = findStationBlock(kind, 16)
      if (!target) {
        return { ok: false, error: `no ${blockName} within 16 blocks — place one or give coordinates` }
      }
      const reached = await walkToReach(target, 4)
      if (!reached) return { ok: false, error: `cannot walk to the ${blockName}` }
      const block = ctx.pilot.botBlockAt(target)
      if (!block) return { ok: false, error: `the ${blockName} is gone` }

      if (kind === 'chest') {
        const window = await bot.openChest(block)
        session = { kind: 'chest', pos: target, window }
        say(`chest opened at ${target.x} ${target.y} ${target.z}`)
      } else if (kind === 'furnace') {
        const window = await bot.openFurnace(block)
        session = { kind: 'furnace', pos: target, window }
        say(`furnace opened at ${target.x} ${target.y} ${target.z}`)
      } else if (kind === 'crafting_table') {
        // mineflayer 4.39 removed bot.openCraftingTable — openBlock is the
        // current api and returns the same window
        const window = await (typeof bot.openCraftingTable === 'function'
          ? bot.openCraftingTable(block)
          : bot.openBlock(block))
        session = { kind: 'crafting_table', pos: target, window }
        say(`crafting table opened at ${target.x} ${target.y} ${target.z}`)
      } else {
        return { ok: false, error: `unknown station "${kind}"` }
      }
      wire()
      push()
      return { ok: true }
    } catch (e) {
      clearSession(false)
      return { ok: false, error: `cannot open: ${String(e.message || e).slice(0, 80)}` }
    } finally {
      busy = false
    }
  }

  // frames on a slow tick + on window updates; auto-close when the bot
  // walks away (the server closes the window itself around 4-5 blocks,
  // but our own frame stream should stop too)
  function wire () {
    if (!session) return
    const w = session.window
    if (w && w.on) {
      w.on('update', push)
      w.on('close', () => { if (session && session.window === w) clearSession(true) })
    }
    session.closeTimer = setInterval(() => {
      if (!session || !ctx.bot || !ctx.bot.entity) return clearSession(true)
      const p = ctx.bot.entity.position
      if (session.pos && dist({ x: session.pos.x + 0.5, y: session.pos.y + 0.5, z: session.pos.z + 0.5 }, p) > 6) {
        clearSession(true)
        return
      }
      push()
    }, 1000)
    if (session.closeTimer.unref) session.closeTimer.unref()
  }

  async function action (msg) {
    const bot = botNow()
    if (!bot) return { ok: false, error: 'not connected' }
    const act = msg && msg.action
    if (act === 'close') {
      clearSession(true)
      return { ok: true, reply: 'station closed' }
    }
    if (busy) return { ok: false, error: 'busy — try again in a moment' }
    if (!session) return { ok: false, error: 'no station is open' }
    busy = true
    try {
      const w = session.window
      if (session.kind === 'chest') {
        if (act === 'deposit' || act === 'withdraw') {
          const name = msg.name
          const stack = botItems().find((it) => it.name === name)
          if (act === 'deposit') {
            if (!stack) return { ok: false, error: `no ${name} in the inventory` }
            const count = msg.count === 'all' || !msg.count ? stack.count : Math.min(stack.count, Number(msg.count) || stack.count)
            await w.deposit(stack.type, null, count)
            push()
            return { ok: true, reply: `deposited ${count} ${name}` }
          }
          const its = (session.window.containerItems
            ? session.window.containerItems()
            : (session.window.items() || [])).filter((it) => it.name === name)
          if (its.length === 0) return { ok: false, error: `no ${name} in the chest` }
          const count = msg.count === 'all' || !msg.count
            ? its.reduce((a, it) => a + (it.count || 1), 0)
            : Math.min(its.reduce((a, it) => a + (it.count || 1), 0), Number(msg.count) || 1)
          await w.withdraw(its[0].type, null, count)
          push()
          return { ok: true, reply: `withdrew ${count} ${name}` }
        }
        if (act === 'depositAll') {
          const inv = botItems()
          let moved = 0
          for (const it of inv) {
            try {
              await w.deposit(it.type, null, it.count)
              moved += it.count || 1
            } catch (e) { /* chest full */ }
          }
          push()
          return { ok: true, reply: `deposited ${moved} items` }
        }
        return { ok: false, error: `unknown chest action "${act}"` }
      }
      if (session.kind === 'furnace') {
        if (act === 'put') {
          const role = msg.role === 'fuel' ? 'fuel' : 'input'
          const stack = botItems().find((it) => it.name === msg.name)
          if (!stack) return { ok: false, error: `no ${msg.name} in the inventory` }
          const count = Math.min(stack.count, Number(msg.count) || stack.count)
          if (role === 'fuel') await w.putFuel(stack.type, null, count)
          else await w.putInput(stack.type, null, count)
          push()
          return { ok: true, reply: `put ${count} ${msg.name} in the ${role}` }
        }
        if (act === 'take') {
          const role = ['output', 'input', 'fuel'].includes(msg.role) ? msg.role : 'output'
          // takeOutput() routes through putAway, whose result-slot special
          // case can strand the item on the cursor until the window closes
          // (seen live: take resolves ok, inventory stays empty for 25s,
          // item appears only after the session ends). transfer() is the
          // same primitive putInput uses — click out, click into the
          // inventory — and has no such case. furnace slots: 0 input,
          // 1 fuel, 2 output.
          const slot = role === 'output' ? 2 : (role === 'fuel' ? 1 : 0)
          const src = role === 'output' ? w.outputItem() : (role === 'fuel' ? w.fuelItem() : w.inputItem())
          if (!src) return { ok: false, error: `nothing in the ${role} slot` }
          if (typeof bot.transfer !== 'function') {
            // very old mineflayer: fall back to the accessor api
            if (role === 'output') await w.takeOutput()
            else if (role === 'input') await w.takeInput()
            else await w.takeFuel()
          } else {
            await bot.transfer({
              window: w,
              itemType: src.type,
              metadata: null,
              count: src.count,
              sourceStart: slot,
              sourceEnd: slot + 1,
              destStart: w.inventoryStart,
              destEnd: w.inventoryEnd
            })
          }
          push()
          return { ok: true, reply: `took the ${role}` }
        }
        return { ok: false, error: `unknown furnace action "${act}"` }
      }
      if (session.kind === 'villager') {
        if (act === 'trade') {
          const index = Number(msg.index)
          const trades = session.window.trades || []
          if (!Number.isInteger(index) || index < 0 || index >= trades.length) {
            return { ok: false, error: `no trade ${msg.index}` }
          }
          const times = Math.max(1, Math.min(64, Number(msg.times) || 1))
          if (typeof bot.trade !== 'function') return { ok: false, error: 'this mineflayer build cannot trade' }
          await bot.trade(session.window, index, times)
          push()
          return { ok: true, reply: `traded #${index} x${times}` }
        }
        return { ok: false, error: `unknown villager action "${act}"` }
      }
      if (session.kind === 'crafting_table') {
        return { ok: false, error: 'use the craft tab — the table window only enables recipes' }
      }
      return { ok: false, error: 'unknown station kind' }
    } catch (e) {
      push()
      return { ok: false, error: `${act} failed: ${String(e.message || e).slice(0, 60)}` }
    } finally {
      busy = false
    }
  }

  function reset () { clearSession(true) }

  return { open, action, reset, push, frame, findStationBlock, botItems, isOpen: () => !!session }
}

module.exports = { createStationManager, STATION_BLOCKS, itemType }
