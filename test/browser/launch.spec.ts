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
    await expect(dialog.getByRole('button', { name: 'Cancel deployment' })).toHaveCount(0)
    await expect(dialog.getByText('This launch has published authorizations that may still execute.', { exact: false })).toBeVisible()
    const savedLaunch = await page.evaluate(() => localStorage.getItem('jbm-launch-pending-v1'))
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Cancel deployment' })).toHaveCount(0)
    await expect(page.getByText('This launch has published authorizations that may still execute.', { exact: false })).toBeVisible()
    await expect(page.getByRole('navigation', { name: 'Create steps' }).getByRole('button', { name: 'Look & Feel' })).toBeDisabled()
    expect(await page.evaluate(() => localStorage.getItem('jbm-launch-pending-v1'))).toBe(savedLaunch)
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

test('cancels a failed deployment from the form and keeps its draft editable', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.addInitScript(({ account, salt }) => {
    localStorage.setItem('jbm-create-draft', JSON.stringify({
      name: 'Keep my project', flavor: 'simple', owner: account,
      chains: [10], stages: [{}],
    }))
    localStorage.setItem('jbm-launch-pending-v1', JSON.stringify({
      account, salt, transport: 'direct',
      projectUri: 'ipfs://QmFailedLaunch',
      store: { name: 'Keep my collection' },
      plans: { 10: { projectName: 'Keep my project' } },
      chains: [10], statuses: { 10: { phase: 'failed' } },
      createdAt: 1_800_000_000_000,
    }))
  }, { account, salt })

  await page.goto('/create')
  const dialog = page.getByRole('dialog', { name: 'Confirm launch' })
  await expect(dialog.getByRole('button', { name: 'Cancel deployment', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)

  const steps = page.getByRole('navigation', { name: 'Create steps' })
  await expect(steps.getByRole('button', { name: 'Look & Feel' })).toBeDisabled()
  const retry = page.getByRole('button', { name: 'Try again', exact: true })
  await expect(retry).toBeVisible()
  const widths = await retry.evaluate(node => ({
    button: node.getBoundingClientRect().width,
    card: node.closest('section')!.getBoundingClientRect().width,
  }))
  expect(widths.button).toBeLessThan(widths.card * 0.6)

  await page.getByRole('button', { name: 'Cancel deployment', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Cancel deployment', exact: true })).toHaveCount(0)
  expect(await page.evaluate(() => localStorage.getItem('jbm-launch-pending-v1'))).toBeNull()
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('jbm-create-draft')!).name)).toBe('Keep my project')
  await expect(steps.getByRole('button', { name: 'Look & Feel' })).toBeEnabled()
  await steps.getByRole('button', { name: 'Look & Feel' }).click()
  const name = page.getByRole('textbox', { name: 'Project name' })
  await expect(name).toBeEnabled()
  await expect(name).toHaveValue('Keep my project')
  await name.fill('Edited project')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('jbm-create-draft')!).name)).toBe('Edited project')
})

test('keeps a failed deployment locked when its saved session cannot be removed', async ({ page }) => {
  await page.addInitScript(({ account, salt }) => {
    localStorage.setItem('jbm-create-draft', JSON.stringify({
      name: 'Recover my project', flavor: 'simple', owner: account,
      chains: [10], stages: [{}],
    }))
    localStorage.setItem('jbm-launch-pending-v1', JSON.stringify({
      account, salt, transport: 'direct',
      projectUri: 'ipfs://QmFailedLaunch',
      store: { name: 'Recovery collection' },
      plans: { 10: { projectName: 'Recover my project' } },
      chains: [10], statuses: { 10: { phase: 'failed' } },
      createdAt: 1_800_000_000_000,
    }))
    const removeItem = Storage.prototype.removeItem
    Storage.prototype.removeItem = function (key: string) {
      if (key === 'jbm-launch-pending-v1') throw new DOMException('Storage unavailable', 'SecurityError')
      removeItem.call(this, key)
    }
  }, { account, salt })

  await page.goto('/create')
  const dialog = page.getByRole('dialog', { name: 'Confirm launch' })
  await expect(dialog).toBeVisible()
  const savedLaunch = await page.evaluate(() => localStorage.getItem('jbm-launch-pending-v1'))
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await page.getByRole('button', { name: 'Cancel deployment', exact: true }).click()
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('Could not cancel this deployment. Restore browser storage and try again.', { exact: false })).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('jbm-launch-pending-v1'))).toBe(savedLaunch)
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('jbm-create-draft')!).name)).toBe('Recover my project')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: 'Create steps' }).getByRole('button', { name: 'Look & Feel' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible()
})

test('shows the submitted transaction warning beside cancellation on the form', async ({ page }) => {
  await page.route('**/api/project-ready?chainId=10&projectId=1', route => route.fulfill({ json: { found: false } }))
  await page.addInitScript(({ account, salt }) => {
    localStorage.setItem('jbm-create-draft', JSON.stringify({
      name: 'Partially launched project', flavor: 'simple', owner: account,
      chains: [10, 8453], stages: [{}],
    }))
    localStorage.setItem('jbm-launch-pending-v1', JSON.stringify({
      account, salt, transport: 'direct',
      projectUri: 'ipfs://QmPartialLaunch',
      store: { name: 'Partial collection' },
      plans: { 10: { projectName: 'Partially launched project' }, 8453: { projectName: 'Partially launched project' } },
      chains: [10, 8453],
      statuses: {
        10: { phase: 'done', projectId: 1 },
        8453: { phase: 'uncertain', txHash: `0x${'ab'.repeat(32)}` },
      },
      createdAt: 1_800_000_000_000,
    }))
  }, { account, salt })

  await page.goto('/create')
  const dialog = page.getByRole('dialog', { name: 'Confirm launch' })
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Cancel deployment', exact: true })).toBeVisible()
  const warning = page.getByText(/Cancelling stops this run\. The project already launched on Optimism is kept/)
  await expect(warning).toBeVisible()
  await expect(warning).toContainText('A launch on Base may also still confirm')
  await expect(warning).toContainText('launching again would create a duplicate project there')
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('jbm-launch-pending-v1')!).statuses[8453].txHash)).toBe(`0x${'ab'.repeat(32)}`)
})
