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
  it('lets only the Safe app and plugin.money frame the app', async () => {
    const routes = await createConfig().headers()
    const appHeaders =
      routes.find(({ source }) => source === '/(.*)')?.headers ?? []
    const byName = Object.fromEntries(
      appHeaders.map(({ key, value }) => [key, value]),
    )
    const policy = byName['Content-Security-Policy']

    expect(policy).toBe(
      'frame-ancestors https://app.safe.global https://app.5afe.dev https://plugin.money https://www.plugin.money',
    )
    // The exact match above is the real assertion; these say what it is protecting, so a
    // future edit that widens the allowlist fails for a legible reason.
    expect(policy).not.toMatch(/\*|'unsafe|http:\/\//u)
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
    const safeIcon = readFileSync(
      `${publicDirectory}${manifest.iconPath}`,
      'utf8',
    )
    const brandIcon = readFileSync(
      fileURLToPath(new URL('../src/assets/brand/logo-icon.svg', import.meta.url)),
      'utf8',
    )
    const canonicalPath = brandIcon.match(/<path d="([^"]+)"/u)?.[1]
    expect(canonicalPath).toBeTruthy()
    expect(safeIcon).toContain(`d="${canonicalPath}"`)
    expect(safeIcon).toContain('viewBox="0 0 128 128"')
  })
})
