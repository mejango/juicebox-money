import { expect, test } from '@playwright/test'

const account = '0x1111111111111111111111111111111111111111'
const salt = `0x${'12'.repeat(32)}`

test.use({ viewport: { width: 390, height: 844 } })

test('restores the chosen funding chain and protects a published launch', async ({ page }) => {
  await page.addInitScript(({ account, salt }) => {
    localStorage.setItem('jbm-launch-pending-v1', JSON.stringify({
      account,
      salt,
      transport: 'relayr',
      paymentChainId: 10,
      projectUri: 'ipfs://QmPendingLaunch',
      store: { name: 'Pending collection' },
      plans: { 10: { projectName: 'Pending project' }, 8453: { projectName: 'Pending project' } },
      chains: [10, 8453],
      statuses: { 10: { phase: 'uncertain' }, 8453: { phase: 'uncertain' } },
      createdAt: 1_800_000_000_000,
      relayr: {
        account,
        paymentChainId: 10,
        phase: 'payment-signing',
        published: true,
        signed: [],
        records: [],
      },
    }))
  }, { account, salt })

  await page.goto('/create')
  const fundingChain = page.getByRole('combobox', { name: /Pay the launch quote on/ })
  await expect(fundingChain).toHaveValue('10')
  await expect(fundingChain).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Check again', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Abandon this launch' })).toHaveCount(0)
  await expect(page.getByText('This launch has published authorizations that may still execute.')).toBeVisible()
  const width = await page.evaluate(() => ({
    content: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth,
  }))
  expect(width.content).toBeLessThanOrEqual(width.viewport + 1)
})

test('keeps an interrupted legacy launch on its direct transaction path', async ({ page }) => {
  await page.addInitScript(({ salt }) => {
    localStorage.setItem('jbm-launch-pending-v1', JSON.stringify({
      salt,
      projectUri: 'ipfs://QmLegacyLaunch',
      store: { name: 'Legacy collection' },
      plans: { 10: { projectName: 'Legacy project' }, 8453: { projectName: 'Legacy project' } },
      chains: [10, 8453],
      statuses: { 10: { phase: 'pending' }, 8453: { phase: 'pending' } },
      createdAt: 1_800_000_000_000,
    }))
  }, { salt })

  await page.goto('/create')
  await expect(page.getByRole('heading', { name: 'Confirm launch', exact: true })).toBeVisible()
  await expect(page.getByRole('combobox', { name: /Pay the launch quote on/ })).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: 'Confirm launch' })
    .getByRole('button', { name: 'Try again', exact: true })).toBeVisible()
})
