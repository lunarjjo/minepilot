'use strict'

// the recipe index — a browsable view over the registry's recipe tables,
// joined with the live inventory so the crafting tab can show every
// recipe with have/need counts and a craftable flag. pure data work: no
// bot, no async — the same index serves REST, the ws protocol and tests.

function ingredientCountsFromRecipe (recipe) {
  // recipe shape (minecraft-data): either { inShape: [[id|null,...],...] }
  // (shaped, up to 3x3) or { ingredients: [id, ...] } (shapeless).
  const counts = new Map()
  if (Array.isArray(recipe.inShape)) {
    for (const row of recipe.inShape) {
      for (const cell of row) {
        if (cell === null || cell === undefined) continue
        counts.set(cell, (counts.get(cell) || 0) + 1)
      }
    }
  } else if (Array.isArray(recipe.ingredients)) {
    for (const id of recipe.ingredients) {
      if (id === null || id === undefined) continue
      counts.set(id, (counts.get(id) || 0) + 1)
    }
  }
  return counts
}

function requiresTableFromRecipe (recipe) {
  if (Array.isArray(recipe.inShape)) {
    return recipe.inShape.length > 2 || recipe.inShape[0].length > 2
  }
  return false // shapeless recipes never need a table in vanilla
}

// one entry per result item, holding EVERY recipe variant (the tables
// carry one recipe per plank/wood/etc. variant — crafting_table has 30+).
// availability picks the variant closest to the current inventory, so the
// tab shows the recipe you would actually craft, not an arbitrary one.
// entries with a broken result (the legacy id-0 quirk) are skipped.
function buildRecipeIndex (registry) {
  const out = []
  if (!registry || !registry.recipes || !registry.itemsByName) return out
  const itemMeta = (id) => {
    const it = registry.itemsArray ? registry.itemsArray.find((x) => x.id === id) : null
    return it || null
  }
  const blockName = (id) => {
    if (registry.blocksArray) {
      const b = registry.blocksArray.find((x) => x.id === id)
      if (b) return b.name
    }
    return null
  }
  for (const [resultId, recipes] of Object.entries(registry.recipes)) {
    if (!Array.isArray(recipes) || recipes.length === 0) continue
    const meta = itemMeta(Number(resultId))
    if (!meta) continue // not an obtainable item entry
    const variants = []
    let tableAny = false
    for (const recipe of recipes) {
      const result = recipe.result || {}
      const rid = Number(result.id)
      if (!Number.isFinite(rid) || rid <= 0 || !(result.count > 0)) continue
      const counts = ingredientCountsFromRecipe(recipe)
      if (counts.size === 0) continue
      const ingredients = []
      for (const [id, need] of counts) {
        const im = itemMeta(id)
        const name = im ? im.name : (blockName(id) || `id_${id}`)
        ingredients.push({ name, need, displayName: im ? (im.displayName || name) : name })
      }
      if (requiresTableFromRecipe(recipe)) tableAny = true
      variants.push({ count: result.count, requiresTable: requiresTableFromRecipe(recipe), ingredients })
    }
    if (variants.length === 0) continue
    out.push({
      name: meta.name,
      displayName: meta.displayName || meta.name,
      count: variants[0].count,
      requiresTable: tableAny,
      variants
    })
  }
  // stable, human-friendly order: by result name
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

function inventoryCounts (items) {
  const have = new Map()
  for (const it of items || []) {
    if (!it || !it.name) continue
    have.set(it.name, (have.get(it.name) || 0) + (it.count || 1))
  }
  return have
}

// decorate entries with have/canCraft for the current inventory:
// the best variant (fewest missing, then fewest ingredients) wins and is
// the one whose ingredient list goes on the wire
function withAvailability (entry, have) {
  let best = null
  let bestScore = Infinity
  for (const v of entry.variants) {
    let missing = 0
    let total = 0
    for (const ing of v.ingredients) {
      const got = have.get(ing.name) || 0
      if (got < ing.need) missing += ing.need - got
      total += ing.need
    }
    const score = missing * 1000 + total
    if (score < bestScore) {
      bestScore = score
      best = { variant: v, missing }
    }
  }
  const v = best.variant
  const ingredients = v.ingredients.map((ing) => ({ ...ing, have: have.get(ing.name) || 0 }))
  return {
    name: entry.name,
    displayName: entry.displayName,
    count: v.count,
    requiresTable: v.requiresTable,
    ingredients,
    craftable: best.missing === 0,
    missing: best.missing,
    variants: entry.variants.length
  }
}

// the listing used by /api/recipes and the ws recipes frames:
// query-filtered, availability-decorated, capped for the wire
function listRecipes (index, items, query, opts) {
  const q = String(query || '').trim().toLowerCase()
  const have = inventoryCounts(items)
  let entries = index
  if (q) entries = entries.filter((e) => e.name.includes(q) || (e.displayName || '').toLowerCase().includes(q))
  let out = entries.map((e) => withAvailability(e, have))
  const limit = opts && Number.isFinite(opts.limit) ? opts.limit : 400
  if (opts && opts.craftableFirst) out = out.sort((a, b) => Number(b.craftable) - Number(a.craftable) || a.name.localeCompare(b.name))
  if (out.length > limit) out = out.slice(0, limit)
  return out
}

module.exports = { buildRecipeIndex, inventoryCounts, withAvailability, listRecipes, ingredientCountsFromRecipe, requiresTableFromRecipe }
