import { expect, test } from '@playwright/test'

const CID = 'QmbWqxBEKC3P8tqsKc98xmWNzrzDtRLMiMPL8wBuTGsMnR'

test('the real browser adapter sends metadata to Juicebox Center', async ({
  context,
  page,
}) => {
  let pinRequests = 0
  await context.route(/^https?:\/\//, async route => {
    const hostname = new URL(route.request().url()).hostname
    if (hostname === '127.0.0.1' || hostname === 'localhost') {
      await route.continue()
      return
    }
    await route.fulfill({ status: 503, body: 'External traffic disabled' })
  })
  await context.route(
    'https://juicebox.center/v1/pins/json',
    async route => {
      pinRequests += 1
      expect(route.request().method()).toBe('POST')
      expect(route.request().postDataJSON()).toEqual({ name: 'Browser proof' })
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          cid: CID,
          status: 'queued',
          uri: `ipfs://${CID}`,
          gatewayUrl: `/ipfs/${CID}`,
        }),
      })
    },
  )

  await page.goto('/ipfs-proof', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('[data-ipfs-proof-ready="true"]')).toBeVisible()
  await page.getByRole('button', { name: 'Save metadata' }).click()

  await expect(page.getByTestId('pin-result')).toHaveText(`ipfs://${CID}`)
  expect(pinRequests).toBe(1)
})
