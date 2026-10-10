#!/usr/bin/env node
// How much of Quilt the tests run, counting the files no test loads at all.
//
//   npm run test:coverage                the whole suite, then the report
//   npm run test:coverage -- --worst 30  list more of the least covered files (default 15)
//
// Node's own coverage table leaves out every file no test imports, so it reads better than
// it is (91.9% of lines on 2026-10-07, against 79.1% with those files counted). This report
// counts their lines as not run. Branches and functions of a file never loaded are unknown,
// so those two totals are over loaded files only, and say so. The lcov file is written to
// coverage/lcov.info for an editor to show line by line.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const ROOTS = ['src', 'bin', 'desktop']
const SOURCE = /\.(?:m|c)?js$/
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const slashes = (p) => p.split(path.sep).join('/').replace(/\\/g, '/')
const pct = (hit, total) => total ? (100 * hit) / total : 100

/** Per-file counts from lcov text: Map(path -> { lines, branches, functions }), each [hit, total]. Paths relative to `root`, with /. */
export function parseLcov (text, root = ROOT) {
  const files = new Map()
  let cur = null
  for (const raw of String(text).split(/\r?\n/)) {
    const [key, ...rest] = raw.split(':')
    const value = rest.join(':')
    if (key === 'SF') {
      const abs = path.resolve(root, value)
      cur = { lines: [0, 0], branches: [0, 0], functions: [0, 0] }
      files.set(slashes(path.relative(root, abs)), cur)
    } else if (cur && key === 'LH') cur.lines[0] = Number(value)
    else if (cur && key === 'LF') cur.lines[1] = Number(value)
    else if (cur && key === 'BRH') cur.branches[0] = Number(value)
    else if (cur && key === 'BRF') cur.branches[1] = Number(value)
    else if (cur && key === 'FNH') cur.functions[0] = Number(value)
    else if (cur && key === 'FNF') cur.functions[1] = Number(value)
    else if (raw === 'end_of_record') cur = null
  }
  return files
}

/** Every source file under `roots`, relative to `root`, with /. */
export function sourceFiles (root = ROOT, roots = ROOTS) {
  const out = []
  const walk = (dir) => {
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (SOURCE.test(e.name)) out.push(slashes(path.relative(root, p)))
    }
  }
  for (const r of roots) walk(path.join(root, r))
  return out.sort()
}

/**
 * The report's numbers. `covered`: parseLcov's map. `all`: every source file. `linesOf(file)`:
 * how many lines a file never loaded has (node counts every line of a loaded one).
 */
export function summarize (covered, all, linesOf) {
  const rows = []
  for (const [file, c] of covered) rows.push({ file, loaded: true, ...c })
  const never = all.filter((f) => !covered.has(f)).map((file) => ({ file, loaded: false, lines: [0, linesOf(file)] }))
  const sum = (list, k) => list.reduce((a, r) => [a[0] + r[k][0], a[1] + r[k][1]], [0, 0])
  const lines = sum([...rows, ...never], 'lines')
  const loadedLines = sum(rows, 'lines')
  const branches = sum(rows, 'branches')
  const functions = sum(rows, 'functions')
  return {
    lines: { hit: lines[0], total: lines[1], pct: pct(...lines) },
    loadedLines: { hit: loadedLines[0], total: loadedLines[1], pct: pct(...loadedLines) },
    branches: { hit: branches[0], total: branches[1], pct: pct(...branches) },
    functions: { hit: functions[0], total: functions[1], pct: pct(...functions) },
    never: never.sort((a, b) => b.lines[1] - a.lines[1]),
    // Most lines not run first: where a test would cover the most.
    worst: [...rows].map((r) => ({ ...r, missing: r.lines[1] - r.lines[0] })).sort((a, b) => b.missing - a.missing)
  }
}

/** The report as text. */
export function render (s, { worst = 15 } = {}) {
  const p = (x) => `${x.toFixed(1)}%`
  const out = [
    'Coverage of src/, bin/ and desktop/',
    `  lines      ${p(s.lines.pct).padStart(6)}  ${s.lines.hit} of ${s.lines.total}, counting files no test loads (node's own table says ${p(s.loadedLines.pct)})`,
    `  branches   ${p(s.branches.pct).padStart(6)}  in files the tests load`,
    `  functions  ${p(s.functions.pct).padStart(6)}  in files the tests load`
  ]
  if (s.never.length) {
    out.push('', `Never loaded by any test (${s.never.length} files, ${s.never.reduce((a, r) => a + r.lines[1], 0)} lines):`)
    for (const r of s.never) out.push(`  ${String(r.lines[1]).padStart(6)} lines  ${r.file}`)
  }
  const list = s.worst.filter((r) => r.missing > 0).slice(0, worst)
  if (list.length) {
    out.push('', 'Most lines not run, in files the tests load:')
    for (const r of list) {
      out.push(`  ${String(r.missing).padStart(6)} lines  ${p(pct(...r.lines)).padStart(6)} of lines  ${p(pct(...r.branches)).padStart(6)} of branches  ${r.file}`)
    }
  }
  return out.join('\n')
}

async function main () {
  const argv = process.argv.slice(2)
  const at = argv.indexOf('--worst')
  const worst = at >= 0 ? Math.max(1, Number(argv[at + 1]) || 15) : 15
  const lcov = path.join(ROOT, 'coverage', 'lcov.info')
  fs.mkdirSync(path.dirname(lcov), { recursive: true })
  fs.rmSync(lcov, { force: true })
  const args = [
    '--disable-warning=ExperimentalWarning', '--import', './test/helpers/setup.js',
    '--test', '--experimental-test-coverage',
    ...ROOTS.map((r) => `--test-coverage-include=${r}/**`),
    '--test-reporter=spec', '--test-reporter-destination=stdout',
    '--test-reporter=lcov', `--test-reporter-destination=${lcov}`,
    'test/*/*.test.js'
  ]
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit' })
    child.on('exit', (c, signal) => resolve(signal ? 1 : c ?? 1))
  })
  if (!fs.existsSync(lcov)) {
    console.error('\nNo coverage was written (coverage/lcov.info is missing).')
    process.exit(code || 1)
  }
  const linesOf = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n').length } catch { return 0 } }
  const report = summarize(parseLcov(fs.readFileSync(lcov, 'utf8')), sourceFiles(), linesOf)
  console.log(`\n${render(report, { worst })}\n\nLine by line: coverage/lcov.info`)
  // Failing tests fail the run; the numbers are a report, not a gate.
  process.exit(code)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main()
