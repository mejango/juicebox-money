import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { entryPage } from '../support/metalog-entries-fixture'
for (const width of [390, 1280]) {
  test(`native original entries preserve evidence, pagination and recovery at ${width}px`, async ({ page, context }) => {
    await page.setViewportSize({ width, height: 1000 })
    let reads = 0, fail = false
    await context.route(/^https?:\/\//, async route => {
      if (['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname)) return route.continue()
      return route.fulfill({ status: 503, body: '{}' })
    })
    await context.route('https://metalog.money/api/markets/1/1/entries?*', async route => {
      reads++
      const params = new URL(route.request().url()).searchParams
      if (fail) { fail = false; return route.fulfill({ status: 503, json: { error: 'Unavailable' } }) }
      const response = entryPage()
      if (params.has('cursor')) {
        expect(params.get('blockNumber')).toBe('100'); expect(params.get('cursor')).toBe('89:2147483647')
        response.entries = []; response.scannedFromBlock = '1'; response.scannedToBlock = '89'; response.complete = true; response.nextCursor = null
      } else {
        const manual = structuredClone(response.entries[0]); manual.transactionHash = `0x${'c'.repeat(64)}`; manual.status = 'verified-manual'
        const unknown = structuredClone(response.entries[0]); unknown.transactionHash = `0x${'d'.repeat(64)}`; unknown.status = 'unrecognized'; unknown.coefficients = null; unknown.chart = null; unknown.stakeWei = null; unknown.reason = 'No supported curve memo.'
        response.entries.push(manual, unknown)
      }
      return route.fulfill({ json: response })
    })
    await page.goto('/defifa-inventory-proof')
    await expect(page.getByText('Flavor: Defifa', { exact: true })).toBeVisible()
    expect(reads).toBe(0)
    const surface = page.getByRole('region', { name: 'NFT inventory', exact: true })
    await surface.getByRole('tab', { name: 'Entries', exact: true }).click()
    const entries = page.getByRole('region', { name: 'Original entries', exact: true })
    await expect(entries).toContainText('Snapshot block 100')
    await entries.locator('details > summary').filter({ hasText: /UTC/ }).first().click()
    await expect(entries.getByRole('img', { name: 'Submitted curve and actual minted position density', exact: true })).toBeVisible()
    await expect(entries.getByRole('link', { name: 'View mint receipt' }).first()).toHaveAttribute('href', `https://etherscan.io/tx/0x${'b'.repeat(64)}`)
    const download = page.waitForEvent('download'); await entries.getByRole('button', { name: 'Download entry JSON', exact: true }).first().click(); const artifact = await download; expect(artifact.suggestedFilename()).toContain('metalog-entry-')
    const evidence = JSON.parse(await readFile((await artifact.path())!, 'utf8'))
    expect(evidence).toMatchObject({ schema: 'metalog.entries.v1', exportScope: 'single-entry', chainId: 1, projectId: '1', blockNumber: '100', snapshotBlockHash: entryPage().snapshotBlockHash, hook: entryPage().hook, ranges: entryPage().ranges })
    expect(evidence.entries).toHaveLength(1); expect(evidence.entries[0].transactionHash).toBe(entryPage().entries[0].transactionHash)
    await entries.locator('details > summary').filter({ hasText: /By range entry/ }).click()
    await expect(entries.getByRole('img', { name: 'Reference curve and actual minted position density', exact: true })).toBeVisible()
    await entries.locator('details > summary').filter({ hasText: /Curve unavailable/ }).click()
    await expect(entries).toContainText('Stake unavailable'); await expect(entries).toContainText('No supported curve memo.')
    await expect(surface).not.toContainText('·')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
    await page.screenshot({ path: `test-results/defifa-entries-${width}.png`, fullPage: true })
    await entries.getByRole('button', { name: 'Load older entries', exact: true }).click()
    await expect(entries).toContainText('Reached the start of the entry period.')
    fail = true
    await entries.getByRole('button', { name: 'Refresh entries', exact: true }).click()
    await expect(entries.getByRole('alert')).toBeVisible()
    await entries.getByRole('button', { name: 'Retry entries', exact: true }).click()
    await expect(entries).toContainText('Snapshot block 100')
    await expect(entries.getByRole('alert')).toHaveCount(0)
  })
}
