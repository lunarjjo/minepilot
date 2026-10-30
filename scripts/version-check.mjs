#!/usr/bin/env node
// version-check: the "stay current" half of version-compat.
//
// answers three questions in one run:
//   1. what is the newest Minecraft Java release? (official piston-meta manifest)
//   2. which versions does the installed/upstream minecraft-data support,
//      and which ones does botfleet's vendored overlay cover?
//   3. which versions does CI actually verify end-to-end? (ci.yml matrix)
//
// exit codes:
//   0 — every recent Minecraft release has a support path (official or
//       overlay) AND the newest one is covered by the live e2e matrix
//   1 — attention needed: a release exists with no support path, or the
//       newest release is not e2e-verified yet (the version-guard workflow
//       turns this into a tracking issue)
//   2 — could not determine the answer (network/tooling failure)
//
// usage: node scripts/version-check.mjs [--json]

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
const NPM_REGISTRY = 'https://registry.npmjs.org/minecraft-data'
const MASTER_DATA_PATHS = 'https://raw.githubusercontent.com/PrismarineJS/minecraft-data/master/data/dataPaths.json'

const RECENT_RELEASES = 3 // how many newest releases must have a support path

async function fetchJson (url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) })
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`)
  return res.json()
}

function releasesFromManifest (manifest) {
  return manifest.versions
    .filter((v) => v.type === 'release')
    .map((v) => v.id)
}

async function installedSupport () {
  // versions the LOCAL overlay (this repo) provides
  const compat = require_(path.join(ROOT, 'src/version-compat/index.js'))
  const vendored = Object.keys(compat.OWN_FILES).filter((v) => compat.hasVendoredData(v))
  let installedOfficial = []
  try {
    const mcDataIndex = require_('minecraft-data')
    installedOfficial = mcDataIndex.supportedVersions.pc
  } catch (e) {
    // minecraft-data not installed (no npm ci yet) — fall back to vendored only
  }
  return { vendored, installedOfficial }
}

async function upstreamSupport () {
  // versions merged on minecraft-data master (the release train upstream)
  try {
    const dataPaths = await fetchJson(MASTER_DATA_PATHS)
    return Object.keys(dataPaths.pc).filter((v) => dataPaths.pc[v].protocol)
  } catch (e) {
    return null
  }
}

function ciMatrixVersions () {
  const ci = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8')
  const m = /mc:\s*\[([^\]]*)\]/.exec(ci)
  if (!m) return []
  return m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
}

function compareVersions (a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d !== 0) return d
  }
  return 0
}

async function main () {
  const asJson = process.argv.includes('--json')

  const [manifest, npmInfo, upstream, local] = await Promise.all([
    fetchJson(MANIFEST_URL),
    fetchJson(NPM_REGISTRY).catch(() => null),
    upstreamSupport(),
    installedSupport()
  ])

  const latest = manifest.latest.release
  const releases = releasesFromManifest(manifest).slice(0, RECENT_RELEASES)
  const npmLatest = npmInfo ? npmInfo['dist-tags'].latest : null

  const officiallyShipped = new Set([...(local.installedOfficial || []), ...(upstream || [])])
  const overlay = new Set(local.vendored.filter((v) => !officiallyShipped.has(v)))
  const supported = new Set([...officiallyShipped, ...overlay])

  const tested = ciMatrixVersions()

  const report = {
    when: new Date().toISOString(),
    latestMinecraft: latest,
    recentReleases: releases,
    minecraftDataNpm: npmLatest,
    minecraftDataMasterMerged: upstream,
    support: releases.map((v) => ({
      version: v,
      official: officiallyShipped.has(v),
      overlay: overlay.has(v),
      e2eVerified: tested.includes(v)
    })),
    e2eMatrix: tested,
    ok: null,
    actions: []
  }

  for (const v of releases) {
    const s = report.support.find((x) => x.version === v)
    if (!s.official && !s.overlay) {
      report.actions.push(`no support path for Minecraft ${v} — needs a minecraft-data PR to vendored (see src/version-compat/data/README.md)`)
    } else if (s.overlay && !s.e2eVerified) {
      report.actions.push(`Minecraft ${v} runs via the vendored overlay but is not in the live e2e matrix — add it to ci.yml`)
    } else if (!s.e2eVerified && compareVersions(v, latest) === 0) {
      report.actions.push(`newest Minecraft ${v} is supported but not e2e-verified — add it to the ci.yml mc matrix`)
    }
  }
  report.ok = report.actions.length === 0

  if (asJson) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(`minecraft latest release : ${latest}`)
    console.log(`recent releases          : ${releases.join(', ')}`)
    console.log(`minecraft-data npm       : ${npmLatest || 'unknown'}`)
    console.log(`minecraft-data master    : ${upstream ? `merged through ${[...upstream].sort(compareVersions).pop()}` : 'unknown'}`)
    for (const s of report.support) {
      const via = s.official ? 'official minecraft-data' : (s.overlay ? 'vendored overlay' : 'NONE')
      const e2e = s.e2eVerified ? 'e2e-verified' : 'not in e2e matrix'
      console.log(`  ${s.version.padEnd(8)} ${via.padEnd(24)} ${e2e}`)
    }
    for (const a of report.actions) console.log(`ACTION: ${a}`)
    console.log(report.ok ? 'status: current' : 'status: ATTENTION NEEDED')
  }

  process.exit(report.ok ? 0 : 1)
}

main().catch((e) => {
  console.error(`version-check failed: ${e.message}`)
  process.exit(2)
})
