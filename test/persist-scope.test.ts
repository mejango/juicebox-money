import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Persisted queries outlive the session in localStorage. Anything keyed to a
 * wallet must never go there: a later visitor on the same browser would see
 * the previous account's balances, allowances or holdings restored as if they
 * were their own.
 *
 * This scans the source rather than the runtime because the risk is a future
 * edit tagging the wrong query, and that should fail in CI, not in a browser.
 */
const ACCOUNT_HINTS = ['address', 'holder', 'account', 'wallet']

function sourceFiles(dir = 'src'): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    return /\.tsx?$/.test(entry.name) ? [full] : []
  })
}

describe('persisted query scope', () => {
  it('never persists a query keyed to a wallet', () => {
    const offenders: string[] = []

    for (const file of sourceFiles()) {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, index) => {
        const tagged =
          line.includes('meta: PERSIST') ||
          line.includes("persist: 'revalidate'") ||
          line.includes("persist: 'immutable'")
        if (!tagged) return

        // The key is on a nearby line — check the surrounding block.
        const window = lines.slice(Math.max(0, index - 6), index + 7).join('\n')
        const keyMatch = window.match(/queryKey: (\[[^\]]*\])/)
        if (!keyMatch) return
        const key = keyMatch[1].toLowerCase()
        if (ACCOUNT_HINTS.some(hint => key.includes(hint))) {
          offenders.push(`${file}: ${keyMatch[1]}`)
        }
      })
    }

    expect(offenders).toEqual([])
  })

  it('finds the tagged queries at all, so the scan cannot silently pass', () => {
    const tagged = sourceFiles().filter(file =>
      readFileSync(file, 'utf8').includes('meta: PERSIST'),
    )
    expect(tagged.length).toBeGreaterThan(5)
  })
})
