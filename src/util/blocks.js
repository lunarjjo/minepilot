'use strict'

// block name -> radar color. the radar paints the topmost non-air block of
// every column, so colors are chosen to read well from a distance: terrain
// greens, water blues, stone grays, wood browns, sand tans. every name maps
// to a stable color; unknown blocks fall through family rules and finally a
// neutral slate so the map never breaks on new blocks.

const EXACT = {
  grass_block: '#59a544',
  dirt: '#8a5a3b',
  coarse_dirt: '#7d5334',
  podzol: '#5c4426',
  farmland: '#6f4a2c',
  mud: '#4d4132',
  stone: '#7d7d7d',
  cobblestone: '#6e6e6e',
  stone_bricks: '#767672',
  deepslate: '#4c4c50',
  granite: '#96604a',
  diorite: '#bcbcc4',
  andesite: '#8a8a8d',
  tuff: '#5d6058',
  gravel: '#8a8583',
  sand: '#dbd0a0',
  red_sand: '#bd7233',
  sandstone: '#d6cb9c',
  water: '#3d6ed6',
  flowing_water: '#3d6ed6',
  ice: '#9cc7f0',
  packed_ice: '#a8d0f5',
  blue_ice: '#7fb6f2',
  snow: '#eef2f5',
  snow_block: '#e8edf2',
  clay: '#a0a5b4',
  obsidian: '#1c1226',
  bedrock: '#333333',
  netherrack: '#6e2c2c',
  soul_sand: '#544237',
  end_stone: '#dbdb9c',
  moss_block: '#5c7a35',
  mycelium: '#8f7391',
  oak_log: '#6b5233',
  birch_log: '#d7cdb0',
  spruce_log: '#4a3623',
  jungle_log: '#59452a',
  acacia_log: '#6b4226',
  dark_oak_log: '#3d2b17',
  mangrove_log: '#54341f',
  oak_leaves: '#3d7a28',
  birch_leaves: '#48862c',
  spruce_leaves: '#2e5c33',
  jungle_leaves: '#2f801f',
  acacia_leaves: '#5c7a1f',
  dark_oak_leaves: '#2f5c1d',
  mangrove_leaves: '#4a7a2a',
  cherry_leaves: '#e3b3c8',
  azalea_leaves: '#4a6a2a',
  oak_planks: '#a5814f',
  spruce_planks: '#735531',
  birch_planks: '#c9b077',
  jungle_planks: '#a9703c',
  acacia_planks: '#ad5d34',
  dark_oak_planks: '#4a3119',
  mangrove_planks: '#773c27',
  bamboo_planks: '#b3903f',
  cherry_planks: '#d8ab8c',
  brick: '#9c5648',
  bricks: '#9c5648',
  mud_bricks: '#8b6f5a',
  cactus: '#4a7a2f',
  melon: '#6d9a37',
  pumpkin: '#c07615',
  carved_pumpkin: '#c07615',
  hay_block: '#a98b23',
  honeycomb_block: '#d8a63b',
  slime_block: '#77c26b',
  honey_block: '#d8a63b',
  tnt: '#b0302a',
  bookshelf: '#8a6a3d',
  glass: '#c4d7e0',
  tinted_glass: '#a9a2c4',
  sea_lantern: '#a6d3cd',
  glowstone: '#e8c66a',
  shroomlight: '#e39234',
  magma_block: '#8f391d',
  nether_wart_block: '#71090b',
  warped_wart_block: '#166765',
  copper_block: '#c16d4f',
  iron_block: '#d8d8d8',
  gold_block: '#f2d24b',
  diamond_block: '#66e0d5',
  emerald_block: '#41d36b',
  netherite_block: '#453c40',
  lapis_block: '#1f4bb8',
  redstone_block: '#a81610',
  coal_ore: '#4a4a4a',
  iron_ore: '#94847b',
  copper_ore: '#9c6f5c',
  gold_ore: '#9c8a4b',
  diamond_ore: '#66c2ba',
  emerald_ore: '#5f9c6f',
  lapis_ore: '#5a6f9c',
  redstone_ore: '#7d4440',
  ancient_debris: '#5b4038'
}

// family rules for names the exact table does not know yet.
const FAMILIES = [
  [/water|kelp|seagrass/, '#3d6ed6'],
  [/lava|magma/, '#cf4b1d'],
  [/sand/, '#d6cb9c'],
  [/snow|powder/, '#eef2f5'],
  [/leaves|azalea/, '#3d7a28'],
  [/log|stem|hyphae/, '#5c4426'],
  [/planks|wood|fence|sign|barrel|chest|desk|stair|slab|door|trapdoor|button|pressure_plate/, '#a5814f'],
  [/deepslate/, '#4c4c50'],
  [/ore/, '#7d7d7d'],
  [/nether|crimson|warped|blackstone|basalt/, '#6e2c2c'],
  [/end/, '#dbdb9c'],
  [/bricks?|brick/, '#9c5648'],
  [/terracotta/, '#a05c40'],
  [/concrete/, '#9c9c9c'],
  [/wool|carpet|bed|banner/, '#b8b8c0'],
  [/glass|ice/, '#c4d7e0'],
  [/coral|sponge|anemone/, '#d86a8a'],
  [/grass|flower|bush|crop|wheat|carrot|potato|beet|fern|moss|vine|roots|fungus|sapling|tulip|dandelion|poppy|orchid|allium|bluet|daisy|cornflower|lily|peony|rose|sunflower|lilac|azalea|pitcher|torchflower/, '#4a8a35'],
  [/stone|cobble|andesite|diorite|granite|tuff|calcite|dripstone|pointed/, '#7d7d7d'],
  [/dirt|path|mud|farmland|podzol|rooted/, '#8a5a3b']
]

const FALLBACK = '#3a3a42'

function blockColor (name) {
  if (typeof name !== 'string' || name === '') return FALLBACK
  if (EXACT[name]) return EXACT[name]
  const n = name.toLowerCase()
  if (EXACT[n]) return EXACT[n]
  for (const [re, color] of FAMILIES) {
    if (re.test(n)) return color
  }
  return FALLBACK
}

// "air-like" blocks are never treated as the surface of a column.
function isAirLike (name) {
  return name === 'air' || name === 'cave_air' || name === 'void_air' || name === 'light'
}

function hexToRgb (hex) {
  const v = hex.replace('#', '')
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)]
}

module.exports = { blockColor, isAirLike, hexToRgb, FALLBACK }
