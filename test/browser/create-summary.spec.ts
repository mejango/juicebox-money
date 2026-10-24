import { expect, test } from '@playwright/test'

for (const width of [320, 1280]) {
  test(`launch summary aligns values and reveals creation fees at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    await page.addInitScript(() => {
      localStorage.setItem('jbm-create-draft', JSON.stringify({
        v: 1, flavor: 'project', name: 'Launch summary', owner: '', authorityMode: 'existing',
        accepts: ['eth'], chains: [11155111, 11155420, 421614, 84532],
        stages: [{ durationValue: '86400', issuanceRate: '10000', cutPct: '10' }],
        afterMode: 'terminal',
      }))
    })
    await page.goto('/create')
    await expect(page.locator('[data-create-ready="true"]')).toBeVisible()
    await page.getByRole('navigation', { name: 'Create steps' }).getByRole('button', { name: 'Launch', exact: true }).click()
    const rows = page.locator('dl[aria-label="Launch summary"]')
    await expect(rows).toBeVisible()
    const columns = await rows.evaluate(node => Array.from(node.children).map(row => {
      const label = row.querySelector('dt')!
      const value = row.querySelector('dd')!
      return {
        label: label.textContent,
        labelHeight: label.getBoundingClientRect().height,
        lineHeight: parseFloat(getComputedStyle(label).lineHeight),
        valueX: value.getBoundingClientRect().x,
        valueAlign: getComputedStyle(value).textAlign,
      }
    }))
    expect(columns.some(row => row.label?.includes('Ruleset #1'))).toBe(true)
    for (const column of columns) {
      expect(column.labelHeight, column.label ?? '').toBeLessThanOrEqual(column.lineHeight + 1)
      expect(column.valueX, column.label ?? '').toBeCloseTo(columns[0].valueX, 0)
      expect(['left', 'start']).toContain(column.valueAlign)
    }
    const fees = rows.locator('details')
    await expect(fees).not.toHaveAttribute('open', '')
    await expect(fees.locator('summary')).toContainText('ETH')
    await expect(fees.getByText('Optimism Sepolia', { exact: true })).toBeHidden()
    await rows.screenshot({ path: testInfo.outputPath('summary-collapsed.png') })
    await fees.locator('summary').click()
    await expect(fees).toHaveAttribute('open', '')
    await expect(fees.getByText('Optimism Sepolia', { exact: true })).toBeVisible()
    await expect(fees.locator('dd')).toHaveCount(4)
    for (const amount of await fees.locator('dd').all()) {
      await expect(amount).toHaveText(/\d.*(?:SepETH|OPSepETH|ArbSepETH|BaseSepETH)/)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
    await rows.screenshot({ path: testInfo.outputPath('summary-expanded.png') })
  })
}
