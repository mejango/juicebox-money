import { spawn } from 'node:child_process'
import { createServer } from 'node:net'

function onceExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
}

async function ephemeralPort() {
  const probe = createServer()
  await new Promise((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', resolve)
  })
  const address = probe.address()
  if (!address || typeof address === 'string') {
    probe.close()
    throw new Error('Could not reserve a deterministic build-fixture port')
  }
  const port = address.port
  await new Promise((resolve, reject) =>
    probe.close(error => (error ? reject(error) : resolve())),
  )
  return port
}

async function waitForHealth(origin, fixtureExit) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const exited = await Promise.race([
      fixtureExit.then(result => ({ exited: result })),
      new Promise(resolve => setTimeout(() => resolve(null), 50)),
    ])
    if (exited) {
      throw new Error(
        `Build fixture exited before readiness (${JSON.stringify(exited.exited)})`,
      )
    }
    try {
      const response = await fetch(`${origin}/health`, {
        signal: AbortSignal.timeout(500),
      })
      if (response.status === 204) return
    } catch {
      // The fixture may still be binding; retry within the bounded deadline.
    }
  }
  throw new Error('Build fixture did not become healthy within 10 seconds')
}

function missingReads(actual, required) {
  return required.filter(key => !Number.isInteger(actual[key]) || actual[key] < 1)
}

async function stopFixture(child, fixtureExit) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  const stopped = await Promise.race([
    fixtureExit.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 5_000)),
  ])
  if (!stopped) child.kill('SIGKILL')
}

const port = await ephemeralPort()
const origin = `http://127.0.0.1:${port}`
const runtimeFixtureOrigin =
  process.env.PLAYWRIGHT_FIXTURE_ORIGIN ??
  `http://127.0.0.1:${process.env.PLAYWRIGHT_FIXTURE_PORT ?? '4399'}`
const fixture = spawn(
  process.execPath,
  ['test/browser/fail-fast-service.mjs', '--port', String(port)],
  { stdio: 'inherit' },
)
const fixtureExit = onceExit(fixture)

try {
  await waitForHealth(origin, fixtureExit)
  const buildEnv = {
    ...process.env,
    PLAYWRIGHT_FIXTURE_ORIGIN: runtimeFixtureOrigin,
    NEXT_PUBLIC_SITE_URL: runtimeFixtureOrigin,
    NEXT_PUBLIC_DETERMINISTIC_BROWSER: 'true',
    NEXT_PUBLIC_TESTNET: 'false',
    NEXT_PUBLIC_INFURA_ID: '',
    NEXT_PUBLIC_PARA_ENV: 'BETA',
    NEXT_PUBLIC_VERSION: 'browser-test',
    NEXT_PUBLIC_PARA_API_KEY: 'deterministic-browser-key',
  }
  delete buildEnv.BROWSER_BUILD_FIXTURE_ORIGIN
  // Exercise the same homepage data functions before compilation. Next can
  // classify the deterministic no-store homepage as dynamic, so this bounded
  // preflight prevents its allSettled fallback from hiding a dead build URL.
  const dataPreflight = spawn(
    process.execPath,
    ['--import', 'tsx', 'scripts/check-browser-build-data.ts'],
    {
      stdio: 'inherit',
      env: { ...buildEnv, BROWSER_BUILD_FIXTURE_ORIGIN: origin },
    },
  )
  const preflightResult = await onceExit(dataPreflight)
  if (preflightResult.code !== 0) {
    throw new Error(
      `Deterministic build-data preflight failed (${preflightResult.signal ?? preflightResult.code})`,
    )
  }

  const build = spawn(
    process.execPath,
    ['scripts/with-browser-env.mjs', 'npm', 'run', 'build'],
    {
      stdio: 'inherit',
      env: buildEnv,
    },
  )
  const result = await onceExit(build)
  if (result.code !== 0) {
    throw new Error(
      `Deterministic browser build failed (${result.signal ?? result.code})`,
    )
  }

  const response = await fetch(`${origin}/__fixture/status`, {
    signal: AbortSignal.timeout(5_000),
  })
  if (!response.ok) {
    throw new Error(`Build fixture audit returned HTTP ${response.status}`)
  }
  const status = await response.json()
  const missing = missingReads(status.graphql ?? {}, [
    'trending',
    'recentActivity',
    'legacyProjects',
  ])
  if (status.unknown?.length || missing.length) {
    throw new Error(
      [
        'Deterministic build fixture audit failed.',
        status.unknown?.length
          ? `Unexpected requests: ${JSON.stringify(status.unknown, null, 2)}`
          : '',
        missing.length
          ? `Missing build GraphQL reads: ${missing.join(', ')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    )
  }
} finally {
  await stopFixture(fixture, fixtureExit)
}
