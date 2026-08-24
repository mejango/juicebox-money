import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const createConfig = require('../next.config.js') as () => {
  headers: () => Promise<
    { source: string; headers: { key: string; value: string }[] }[]
  >
}
const publicDirectory = fileURLToPath(new URL('../public/', import.meta.url))

describe('Safe App hosting', () => {
  it('allows only Safe Wallet to frame the app', async () => {
    const routes = await createConfig().headers()
    const appHeaders =
      routes.find(({ source }) => source === '/(.*)')?.headers ?? []
    const byName = Object.fromEntries(
      appHeaders.map(({ key, value }) => [key, value]),
    )

    expect(byName['Content-Security-Policy']).toBe(
      'frame-ancestors https://app.safe.global https://app.5afe.dev',
    )
    expect(byName['X-Frame-Options']).toBeUndefined()
  })

  it('serves a cross-origin-readable root manifest with a real icon', async () => {
    const routes = await createConfig().headers()
    const manifestHeaders =
      routes.find(({ source }) => source === '/manifest.json')?.headers ?? []
    expect(manifestHeaders).toContainEqual({
      key: 'Access-Control-Allow-Origin',
      value: '*',
    })

    const manifest = JSON.parse(
      readFileSync(`${publicDirectory}/manifest.json`, 'utf8'),
    ) as { name: string; iconPath: string; safe_apps_permissions: unknown[] }
    expect(manifest.name).toBe('Juicebox')
    expect(manifest.safe_apps_permissions).toEqual([])
    expect(() =>
      readFileSync(`${publicDirectory}${manifest.iconPath}`),
    ).not.toThrow()
  })
})
