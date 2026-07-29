import { spawn } from 'node:child_process'

const [command, ...args] = process.argv.slice(2)
if (!command) {
  throw new Error('Expected a command to run with deterministic browser env')
}

const fixtureOrigin =
  process.env.PLAYWRIGHT_FIXTURE_ORIGIN ??
  `http://127.0.0.1:${process.env.PLAYWRIGHT_FIXTURE_PORT ?? '4399'}`

const child = spawn(command, args, {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: {
    ...process.env,
    NEXT_PUBLIC_SITE_URL: fixtureOrigin,
    NEXT_PUBLIC_BENDYSTRAW_URL: `${fixtureOrigin}/graphql`,
    NEXT_PUBLIC_TESTNET_BENDYSTRAW_URL: `${fixtureOrigin}/graphql`,
    NEXT_PUBLIC_BROWSER_FIXTURE_ORIGIN: fixtureOrigin,
    NEXT_PUBLIC_DETERMINISTIC_BROWSER: 'true',
    NEXT_PUBLIC_DWELLIR_API_KEY: '',
    NEXT_PUBLIC_PARA_ENV: 'BETA',
    NEXT_PUBLIC_VERSION: 'browser-test',
    // Para validates presence during module initialization. This inert key is
    // never allowed onto the network by the browser suite.
    NEXT_PUBLIC_PARA_API_KEY: 'deterministic-browser-key',
  },
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal))
}

child.on('error', error => {
  throw error
})
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  process.exitCode = code ?? 1
})
