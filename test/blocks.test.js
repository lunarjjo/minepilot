'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { blockColor, isAirLike, hexToRgb, FALLBACK } = require('../src/util/blocks')

test('colors are stable', () => {
  assert.strictEqual(blockColor('grass_block'), blockColor('grass_block'))
  assert.strictEqual(blockColor('GRASS_BLOCK'), blockColor('grass_block'))
})

test('grass reads green, water reads blue', () => {
  const [gr, gg, gb] = hexToRgb(blockColor('grass_block'))
  assert.ok(gg > gr && gg > gb, 'grass should be greenest channel')
  const [wr, wg, wb] = hexToRgb(blockColor('water'))
  assert.ok(wb > wr && wb > wg, 'water should be bluest channel')
})

test('family rules catch unlisted relatives', () => {
  assert.strictEqual(blockColor('oak_fence'), '#a5814f') // wood family
  assert.strictEqual(blockColor('deepslate_diamond_ore'), '#4c4c50') // deepslate before ore
  assert.strictEqual(blockColor('cherry_log'), '#5c4426') // log family
})

test('order matters: deepslate beats ore', () => {
  // deepslate_* entries must not be swallowed by the generic ore rule
  assert.notStrictEqual(blockColor('deepslate_iron_ore'), blockColor('iron_ore'))
})

test('unknown blocks fall back to a neutral slate', () => {
  assert.strictEqual(blockColor('definitely_not_a_block'), FALLBACK)
  assert.strictEqual(blockColor(''), FALLBACK)
  assert.strictEqual(blockColor(null), FALLBACK)
})

test('air-like names are recognized', () => {
  assert.ok(isAirLike('air'))
  assert.ok(isAirLike('cave_air'))
  assert.ok(isAirLike('void_air'))
  assert.ok(!isAirLike('grass_block'))
})

test('palette never overflows rgb bounds', () => {
  for (const hex of new Set(Object.values(require('../src/util/blocks') && [blockColor('grass_block'), blockColor('water'), blockColor('oak_planks'), blockColor('zzz')]))) {
    const [r, g, b] = hexToRgb(hex)
    assert.ok(r >= 0 && r <= 255 && g >= 0 && g <= 255 && b >= 0 && b <= 255)
  }
})
