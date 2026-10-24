import { expect, test } from '@playwright/test'

for (const width of [320, 1280]) {
  test(`launch modal keeps separate labels and left-aligns all values at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    await page.addInitScript(() => {
      const chains = [11155111, 11155420, 421614, 84532]
      localStorage.setItem('jbm-create-draft', JSON.stringify({
        v: 1, flavor: 'simple', name: 'Modal alignment', owner: '', authorityMode: 'existing',
        accepts: ['eth'], chains, stages: [{}],
      }))
      localStorage.setItem('jbm-launch-pending-v1', JSON.stringify({
        salt: `0x${'12'.repeat(32)}`, transport: 'direct', projectUri: 'ipfs://QmModalAlignment',
        store: { name: 'Modal collection' },
        plans: Object.fromEntries(chains.map(chainId => [chainId, { projectName: 'Modal alignment' }])),
        chains, statuses: Object.fromEntries(chains.map(chainId => [chainId, { phase: 'failed' }])),
        createdAt: 1_800_000_000_000,
      }))
    })
    await page.goto('/create')
    const dialog = page.getByRole('dialog', { name: 'Confirm launch' })
    await expect(dialog).toBeVisible()
    const grid = dialog.getByText('Launching', { exact: true }).locator('..')
    const rows = await grid.evaluate(node => Array.from(node.children).filter((_, index) => index % 2 === 0).map(label => {
      const value = label.nextElementSibling!
      const text = document.createRange()
      text.selectNodeContents(label)
      return {
        label: label.textContent,
        value: value.textContent,
        valueX: value.getBoundingClientRect().x,
        valueAlign: getComputedStyle(value).textAlign,
        labelHeight: text.getBoundingClientRect().height,
        lineHeight: parseFloat(getComputedStyle(label).lineHeight),
        labelWhiteSpace: getComputedStyle(label).whiteSpace,
      }
    }))
    expect(rows.map(row => row.label)).toEqual(['Project owner', 'Launching', 'Chains', 'Accounting', 'Rules', 'Creation fees'])
    expect(rows.find(row => row.label === 'Launching')?.value).toBe('Simple project')
    expect(rows.find(row => row.label === 'Accounting')?.value).toBe('ETH')
    expect(rows.find(row => row.label === 'Rules')?.value).toContain('Issues 10,000 tokens per ETH')
    for (const chain of ['Sepolia', 'Optimism Sepolia', 'Arbitrum Sepolia', 'Base Sepolia']) {
      expect(rows.find(row => row.label === 'Chains')?.value).toContain(chain)
    }
    for (const row of rows) {
      expect(['left', 'start']).toContain(row.valueAlign)
      expect(row.valueX, row.label ?? '').toBeCloseTo(rows[0].valueX, 0)
      expect(row.labelWhiteSpace).toBe('nowrap')
      expect(row.labelHeight, row.label ?? '').toBeLessThanOrEqual(row.lineHeight + 1)
    }
    expect(await dialog.locator('[data-tx-confirm]').evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('modal-left-aligned.png') })
  })

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
