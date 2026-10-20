import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { gzipSync } from 'node:zlib'
import {
  deterministicEnvironment,
  fixtureOrigin,
  fixturePort,
} from './lib/browser-environment.mjs'
import { referencedChunks } from './lib/referenced-chunks.mjs'
import { vendorWallets } from './lib/vendor-wallets.mjs'

// First-load JavaScript per route is what a visitor downloads before the page is
// interactive: every non-`nomodule` script the server-rendered HTML references,
// in its script tags and in the RSC payload the client hydrates from. Next's
// merged client-reference manifests can't stand in for it: inside a route group
// a client module shared by two entries carries the chunk list of whichever
// entry merged last, so leaks between routes read as nothing, and chunk paths
// carrying the deployment's `?dpl=` suffix were dropped outright (the /[urn]
// ceiling read 168.7 KiB against a real ~639). This check starts the
// deterministic browser build against the fail-fast fixture, fetches every
// shipped page route and gzips what its HTML references. Each ceiling is the
// route's measured size rounded up, plus 1 KiB so a one-line fix does not
// need a budget change; lower it when a change shrinks the route.
//
// Run after `npm run build:browser`. Every shipped page route must be listed.
const KIB = 1024
const account = `0x${'1'.repeat(40)}`
// Pages stream, so a 404 or a failed server render still answers 200 and
// would be measured in the route's place. `text` is what the page itself
// renders; a notFound() carries Next's HTTP fallback digest, and a section
// whose server render threw is handed to the client with `$RX(`.
const NOT_FOUND_DIGEST = 'NEXT_HTTP_ERROR_FALLBACK;404'
const RENDER_ERROR = '$RX('
const routes = [
  { route: '/', path: '/', kib: 341, text: 'Fund your' },
  { route: '/learn', path: '/learn', kib: 224, text: 'Learn Juicebox' },
  { route: '/build', path: '/build', kib: 226, text: 'Build on Juicebox' },
  { route: '/build/first-payment', path: '/build/first-payment', kib: 224, text: 'Your first Juicebox payment.' },
  { route: '/audit', path: '/audit', kib: 229, text: 'Verify Juicebox.' },
  { route: '/create', path: '/create', kib: 395, text: 'Start a project' },
  // 499 -> 502: the pay card decodes why a payment reverted (SDK 3.3.0 decodePayFailure) and offers a looser minimum.
  { route: '/[urn]', path: '/eth:1', kib: 502, text: 'Browser Fixture Project' },
  { route: '/account/[address]', path: `/account/${account}`, kib: 405, text: 'Holdings' },
  // Every unmatched path lands in a page that calls notFound(); pages stream, so
  // it answers 200 with the 404 page inside and loads that page's chunks too.
  { route: '/_not-found', path: '/account/not-an-account', kib: 224, text: 'This juicebox is empty', notFound: true },
  // Hands deeper legacy paths to old.juicebox.money; there is no page to load.
  { route: '/[urn]/[...rest]', path: '/v3/45', status: 307 },
]

const budgets = {
  // Every emitted chunk, including ones a visitor may never download.
  // WalletConnect (with @reown/appkit), Coinbase Wallet and Safe add ~690 KiB
  // of strictly lazy vendor SDK; the route ceilings and the lazy-load
  // assertions below are what protect first paint. History: git log -p.
  allScripts: 2615 * KIB,
  largestChunk: 400 * KIB,
  styles: 20 * KIB,
}

const distDir = resolve(process.env.NEXT_DIST_DIR || '.next')
const appRoutesManifestPath = join(distDir, 'app-path-routes-manifest.json')
if (!existsSync(join(distDir, 'standalone', 'server.js')) || !existsSync(appRoutesManifestPath)) {
  throw new Error(`Missing standalone build under ${distDir}. Run \`npm run build:browser\` first.`)
}

const failures = []
const fail = message => failures.push(message)
const formatKiB = bytes => `${(bytes / KIB).toFixed(1)} KiB gzip`

function filesBelow(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name)
    return statSync(path).isDirectory() ? filesBelow(path) : [path]
  })
}

const gzipSizes = new Map()
function gzipSize(asset) {
  const cached = gzipSizes.get(asset)
  if (cached !== undefined) return cached
  const path = join(distDir, asset)
  if (!existsSync(path)) throw new Error(`A page references a missing client asset: ${asset}`)
  const size = gzipSync(readFileSync(path)).byteLength
  gzipSizes.set(asset, size)
  return size
}

// `page.browsertest.tsx` routes compile only into the deterministic browser
// build and never ship; they need no budget and their own chunks don't count.
const appDirectory = resolve('src', 'app')
const proofRoutes = new Set(
  filesBelow(appDirectory)
    .filter(file => file.endsWith(`${sep}page.browsertest.tsx`))
    .map(file => `/${relative(appDirectory, dirname(file)).split(sep).join('/')}`),
)
const shippedRoutes = Object.entries(JSON.parse(readFileSync(appRoutesManifestPath, 'utf8')))
  .filter(([appPath]) => appPath.endsWith('/page'))
  .map(([, route]) => route)
  .filter(route => !proofRoutes.has(route))
  // Next's own fallback for a root-layout crash; nothing in src/app renders it.
  .filter(route => route !== '/_global-error')
const listed = new Set(routes.map(entry => entry.route))
for (const route of shippedRoutes) {
  if (!listed.has(route)) fail(`${route} is a shipped page with no rendered-HTML budget in this check`)
}

async function freePort() {
  const probe = createServer()
  await new Promise((done, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', done)
  })
  const { port } = probe.address()
  await new Promise(done => probe.close(done))
  return port
}

async function waitFor(url, child, label) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`${label} exited before it was ready (status ${child.exitCode})`)
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) })
      if (response.status < 500) return
    } catch {
      // Not listening yet.
    }
    await new Promise(done => setTimeout(done, 100))
  }
  throw new Error(`${label} did not become ready at ${url}`)
}

const appPort = await freePort()
const appOrigin = `http://127.0.0.1:${appPort}`
const environment = { ...process.env, ...deterministicEnvironment(appPort) }
const children = []
const start = args => {
  const child = spawn(process.execPath, args, { env: environment, stdio: 'ignore' })
  children.push(child)
  return child
}
const measured = []
try {
  const fixture = start(['test/browser/fail-fast-service.mjs', '--port', String(fixturePort)])
  await waitFor(`${fixtureOrigin}/health`, fixture, 'Browser fixture')
  const app = start(['scripts/start-standalone.mjs'])
  await waitFor(`${appOrigin}/api/healthz`, app, 'App')

  for (const entry of routes) {
    const response = await fetch(new URL(entry.path, appOrigin), {
      redirect: 'manual',
      signal: AbortSignal.timeout(120_000),
    })
    const html = await response.text()
    if (response.status !== (entry.status ?? 200)) {
      fail(`${entry.path} answered ${response.status}, expected ${entry.status ?? 200}`)
      continue
    }
    if (entry.text && !html.includes(entry.text)) {
      fail(`${entry.path} did not render "${entry.text}"`)
      continue
    }
    if (html.includes(NOT_FOUND_DIGEST) !== !!entry.notFound) {
      fail(`${entry.path} ${entry.notFound ? 'did not render' : 'rendered'} the 404 page`)
      continue
    }
    if (html.includes(RENDER_ERROR)) {
      fail(`${entry.path} streamed a server render error`)
      continue
    }
    if (entry.kib === undefined) continue
    const assets = referencedChunks(html)
    if (!assets.length) {
      fail(`${entry.path} references no client JavaScript`)
      continue
    }
    measured.push({ ...entry, assets, size: assets.reduce((sum, asset) => sum + gzipSize(asset), 0) })
  }
} finally {
  for (const child of children) child.kill('SIGTERM')
}

process.stdout.write('Client JavaScript budgets (rendered HTML)\n')
for (const entry of measured) {
  const limit = entry.kib * KIB
  const marker = entry.size <= limit ? 'PASS' : 'FAIL'
  process.stdout.write(
    `${marker} ${entry.route.padEnd(22)} ${formatKiB(entry.size).padStart(15)} / ${formatKiB(limit)}  ${String(entry.assets.length).padStart(3)} chunks  ${entry.path}\n`,
  )
  if (entry.size > limit) fail(`${entry.route} loads ${formatKiB(entry.size)} (budget ${entry.kib} KiB)`)
}
const routeAssets = new Set(measured.flatMap(entry => entry.assets))
const eagerIn = files => measured.flatMap(entry => entry.assets.filter(asset => files.has(asset)).map(asset => `${entry.route} ${asset}`))

const proofOnly = asset =>
  [...proofRoutes].some(route => asset.startsWith(`static/chunks/app${route}/`)) && !routeAssets.has(asset)
const chunks = filesBelow(join(distDir, 'static', 'chunks'))
  .filter(path => path.endsWith('.js'))
  .map(path => relative(distDir, path).split(sep).join('/'))
  .filter(asset => !proofOnly(asset))
const sources = new Map(chunks.map(asset => [asset, readFileSync(join(distDir, asset), 'utf8')]))
const chunksWith = markers => new Set(chunks.filter(asset => markers.some(marker => sources.get(asset).includes(marker))))

const allScriptSize = chunks.reduce((sum, asset) => sum + gzipSize(asset), 0)
process.stdout.write(
  `${allScriptSize <= budgets.allScripts ? 'PASS' : 'FAIL'} all scripts    ${formatKiB(allScriptSize)} / ${formatKiB(budgets.allScripts)}\n`,
)
if (allScriptSize > budgets.allScripts) fail('aggregate client JavaScript exceeds budget')

const largest = chunks.map(asset => ({ asset, size: gzipSize(asset) })).sort((a, b) => b.size - a.size)[0]
process.stdout.write(
  `${largest.size <= budgets.largestChunk ? 'PASS' : 'FAIL'} largest chunk  ${formatKiB(largest.size)} / ${formatKiB(budgets.largestChunk)}\n`,
)
if (largest.size > budgets.largestChunk) fail(`largest client chunk exceeds budget (${largest.asset})`)

// Code that must stay off every route's first load. Markers are strings only
// that code can contain, never a display name our own source carries.
// test/browser/startup-downloads.spec.ts covers vendor wallet SDKs a page
// downloads after it loads, which its HTML can't show.
const lazyCode = [
  ['transaction review dialog', ['Raw transaction payload'], true],
  ['deployment diagnostic dialog', ['Read-only checks of the selected project'], true],
  ['Para wallet runtime', ['mpcWorker-bundle', 'api.beta.getpara', 'api.getpara'], true],
  ...vendorWallets.map(([label, markers]) => [label, markers, false]),
]
for (const [label, markers, required] of lazyCode) {
  const files = chunksWith(markers)
  if (!files.size) {
    if (required) fail(`${label} is missing from the production build`)
    continue
  }
  const eager = eagerIn(files)
  if (eager.length) fail(`${label} is eagerly loaded: ${eager.join(', ')}`)
  else process.stdout.write(`PASS ${label} is lazy-loaded\n`)
}

const styles = filesBelow(join(distDir, 'static', 'css')).filter(path => path.endsWith('.css'))
const compiledStyles = styles.map(path => readFileSync(path, 'utf8')).join('\n')
if (compiledStyles.includes('--para-color-') || compiledStyles.includes('.para\\:')) {
  fail('Para modal styles are back in the build — is a Para-rendered screen back too?')
} else {
  process.stdout.write('PASS no Para modal styles in the build\n')
}
const styleSize = styles.reduce((sum, path) => sum + gzipSync(readFileSync(path)).byteLength, 0)
process.stdout.write(
  `${styleSize <= budgets.styles ? 'PASS' : 'FAIL'} all styles     ${formatKiB(styleSize)} / ${formatKiB(budgets.styles)}\n`,
)
if (styleSize > budgets.styles) fail('compiled CSS exceeds its budget')

for (const message of failures) process.stderr.write(`Client budget failed: ${message}\n`)
if (failures.length) process.exitCode = 1
