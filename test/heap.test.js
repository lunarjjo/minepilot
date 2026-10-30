'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { MinHeap } = require('../src/engine/heap')

test('heap: pops in ascending score order', () => {
  const h = new MinHeap()
  for (const v of [5, 3, 9, 1, 7, 2, 8]) h.push(v, v)
  const out = []
  while (h.size > 0) out.push(h.pop().value)
  assert.deepStrictEqual(out, [1, 2, 3, 5, 7, 8, 9])
})

test('heap: insertion order breaks score ties deterministically', () => {
  const h = new MinHeap()
  h.push(1, 'a')
  h.push(1, 'b')
  h.push(1, 'c')
  assert.strictEqual(h.pop().value, 'a')
  assert.strictEqual(h.pop().value, 'b')
  assert.strictEqual(h.pop().value, 'c')
})

test('heap: interleaved push and pop stays sorted', () => {
  const h = new MinHeap()
  h.push(10, 10)
  h.push(2, 2)
  assert.strictEqual(h.pop().value, 2)
  h.push(1, 1)
  h.push(5, 5)
  assert.strictEqual(h.pop().value, 1)
  assert.strictEqual(h.pop().value, 5)
  assert.strictEqual(h.pop().value, 10)
  assert.strictEqual(h.size, 0)
})

test('heap: peek does not remove, pop on empty answers null', () => {
  const h = new MinHeap()
  assert.strictEqual(h.pop(), null)
  assert.strictEqual(h.peek(), null)
  h.push(4, 'x')
  assert.strictEqual(h.peek().value, 'x')
  assert.strictEqual(h.size, 1)
})

test('heap: handles a large shuffled batch', () => {
  const h = new MinHeap()
  const n = 2000
  const vals = []
  for (let i = 0; i < n; i++) vals.push((i * 7919) % n)
  for (const v of vals) h.push(v, v)
  let prev = -1
  let count = 0
  while (h.size > 0) {
    const v = h.pop().value
    assert.ok(v >= prev, 'out of order')
    prev = v
    count++
  }
  assert.strictEqual(count, n)
})

test('heap: clear empties it', () => {
  const h = new MinHeap()
  h.push(1, 1)
  h.push(2, 2)
  h.clear()
  assert.strictEqual(h.size, 0)
})
