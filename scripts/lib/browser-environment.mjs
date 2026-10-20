/** The deterministic fixture's port: baked into the browser build's server reads. */
export const fixturePort = Number(process.env.PLAYWRIGHT_FIXTURE_PORT ?? 4399)
export const fixtureOrigin = `http://127.0.0.1:${fixturePort}`

/** The runtime environment of the deterministic browser build, served against the fixture. */
export function deterministicEnvironment(appPort) {
  return {
    HOSTNAME: '127.0.0.1',
    PORT: String(appPort),
    NEXT_PUBLIC_BENDYSTRAW_URL: `${fixtureOrigin}/graphql`,
    NEXT_PUBLIC_TESTNET_BENDYSTRAW_URL: `${fixtureOrigin}/graphql`,
    NEXT_PUBLIC_BROWSER_FIXTURE_ORIGIN: fixtureOrigin,
    NEXT_PUBLIC_DETERMINISTIC_BROWSER: 'true',
    NEXT_PUBLIC_PARA_ENV: 'BETA',
    NEXT_PUBLIC_VERSION: 'browser-test',
    NEXT_PUBLIC_PARA_API_KEY: 'deterministic-browser-key',
  }
}
