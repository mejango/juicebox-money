import { expect, test } from '@playwright/test'

for (const width of [390, 1280]) {
  test(`Defifa NFT inventory separates native actions from generic controls at ${width}px`, async ({ page, context }) => {
    await page.setViewportSize({ width, height: 900 })
    await context.route(/^https?:\/\//, async route => {
      const url = new URL(route.request().url())
      if (['127.0.0.1', 'localhost'].includes(url.hostname)) return route.continue()
      await route.fulfill({ status: 503, body: '{}' })
    })
    const errors: string[] = []
    const curveRequests: string[] = []
    page.on('request', request => { if (request.url().startsWith('https://metalog.money/')) curveRequests.push(request.url()) })
    page.on('pageerror', error => errors.push(error.message))
    await page.goto('/defifa-inventory-proof')
    await expect(page.locator('[data-defifa-ready="true"]')).toBeVisible()
    for (const name of ['Payment surface', 'NFT inventory']) {
      const surface = page.getByRole('region', { name, exact: true })
      await expect(surface.getByRole('row')).toHaveCount(8)
      await expect(surface).toContainText('Home team')
      await expect(surface).toContainText('Away team')
      await expect(surface).toContainText('2.75 USDC')
      await expect(surface).toContainText('Protocol phase: Complete')
      await expect(surface).toContainText('1.25 USDC')
      await expect(surface.locator('a[href^="https://metalog.money"]')).toHaveCount(0)
      await expect(surface.getByRole('columnheader', { name: 'Tier', exact: true })).toBeVisible()
      await expect(surface.getByRole('columnheader', { name: 'Name', exact: true })).toBeVisible()
      await expect(surface.getByRole('columnheader', { name: 'Current supply', exact: true })).toBeVisible()
      await expect(surface.getByRole('columnheader', { name: 'Price', exact: true })).toBeVisible()
      await expect(surface).not.toContainText('Metalog')
      await expect(surface.getByRole('tab')).toHaveCount(0)
      await expect(surface.getByRole('img')).toHaveCount(0)
      await expect(surface).not.toContainText('curve')
      await expect(surface).not.toContainText('·')
      await expect(surface.getByRole('button')).toHaveCount(1)
      if (name === 'Payment surface') await expect(surface.getByRole('button', { name: 'Add to balance', exact: true })).toBeEnabled()
      else await expect(surface.getByRole('button', { name: 'Connect wallet', exact: true })).toBeEnabled()
      await expect(surface.getByRole('spinbutton')).toHaveCount(0)
      await expect(surface).not.toContainText('Unlimited')
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(errors).toEqual([])
    expect(curveRequests).toEqual([])
    await page.screenshot({ path: `test-results/defifa-inventory-${width}.png`, fullPage: true })
  })

  test(`Defifa mint phase offers native tier quantities at ${width}px`, async ({ page, context }) => {
    await page.setViewportSize({ width, height: 900 })
    await context.route(/^https?:\/\//, async route => {
      const url = new URL(route.request().url())
      if (['127.0.0.1', 'localhost'].includes(url.hostname)) return route.continue()
      await route.fulfill({ status: 503, body: '{}' })
    })
    await page.goto('/defifa-inventory-proof?phase=mint')
    const surface = page.getByRole('region', { name: 'Payment surface', exact: true })
    await expect(surface.locator('output')).toHaveCount(7)
    await expect(surface.getByRole('button', { name: 'Connect wallet', exact: true })).toBeEnabled()
    await expect(surface.getByRole('button', { name: 'Add to balance', exact: true })).toBeEnabled()
    await expect(surface).toContainText('Home team')
    await expect(surface).toContainText('1.25 USDC')
    await expect(surface).not.toContainText('Metalog')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: `test-results/defifa-native-mint-${width}.png`, fullPage: true })
  })
}
