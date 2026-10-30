'use strict'

const test = require('node:test')
const assert = require('node:assert')
const {
  GoalBlock, GoalNear, GoalXZ, GoalYLevel, GoalComposite, GoalInverted,
  GoalRunAway, GoalFollow, octile
} = require('../src/engine/goals')

test('octile: cardinals, diagonals and zero', () => {
  assert.strictEqual(octile(3, 0), 3)
  assert.strictEqual(octile(0, 5), 5)
  const d = octile(2, 2)
  assert.ok(Math.abs(d - Math.SQRT2 * 2) < 1e-9)
  assert.strictEqual(octile(0, 0), 0)
  assert.strictEqual(octile(-4, 2), 4 + (Math.SQRT2 - 1) * 2)
})

test('goal block: exact match, heuristic is a lower bound', () => {
  const g = new GoalBlock(10, 70, -5)
  assert.strictEqual(g.isMet(10, 70, -5), true)
  assert.strictEqual(g.isMet(10, 71, -5), false)
  // true optimal cost to walk 5 north + 3 up: 5 + 3*2 = 11 (three ascends)
  assert.ok(g.heuristic(5, 67, -5) <= 11)
  assert.ok(g.heuristic(5, 67, -5) >= 8) // octile(5) + |dy| = 5+3
  assert.strictEqual(g.label(), 'block 10 70 -5')
})

test('goal near: radius satisfaction and slack', () => {
  const g = new GoalNear(0, 64, 0, 2)
  assert.strictEqual(g.isMet(1, 64, 1), true)
  assert.strictEqual(g.isMet(2, 64, 2), false) // dist^2 = 8 > 4
  assert.strictEqual(g.heuristic(5, 64, 0), 3) // 5 - 2
  assert.strictEqual(g.heuristic(1, 64, 1), 0)
})

test('goal xz: horizontal only', () => {
  const g = new GoalXZ(8, -8)
  assert.strictEqual(g.isMet(8, 40, -8), true)
  assert.strictEqual(g.isMet(8, 90, -7), false)
  assert.strictEqual(g.heuristic(0, 64, 0), 8 + (Math.SQRT2 - 1) * 8) // octile(8,8)
  assert.strictEqual(new GoalXZ(8, 0).heuristic(0, 64, 0), 8)
})

test('goal y level: any x/z', () => {
  const g = new GoalYLevel(30)
  assert.strictEqual(g.isMet(-500, 30, 500), true)
  assert.strictEqual(g.isMet(0, 31, 0), false)
  assert.strictEqual(g.heuristic(0, 64, 0), 34)
})

test('goal composite: met by any, bounded by the cheapest', () => {
  const g = new GoalComposite(new GoalBlock(10, 64, 10), new GoalXZ(-10, -10))
  assert.strictEqual(g.isMet(-10, 70, -10), true) // via the xz branch
  assert.strictEqual(g.isMet(0, 64, 0), false)
  assert.ok(Math.abs(g.heuristic(9, 64, 9) - Math.SQRT2) < 1e-9) // min(octile(1,1), 19+)
  assert.ok(Math.abs(g.heuristic(-9, 64, -9) - Math.SQRT2) < 1e-9)
})

test('goal inverted: negates the inner goal, heuristic stays honest', () => {
  const inner = new GoalNear(0, 64, 0, 3)
  const g = new GoalInverted(inner)
  assert.strictEqual(g.isMet(1, 64, 1), false)
  assert.strictEqual(g.isMet(10, 64, 10), true)
  assert.strictEqual(g.heuristic(0, 64, 0), 0) // no admissible bound
})

test('goal runaway: outside the radius is done', () => {
  const g = new GoalRunAway(0, 0, 10)
  assert.strictEqual(g.isMet(10, 64, 0), true)
  assert.strictEqual(g.isMet(9, 64, 0), false)
  assert.strictEqual(g.heuristic(0, 64, 0), 0)
})

test('goal follow: tracks a moving target with slack', () => {
  let pos = { x: 0, y: 64, z: 0 }
  const g = new GoalFollow(() => pos, 2)
  assert.strictEqual(g.isMet(0, 64, 0), true)
  pos = { x: 10, y: 64, z: 0 }
  assert.strictEqual(g.isMet(0, 64, 0), false)
  assert.strictEqual(g.heuristic(0, 64, 0), 8)
  // target goes missing: last known position is remembered and pursued
  let gone = false
  const g2 = new GoalFollow(() => (gone ? null : { x: 5, y: 64, z: 5 }), 1)
  const before = g2.heuristic(0, 64, 0)
  assert.ok(before > 0)
  gone = true
  assert.strictEqual(g2.heuristic(0, 64, 0), before) // cached, not reset
  assert.strictEqual(g2.isMet(0, 64, 0), false)
})

test('heuristics never overestimate a real walking cost', () => {
  // walking 2 north + 2 east diagonally costs 2*sqrt2 = 2.83;
  // the heuristic must not claim more than that
  const g = new GoalBlock(2, 64, 2)
  assert.ok(g.heuristic(0, 64, 0) <= 2 * Math.SQRT2 + 1e-9)
})
