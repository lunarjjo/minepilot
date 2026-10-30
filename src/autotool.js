'use strict'

// auto-tool selection — minepilot's port of baritone's autoTool setting.
// mineflayer digs with whatever is in hand, so every dig equips the best
// tool for the block first. the material class comes from the block name
// family (minecraft-data does not expose a reliable material field for
// every version), and the tier order follows real mining speed.

const TOOL_CLASS = {
  pickaxe: ['stone', 'cobble', 'deepslate', 'granite', 'diorite', 'andesite',
    'tuff', 'obsidian', 'netherrack', 'blackstone', 'basalt', 'end_stone',
    'ore', 'ice', 'packed_ice', 'blue_ice', 'prismarine', 'purpur', 'quartz',
    'brick', 'magma', 'furnace', 'concrete', 'terracotta', 'glass', 'iron',
    'gold', 'diamond', 'emerald', 'lapis', 'redstone', 'copper', 'coal',
    'ancient_debris', 'netherite', 'amethyst', 'calcite', 'tuff', 'shroomlight',
    'coral', 'bedrock'],
  axe: ['log', 'wood', 'planks', 'fence', 'door', 'trapdoor', 'sign', 'chest',
    'barrel', 'bookshelf', 'crafting', 'cartography', 'fletching', 'loom',
    'smithing', 'jukebox', 'note_block', 'pumpkin', 'melon', 'bark', 'stem',
    'hyphae', 'bamboo', 'chiseled_bookshelf', 'lectern', 'composter', 'mushroom_block'],
  shovel: ['dirt', 'grass', 'sand', 'gravel', 'clay', 'snow', 'mud', 'podzol',
    'farmland', 'path', 'soul_sand', 'mycelium', 'moss', 'rooted', 'suspicious'],
  hoe: ['leaves', 'hay', 'target', 'sponge', 'nether_wart_block', 'warped_wart_block',
    'sculk', 'moss_carpet', 'shroomlight', 'honey', 'honeycomb'],
  sword: ['cobweb', 'bamboo'],
  shears: ['wool', 'vine', 'twisting', 'weeping', 'leaves']
}

// mining speed order, fastest first. golden tools mine fast but are fragile;
// for a bot that digs a lot, durability order (netherite first) also works —
// speed order matches what baritone's autoTool equips.
const TIERS = ['netherite', 'diamond', 'golden', 'iron', 'stone', 'wooden']

function materialClass (blockName) {
  const n = String(blockName)
  for (const [cls, families] of Object.entries(TOOL_CLASS)) {
    for (const f of families) {
      if (n === f || n.startsWith(f + '_') || n.includes('_' + f) || n.endsWith(f)) {
        return cls
      }
    }
  }
  return null
}

// rank a tool item for a class; higher is better
function toolScore (item, cls) {
  const n = item.name
  const suffix = '_' + cls
  if (!n.endsWith(suffix)) return -1
  const base = n.slice(0, -suffix.length)
  const idx = TIERS.indexOf(base)
  return idx === -1 ? -1 : (TIERS.length - idx)
}

// the best carried tool for a block, or null (hand is fine)
function bestToolFor (bot, blockName) {
  let items = []
  try {
    items = (bot.inventory && bot.inventory.items()) || []
  } catch (e) { return null }
  const cls = materialClass(blockName)
  if (!cls) return null
  let best = null
  let bestScore = 0
  for (const it of items) {
    if (!it || typeof it.name !== 'string') continue
    const score = toolScore(it, cls)
    if (score > bestScore) {
      bestScore = score
      best = it
    }
  }
  return bestScore > 0 ? best : null
}

// equip the best tool for a block (no-op when hand is best or nothing fits)
async function equipForDig (bot, blockName) {
  const best = bestToolFor(bot, blockName)
  if (!best) return null
  try {
    if (bot.equip) await bot.equip(best, 'hand')
  } catch (e) { /* fakes and edge states may not equip */ }
  return best
}

module.exports = { bestToolFor, equipForDig, materialClass, TIERS }
