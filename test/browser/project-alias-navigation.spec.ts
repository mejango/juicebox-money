import { expect, test } from '@playwright/test'

const aliasPath = '/@browser-fixture'
const fixtureOrigin = process.env.PLAYWRIGHT_FIXTURE_ORIGIN ??
  `http://127.0.0.1:${process.env.PLAYWRIGHT_FIXTURE_PORT ?? '4399'}`

for (const width of [390, 1280]) {
  test(`verified handle navigation preserves its document and draft at ${width}px`, async ({ context, page, request }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width, height: 900 })
    const errors: string[] = []
    const external: string[] = []
    const documents: string[] = []
    const projectRsc: string[] = []
    let proofRequests = 0
    let failNextProof = false
    page.on('pageerror', error => errors.push(error.message))
    page.on('request', incoming => {
      const url = new URL(incoming.url())
      if (incoming.resourceType() === 'document') documents.push(url.pathname)
      if (url.pathname === aliasPath && incoming.headers().rsc === '1') projectRsc.push(url.pathname)
      if (url.pathname === '/api/project-route') proofRequests++
    })
    await context.route(/^https?:\/\//, async route => {
      const url = new URL(route.request().url())
      if (['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) return route.continue()
      external.push(url.href)
      await route.fulfill({ status: 503, body: 'External browser traffic is disabled' })
    })
    await context.routeWebSocket(url => !['127.0.0.1', 'localhost', '::1'].includes(url.hostname), socket => {
      external.push(socket.url())
      socket.close()
    })
    await page.route('**/api/project-route?*', async route => {
      if (!failNextProof) return route.continue()
      failNextProof = false
      await route.fulfill({ status: 503, json: { error: 'Fixture verification unavailable' } })
    })
    await page.addInitScript(() => {
      (window as Window & { aliasDocumentId?: string }).aliasDocumentId = crypto.randomUUID()
    })
    const readDocumentId = () => page.evaluate(() => (window as Window & { aliasDocumentId?: string }).aliasDocumentId)
    const firstProof = page.waitForResponse(response => new URL(response.url()).pathname === '/api/project-route' && response.status() === 200)
    await page.goto(aliasPath)
    expect(await (await firstProof).json()).toMatchObject({ chainId: 1, projectId: '1', handle: 'browser-fixture' })
    await expect(page.getByRole('heading', { name: 'Browser Fixture Project', exact: true })).toBeVisible()
    const note = page.locator('#project-pay-card').getByLabel('Note', { exact: true })
    await note.fill('Keep this draft through alias navigation')
    const documentId = await readDocumentId()
    expect(documentId).toBeTruthy()
    const tabs = page.getByRole('tablist', { name: 'Project sections' })
    const selectTab = async (name: string) => {
      const tab = tabs.getByRole('tab', { name, exact: true })
      await tab.click()
      await expect(tab).toHaveAttribute('aria-selected', 'true')
    }
    await selectTab('Terms')
    const stages = page.getByRole('region', { name: 'Revnet stages' })
    await expect(stages.locator('tbody tr').first().locator('td').nth(2)).toHaveText('1')
    const range = page.getByRole('combobox', { name: 'Time range', exact: true })
    await expect(range).toBeVisible()
    const originalRange = await range.inputValue()
    const alternateRange = await range.locator('option').evaluateAll((options, current) =>
      options.map(option => (option as HTMLOptionElement).value).find(value => value !== current)!, originalRange)
    await range.selectOption(alternateRange)
    await expect(range).toHaveValue(alternateRange)
    await selectTab('Overview')
    await selectTab('Terms')
    await expect(range).toHaveValue(alternateRange)

    // Native hash navigation adds a history entry; browser Back/Forward must
    // verify an alias without replacing its document or losing retained tabs.
    await page.evaluate(() => { window.location.hash = '#owners' })
    await expect(tabs.getByRole('tab', { name: 'Owners', exact: true })).toHaveAttribute('aria-selected', 'true')
    await page.goBack()
    await expect(tabs.getByRole('tab', { name: 'Terms', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(range).toHaveValue(alternateRange)
    await page.goForward()
    await expect(tabs.getByRole('tab', { name: 'Owners', exact: true })).toHaveAttribute('aria-selected', 'true')
    await selectTab('Terms')
    await expect(note).toHaveValue('Keep this draft through alias navigation')

    const beforeIdle = proofRequests
    await page.waitForTimeout(5_200)
    expect(proofRequests, 'alias leases must not poll while idle').toBe(beforeIdle)
    failNextProof = true
    const failedProof = page.waitForResponse(response => new URL(response.url()).pathname === '/api/project-route' && response.status() === 503)
    await tabs.getByRole('tab', { name: 'Owners', exact: true }).click()
    await failedProof
    const retry = page.getByRole('button', { name: 'Try again', exact: true })
    await expect(retry).toBeVisible()
    await expect(note).toBeHidden()
    expect(await page.evaluate(() => location.hash)).toBe('#terms')
    expect(await readDocumentId()).toBe(documentId)
    await retry.click()
    await expect(retry).toHaveCount(0)
    await expect(note).toHaveValue('Keep this draft through alias navigation')
    await expect(range).toHaveValue(alternateRange)
    // Retry re-enables the existing view; it does not replay the failed click.
    await expect(tabs.getByRole('tab', { name: 'Terms', exact: true })).toHaveAttribute('aria-selected', 'true')
    await selectTab('Owners')
    expect(await readDocumentId()).toBe(documentId)
    expect(documents).toEqual([aliasPath])
    expect(projectRsc).toEqual([])
    expect(errors).toEqual([])
    expect(external).toEqual([])

    const status = await (await request.get(`${fixtureOrigin}/__fixture/status`)).json()
    for (const name of ['ENSRegistry.resolver', 'ENSRegistry.owner', 'ENSResolver.text', 'JBProjectHandles.handleOf']) {
      expect(status.contracts[name], `real alias proof must read ${name}`).toBeGreaterThan(0)
    }
    expect(status.unknown).toEqual([])
  })
}
