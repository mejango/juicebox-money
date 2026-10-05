import { expect, test } from '@playwright/test'

const report = (chainId: number, projectId: string) => ({
  checkedAt: '2026-10-04T12:00:00.000Z',
  deployment: {
    version: 6, chainId, projectId, kind: 'juicebox', checkedAt: '2026-10-04T12:00:00.000Z', checkedBlock: '1234',
    checks: [
      { id: 'owner', category: 'project', status: 'passed', label: `Project ${projectId}`, message: 'The project exists onchain.' },
      { id: 'hook', category: 'hook', status: 'unsupported', label: 'Custom hook', message: 'This custom hook needs its own checks.', actual: '0x1111111111111111111111111111111111111111' },
      { id: 'pricing', category: 'pricing', status: 'info', label: 'Shop pricing', message: 'Precision alone cannot verify an intended price.', actual: 'currency=2; decimals=18' },
    ],
  },
  indexer: { status: 'unavailable', message: 'The project data request failed. Indexing progress is unknown.' },
})

for (const width of [390, 1280]) {
  test(`deployment diagnostics recover data and copy a bounded report at ${width}px`, async ({ context, page }) => {
    await page.setViewportSize({ width, height: 900 })
    await context.route(/^https?:\/\//, async route => {
      const url = new URL(route.request().url())
      if (['127.0.0.1', 'localhost'].includes(url.hostname)) await route.continue()
      else await route.fulfill({ status: 503, body: '{}' })
    })
    await context.routeWebSocket(url => !['127.0.0.1', 'localhost'].includes(url.hostname), socket => socket.close())
    const reads: string[] = []
    await page.route('**/api/project-diagnostics?*', async route => {
      const params = new URL(route.request().url()).searchParams
      reads.push(`${params.get('chainId')}:${params.get('projectId')}`)
      await route.fulfill({ json: report(Number(params.get('chainId')), params.get('projectId')!) })
    })
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Clipboard blocked') } } })
    })
    await page.goto('/project-diagnostics-proof')
    await expect(page.locator('[data-diagnostics-ready="true"]')).toBeVisible()
    expect(reads).toEqual([])
    const failed = page.getByRole('region', { name: 'Unavailable project', exact: true })
    await expect(failed).toContainText('Some project details are unavailable')
    await expect(failed.getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Missing project record' })).toContainText('no project record')
    await expect(page.locator('[data-diagnostics-ready]')).not.toContainText(/catching up|just launched|finished indexing/)

    await failed.getByRole('button', { name: 'Check deployment', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Check deployment', exact: true })
    await expect(dialog).toContainText('Project 45')
    await expect(dialog).toContainText('Custom / unsupported')
    await expect(dialog).toContainText('Block 1234')
    await expect(dialog).not.toContainText('Mismatch')
    expect(await dialog.getByRole('button', { name: 'Copy diagnostics' }).evaluate(button => button.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44)
    await dialog.getByRole('button', { name: 'Copy diagnostics' }).click()
    const copy = dialog.getByRole('textbox', { name: 'Deployment diagnostics', exact: true })
    await expect(copy).toBeVisible()
    expect(JSON.parse(await copy.inputValue())).toEqual(report(84532, '45'))
    await dialog.getByRole('combobox', { name: 'Deployment', exact: true }).selectOption('1')
    await expect(dialog).toContainText('Project 9')
    await expect(copy).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()

    // A refresh may remove the selected linked chain. The next check must use
    // the remaining identity instead of a stale array index or report.
    await page.getByRole('button', { name: 'Refresh without linked chain' }).click()
    await failed.getByRole('button', { name: 'Check deployment', exact: true }).click()
    await expect(dialog).toContainText('Project 45')
    await expect(dialog.getByRole('combobox')).toHaveValue('0')
    expect(reads).toEqual(['84532:45', '1:9', '84532:45'])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: `test-results/project-diagnostics-${width}.png`, fullPage: true })
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await page.getByRole('region', { name: 'Healthy project', exact: true }).getByRole('button', { name: 'Check deployment', exact: true }).click()
    await expect(dialog).toContainText('Project 45')
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()

    // The production project page keeps its opt-in checker in Extras.
    await page.goto('/eth:1')
    await expect(page.getByRole('heading', { name: 'Browser Fixture Project', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Check deployment', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: /^More project sections/ }).click()
    await page.getByRole('tab', { name: 'Extras', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Deployment', exact: true })).toBeVisible()
    await page.screenshot({ path: `test-results/deployment-extras-${width}.png`, fullPage: true })
    await page.getByRole('button', { name: 'Check deployment', exact: true }).click()
    await expect(dialog).toContainText('Project 1')
  })
}
