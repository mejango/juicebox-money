import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'

const checker = resolve('scripts/check-client-budgets.mjs')
const directories: string[] = []
// Compresses above the aggregate budget; no generated JavaScript is executed.
const oversized = `const payload = '${randomBytes(3 * 1024 * 1024).toString('base64')}'`

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function checkProofBudget(shared: boolean, shippedReference = false, sourceStub = false) {
  const root = mkdtempSync(join(tmpdir(), 'client-proof-budget-'))
  directories.push(root)
  const write = (path: string, value: string) => {
    const file = join(root, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, value)
  }
  const proof = shared ? 'static/chunks/shared.js' : sourceStub ? 'static/chunks/app/proof/source/route.js' : 'static/chunks/app/proof/page.js'
  write('src/app/proof/page.browsertest.tsx', 'export default function Proof() { return null }')
  write('.next/build-manifest.json', '{}')
  write('.next/static/chunks/initial.js', 'const initial = true')
  write('.next/static/chunks/lazy.js', '"Raw transaction payload"; "Read-only checks of the selected project"; "mpcWorker-bundle"')
  write(`.next/${proof}`, oversized)
  const manifests: Record<string, string[]> = {
    '/page': ['static/chunks/initial.js'],
    '/[urn]/page': ['static/chunks/initial.js'],
    '/create/page': ['static/chunks/initial.js'],
    '/proof/page': sourceStub ? [] : [proof],
    // This route is outside the three initial-route budgets; its references
    // must still prevent a proof-looking asset from escaping the total.
    '/other/page': shippedReference ? [proof] : ['static/chunks/initial.js'],
  }
  for (const [route, chunks] of Object.entries(manifests)) {
    const versioned = chunks.map(file => `${file}?dpl=browser-test`)
    write(`.next/server/app/${route.slice(1)}_client-reference-manifest.js`,
      `globalThis.__RSC_MANIFEST = { ${JSON.stringify(route)}: ${JSON.stringify({ clientModules: { fixture: { chunks: versioned } } })} }`)
  }
  return spawnSync(process.execPath, [checker], { cwd: root, encoding: 'utf8', timeout: 10_000 })
}

it('excludes only dedicated browser-proof route chunks', () => {
  const result = checkProofBudget(false)
  expect(result.stderr).toBe('')
  expect(result.status).toBe(0)
  expect(result.stdout).toContain('PASS all scripts')
})

it('counts shared chunks even when only a browser proof references them', () => {
  const result = checkProofBudget(true)
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('aggregate client JavaScript exceeds budget')
})

it('excludes unreferenced source route stubs inside a browser-proof directory', () => {
  const result = checkProofBudget(false, false, true)
  expect(result.stderr).toBe('')
  expect(result.status).toBe(0)
  expect(result.stdout).toContain('PASS all scripts')
})

it('counts dedicated proof chunks when any shipped route also references them', () => {
  const result = checkProofBudget(false, true)
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('aggregate client JavaScript exceeds budget')
})
