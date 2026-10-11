import { expect, test } from '@playwright/test'

for (const width of [390, 1280]) {
  test(`native market inventory is read-only on payment and NFT surfaces at ${width}px`, async ({ page, context }) => {
    await page.setViewportSize({ width, height: 900 })
    await context.route(/^https?:\/\//, async route => {
      const url = new URL(route.request().url())
      if (['127.0.0.1', 'localhost'].includes(url.hostname)) return route.continue()
      await route.fulfill({ status: 503, body: '{}' })
    })
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto('/defifa-inventory-proof')
    await expect(page.locator('[data-defifa-ready="true"]')).toBeVisible()
    for (const name of ['Payment surface', 'NFT inventory']) {
      const surface = page.getByRole('region', { name, exact: true })
      await expect(surface.getByRole('row')).toHaveCount(8)
      await expect(surface).toContainText('Crab')
      await expect(surface).toContainText('1.25 USDC')
      await expect(surface.getByRole('link', { name: 'Open in Metalog →' })).toHaveAttribute('href', 'https://metalog.money/markets/1/1')
      await expect(surface.getByRole('button')).toHaveCount(0)
      await expect(surface.getByRole('spinbutton')).toHaveCount(0)
      await expect(surface).not.toContainText('Unlimited')
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(errors).toEqual([])
    await page.screenshot({ path: `test-results/defifa-inventory-${width}.png`, fullPage: true })
  })
}
