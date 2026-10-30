'use strict'

// binary min-heap keyed by score, with an insertion sequence as the
// tie-breaker so the search is deterministic across runs. push/pop are
// O(log n); this is the hot loop of the pathfinder, so it stays branch-light.

class MinHeap {
  constructor () {
    this.items = [] // { score, seq, value }
    this.seq = 0
  }

  get size () {
    return this.items.length
  }

  push (score, value) {
    const items = this.items
    const node = { score, seq: this.seq++, value }
    items.push(node)
    let i = items.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (less(items[i], items[parent])) {
        swap(items, i, parent)
        i = parent
      } else break
    }
    return node
  }

  peek () {
    return this.items.length ? this.items[0] : null
  }

  pop () {
    const items = this.items
    if (items.length === 0) return null
    const top = items[0]
    const last = items.pop()
    if (items.length > 0) {
      items[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < items.length && less(items[l], items[m])) m = l
        if (r < items.length && less(items[r], items[m])) m = r
        if (m === i) break
        swap(items, i, m)
        i = m
      }
    }
    return top
  }

  clear () {
    this.items.length = 0
  }
}

function less (a, b) {
  if (a.score !== b.score) return a.score < b.score
  return a.seq < b.seq
}

function swap (items, i, j) {
  const t = items[i]
  items[i] = items[j]
  items[j] = t
}

module.exports = { MinHeap }
