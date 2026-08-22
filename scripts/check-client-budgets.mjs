import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { runInNewContext } from 'node:vm'
import { gzipSync } from 'node:zlib'

const KIB = 1024
const distDir = resolve(process.env.NEXT_DIST_DIR || '.next')
const legacyManifestPath = join(distDir, 'app-build-manifest.json')

const budgets = {
  routes: {
    // The root layout carries the shared Wagmi + exact-transaction-review
    // runtime on every route. Keep a narrow ceiling around its measured size;
    // aggregate and largest-chunk budgets below still catch shared regressions.
    // The shared Bendystraw client includes fail-closed network routing, and
    // canonical SDK chain metadata replaces the warning-prone viem barrel.
    // The shared all-chain direct-pay and Permit2 review paths add ~6 KiB to
    // the landing route after package-import optimization. Next 16's emitted
    // route graph currently measures ~415 KiB in CI; keep a narrow ceiling
    // around that baseline while the aggregate and largest-chunk budgets below
    // still catch broader regressions.
    '/page': 418 * KIB,
    '/[urn]/page': 570 * KIB,
    // The production create graph measures ~470 KiB. Leave only a small
    // allowance for build variance.
    '/create/page': 476 * KIB,
  },
  // Counts every emitted chunk, including ones a visitor may never download.
  // WalletConnect (with @reown/appkit), Coinbase Wallet and Safe add ~690 KiB
  // of strictly lazy vendor SDK here; the per-route budgets above and the
  // per-SDK lazy-load assertions below are what actually protect first paint.
  allScripts: 2400 * KIB,
  largestChunk: 450 * KIB,
  // Halved when Para's modal stylesheet left with its modal; ratcheted so it cannot drift
  // back in unnoticed.
  styles: 20 * KIB,
}

function formatKiB(bytes) {
  return `${(bytes / KIB).toFixed(1)} KiB gzip`
}

function gzipSize(path) {
  return gzipSync(readFileSync(path)).byteLength
}

function filesBelow(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name)
    return statSync(path).isDirectory() ? filesBelow(path) : [path]
  })
}

function fail(message) {
  process.stderr.write(`Client budget failed: ${message}\n`)
  process.exitCode = 1
}

function loadPages() {
  if (existsSync(legacyManifestPath)) {
    return JSON.parse(readFileSync(legacyManifestPath, 'utf8')).pages ?? {}
  }

  // Next 16 moved App Router assets into one client-reference manifest per
  // route. Each manifest already includes that route's shared layout chunks.
  const pages = {}
  const buildManifestPath = join(distDir, 'build-manifest.json')
  const buildManifest = existsSync(buildManifestPath)
    ? JSON.parse(readFileSync(buildManifestPath, 'utf8'))
    : {}
  const commonScripts = [
    ...(buildManifest.rootMainFiles ?? []),
    ...(buildManifest.polyfillFiles ?? []),
  ]
  for (const route of ['/page', '/[urn]/page', '/create/page']) {
    const staticHtml =
      route === '/page'
        ? join(distDir, 'server', 'app', 'index.html')
        : route === '/create/page'
          ? join(distDir, 'server', 'app', 'create.html')
          : null
    if (staticHtml && existsSync(staticHtml)) {
      pages[route] = [
        ...new Set(
          [...readFileSync(staticHtml, 'utf8').matchAll(/(?:src|href)="([^"?]+\.js)(?:\?[^"?]*)?"/g)]
            .map(match => match[1])
            .filter(file => file.startsWith('/_next/'))
            .map(file => file.slice('/_next/'.length)),
        ),
      ]
      continue
    }
    const manifestPath = join(
      distDir,
      'server',
      'app',
      `${route.slice(1)}_client-reference-manifest.js`,
    )
    if (!existsSync(manifestPath)) continue
    const context = { globalThis: {} }
    runInNewContext(readFileSync(manifestPath, 'utf8'), context, {
      filename: manifestPath,
      timeout: 1_000,
    })
    const manifest = context.globalThis.__RSC_MANIFEST?.[route]
    pages[route] = [
      ...new Set(
        commonScripts.concat(
          Object.values(manifest?.clientModules ?? {})
          .flatMap(module => module.chunks ?? [])
          .filter(file => typeof file === 'string' && file.endsWith('.js'))
          .map(decodeURIComponent),
        ),
      ),
    ]
  }
  return pages
}

const pages = loadPages()
if (!Object.keys(pages).length) {
  throw new Error(
    `Missing App Router manifests under ${distDir}. Run \`npm run build\` before \`npm run budget\`.`,
  )
}
const layoutFiles = pages['/layout'] ?? []

process.stdout.write('Client JavaScript budgets\n')
for (const [route, limit] of Object.entries(budgets.routes)) {
  if (!pages[route]) {
    fail(`route ${route} is missing from the app build manifest`)
    continue
  }
  const files = [...new Set([...layoutFiles, ...pages[route]])].filter(file =>
    file.endsWith('.js'),
  )
  const actual = files.reduce((sum, file) => {
    const path = join(distDir, file)
    if (!existsSync(path)) {
      fail(`${route} references missing asset ${file}`)
      return sum
    }
    return sum + gzipSize(path)
  }, 0)
  const marker = actual <= limit ? 'PASS' : 'FAIL'
  process.stdout.write(
    `${marker} ${route.padEnd(14)} ${formatKiB(actual)} / ${formatKiB(limit)}\n`,
  )
  if (actual > limit) fail(`${route} exceeds its JavaScript budget`)
}

const chunks = filesBelow(join(distDir, 'static', 'chunks')).filter(path =>
  path.endsWith('.js'),
)
if (!chunks.length) {
  fail('no client JavaScript chunks were found')
} else {
  const allScriptSize = chunks.reduce((sum, path) => sum + gzipSize(path), 0)
  const allScriptMarker = allScriptSize <= budgets.allScripts ? 'PASS' : 'FAIL'
  process.stdout.write(
    `${allScriptMarker} all scripts    ${formatKiB(allScriptSize)} / ${formatKiB(
      budgets.allScripts,
    )}\n`,
  )
  if (allScriptSize > budgets.allScripts) {
    fail('aggregate client JavaScript exceeds budget')
  }

  const largest = chunks
    .map(path => ({ path, size: gzipSize(path) }))
    .sort((a, b) => b.size - a.size)[0]
  const marker = largest.size <= budgets.largestChunk ? 'PASS' : 'FAIL'
  process.stdout.write(
    `${marker} largest chunk  ${formatKiB(largest.size)} / ${formatKiB(
      budgets.largestChunk,
    )}\n`,
  )
  if (largest.size > budgets.largestChunk) {
    fail(`largest client chunk exceeds budget (${largest.path})`)
  }

  const paraScripts = chunks.filter(path => {
    const source = readFileSync(path, 'utf8')
    return (
      source.includes('mpcWorker-bundle') ||
      source.includes('api.beta.getpara') ||
      source.includes('api.getpara')
    )
  })
  if (!paraScripts.length) {
    fail('Para embedded-wallet runtime is missing from the production build')
  } else {
    const paraFiles = new Set(
      paraScripts.map(path => relative(distDir, path).split(sep).join('/')),
    )
    for (const route of ['/page', '/[urn]/page', '/create/page']) {
      const eagerPara = (pages[route] ?? []).filter(file => paraFiles.has(file))
      if (eagerPara.length) {
        fail(`Para wallet runtime is eagerly loaded by ${route}: ${eagerPara.join(', ')}`)
      }
    }
    process.stdout.write('PASS Para wallet runtime is lazy-loaded\n')
  }

  // Same contract for the other vendor wallet SDKs. wagmi's `reconnect()`
  // calls `getProvider()` on every configured connector, so any of these can
  // become an eager download from one missing `shouldRestore` gate — and
  // WalletConnect's SDK alone is larger than the whole per-route budget.
  //
  // Markers must be strings only the vendor bundle can contain — never a
  // connector id or display name, which our own source carries and which would
  // flag the module that merely *references* the wallet.
  const vendorWallets = [
    ['WalletConnect', ['walletconnect.org', 'wc@2:', '@reown/appkit']],
    ['Coinbase Wallet', ['CoinbaseWalletSDK', 'keys.coinbase.com', 'walletlink']],
    ['Safe', ['safe-apps-provider', 'SafeAppProvider']],
  ]
  for (const [label, markers] of vendorWallets) {
    const vendorFiles = new Set(
      chunks
        .filter(path => {
          const source = readFileSync(path, 'utf8')
          return markers.some(marker => source.includes(marker))
        })
        .map(path => relative(distDir, path).split(sep).join('/')),
    )
    if (!vendorFiles.size) continue
    const eager = []
    for (const route of ['/page', '/[urn]/page', '/create/page']) {
      eager.push(...(pages[route] ?? []).filter(file => vendorFiles.has(file)))
    }
    if (eager.length) {
      fail(`${label} SDK is eagerly loaded: ${[...new Set(eager)].join(', ')}`)
    } else {
      process.stdout.write(`PASS ${label} SDK is lazy-loaded\n`)
    }
  }
}

const styles = filesBelow(join(distDir, 'static', 'css')).filter(path =>
  path.endsWith('.css'),
)
const compiledStyles = styles.map(path => readFileSync(path, 'utf8')).join('\n')
// Nothing of Para's is rendered any more — sign-in, verification and the
// on-ramp handoff are all ours — so its modal stylesheet (112 KiB raw) has no
// job here. Its return would mean a Para-branded screen came back with it.
if (
  compiledStyles.includes('--para-color-') ||
  compiledStyles.includes('.para\\:')
) {
  fail('Para modal styles are back in the build — is a Para-rendered screen back too?')
} else {
  process.stdout.write('PASS no Para modal styles in the build\n')
}
const styleSize = styles.reduce((sum, path) => sum + gzipSize(path), 0)
const styleMarker = styleSize <= budgets.styles ? 'PASS' : 'FAIL'
process.stdout.write(
  `${styleMarker} all styles     ${formatKiB(styleSize)} / ${formatKiB(
    budgets.styles,
  )}\n`,
)
if (styleSize > budgets.styles) fail('compiled CSS exceeds its budget')
