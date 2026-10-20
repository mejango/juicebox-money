import { expect, test } from '@playwright/test'
import { vendorWallets } from '../../scripts/lib/vendor-wallets.mjs'

// The budget gate reads each route's HTML; this covers what a page imports on
// its own once it hydrates. Without an interaction, no vendor wallet SDK loads.
for (const path of ['/', '/eth:1']) {
  test(`${path} downloads no vendor wallet SDK before an interaction`, async ({ page }) => {
    const bodies: Promise<string>[] = []
    page.on('response', response => {
      if (response.url().includes('/_next/static/chunks/')) bodies.push(response.text())
    })
    await page.goto(path, { waitUntil: 'load' })
    await page.waitForLoadState('networkidle')
    const sources = await Promise.all(bodies)
    expect(sources.length).toBeGreaterThan(0)
    for (const [label, markers] of vendorWallets) {
      const eager = sources.filter(source => markers.some(marker => source.includes(marker)))
      expect(eager, `${label} downloaded at startup`).toHaveLength(0)
    }
  })
}
