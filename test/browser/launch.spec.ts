import { expect, test } from '@playwright/test'

const account = '0x1111111111111111111111111111111111111111'
const salt = `0x${'12'.repeat(32)}`
const environments = [
  {
    name: 'mainnet',
    chains: [10, 8453],
    paymentChainId: 10,
    paymentChainName: 'Optimism',
  },
  {
    name: 'testnet',
    chains: [11155111, 11155420, 84532, 421614],
    paymentChainId: 11155420,
    paymentChainName: 'Optimism Sepolia',
  },
] as const

test.use({ viewport: { width: 390, height: 844 } })

for (const environment of environments) {
  test(`does not offer a ${environment.name} funding chain before the launch quote`, async ({ page }) => {
    await page.addInitScript(({ account, salt, chains }) => {
      localStorage.setItem('jbm-launch-pending-v1', JSON.stringify({
        account,
        salt,
        transport: 'relayr',
        projectUri: 'ipfs://QmPendingLaunch',
        store: { name: 'Pending collection' },
        plans: Object.fromEntries(chains.map(chainId => [chainId, { projectName: 'Pending project' }])),
        chains,
        statuses: Object.fromEntries(chains.map(chainId => [chainId, { phase: 'pending' }])),
        createdAt: 1_800_000_000_000,
      }))
    }, { account, salt, chains: environment.chains })

    await page.goto('/create')
    const dialog = page.getByRole('dialog', { name: 'Confirm launch' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText("Sign each chain's launch request, then review the Relayr quote and pay once.")).toBeVisible()
    await expect(dialog.getByRole('combobox')).toHaveCount(0)
    await expect(dialog.getByText(/Checking the saved Relayr payment/)).toHaveCount(0)
  })

  test(`restores the chosen ${environment.name} funding chain and protects a published launch`, async ({ page }) => {
    await page.addInitScript(({ account, salt, chains, paymentChainId }) => {
      localStorage.setItem('jbm-launch-pending-v1', JSON.stringify({
        account,
        salt,
        transport: 'relayr',
        paymentChainId,
        projectUri: 'ipfs://QmPendingLaunch',
        store: { name: 'Pending collection' },
        plans: Object.fromEntries(chains.map(chainId => [chainId, { projectName: 'Pending project' }])),
        chains,
        statuses: Object.fromEntries(chains.map(chainId => [chainId, { phase: 'uncertain' }])),
        createdAt: 1_800_000_000_000,
        relayr: {
          account,
          paymentChainId,
          phase: 'payment-signing',
          published: true,
          signed: [],
          records: [],
        },
      }))
    }, { account, salt, chains: environment.chains, paymentChainId: environment.paymentChainId })

    await page.goto('/create')
    const dialog = page.getByRole('dialog', { name: 'Confirm launch' })
    await expect(dialog.getByRole('combobox')).toHaveCount(0)
    await expect(dialog.getByText(`Checking the saved Relayr payment on ${environment.paymentChainName}.`)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Check again', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Abandon this launch' })).toHaveCount(0)
    await expect(page.getByText('This launch has published authorizations that may still execute.')).toBeVisible()
    const width = await page.evaluate(() => ({
      content: document.documentElement.scrollWidth,
      viewport: document.documentElement.clientWidth,
    }))
    expect(width.content).toBeLessThanOrEqual(width.viewport + 1)
  })

  for (const transport of [undefined, 'direct'] as const) {
    test(`keeps an interrupted ${environment.name} ${transport ?? 'legacy'} launch on its direct transaction path`, async ({ page }) => {
      await page.addInitScript(({ salt, chains, transport }) => {
        localStorage.setItem('jbm-launch-pending-v1', JSON.stringify({
          salt,
          ...(transport ? { transport } : {}),
          projectUri: 'ipfs://QmLegacyLaunch',
          store: { name: 'Legacy collection' },
          plans: Object.fromEntries(chains.map(chainId => [chainId, { projectName: 'Legacy project' }])),
          chains,
          statuses: Object.fromEntries(chains.map(chainId => [chainId, { phase: 'pending' }])),
          createdAt: 1_800_000_000_000,
        }))
      }, { salt, chains: environment.chains, transport })

      await page.goto('/create')
      await expect(page.getByRole('heading', { name: 'Confirm launch', exact: true })).toBeVisible()
      await expect(page.getByRole('combobox', { name: /Pay the launch quote on/ })).toHaveCount(0)
      await expect(page.getByRole('dialog', { name: 'Confirm launch' })
        .getByRole('button', { name: 'Try again', exact: true })).toBeVisible()
      expect(await page.evaluate(() =>
        JSON.parse(localStorage.getItem('jbm-launch-pending-v1')!).transport,
      )).toBe(transport)
    })
  }
}
