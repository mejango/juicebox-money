import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

const signers = [
  '0x1111111111111111111111111111111111111111',
  '0x2222222222222222222222222222222222222222',
  '0x3333333333333333333333333333333333333333',
]

test.use({ viewport: { width: 320, height: 720 } })

test('creates owner and operator policies without enabling authority by default', async ({ page }) => {
  await page.goto('/create')
  await expect(page.locator('[data-create-ready="true"]')).toBeVisible()
  const allowChanges = page.getByRole('checkbox', { name: /Allow changes/ })
  await expect(allowChanges).not.toBeChecked()
  await expect(page.getByLabel('Owner signer 1', { exact: true })).toHaveCount(0)
  await allowChanges.click()
  await expect(page.getByLabel('Owner approval policy')).toHaveValue('2')
  for (const [index, signer] of signers.entries()) {
    await page.getByLabel(`Owner signer ${index + 1}`, { exact: true }).fill(signer)
  }
  const policyWidth = await page.getByLabel('Owner approval policy').evaluate(node => node.getBoundingClientRect().width)
  expect(policyWidth).toBeLessThanOrEqual(180)
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
  await page.getByRole('button', { name: 'Already have an owner in mind?' }).click()
  await expect(page.getByLabel('Project owner', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Project owner', { exact: true })).toHaveValue('')
  await expect(page.getByText('Use your wallet or an existing multisig.')).toBeVisible()
  await expect(page.getByText('Leave empty to use your connected wallet.')).toBeVisible()
  await page.getByLabel('Project owner', { exact: true }).fill(signers[0])
  await page.getByRole('button', { name: 'Create a new multisig?' }).click()
  await expect(page.getByLabel('Owner signer 1', { exact: true })).toHaveValue(signers[0])
  await page.getByLabel('Project flavor').selectOption('revnet')
  await expect(page.getByLabel('Operator signer 1', { exact: true })).toHaveValue(signers[0])
  await expect(page.getByText('Create a multisig so its signers approve decisions together.')).toBeVisible()
  await page.getByRole('button', { name: 'Already have an operator in mind?' }).click()
  await expect(page.getByLabel('Revnet operator', { exact: true })).toHaveValue(signers[0])
  await expect(page.getByLabel('Operator signer 1', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Create a new multisig?' }).click()
  await expect(page.getByLabel('Operator signer 1', { exact: true })).toHaveValue(signers[0])
  await page.getByRole('button', { name: 'Remove operator signer 3' }).click()
  await expect(page.getByLabel('Operator approval policy')).toContainText('2 of 2')
  await expect(page.getByRole('button', { name: 'Remove operator signer 1' })).toBeDisabled()
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
  const dimensions = await page.evaluate(() => ({ content: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }))
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1)
})

test('restores legacy authority addresses and per-chain overrides in existing mode', async ({ page }) => {
  await page.addInitScript(({ signers }) => {
    localStorage.setItem('jbm-create-draft', JSON.stringify({
      name: 'Legacy owner', flavor: 'simple', owner: signers[0],
      ownerPerChain: { 10: signers[1] }, chains: [10, 8453], stages: [{}],
    }))
  }, { signers })
  await page.goto('/create')
  await expect(page.locator('[data-create-ready="true"]')).toBeVisible()
  await expect(page.getByLabel('Project owner', { exact: true })).toHaveValue(signers[0])
  await expect(page.getByLabel('Owner signer 1', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: /Set per chain — if the project owner/ }).click()
  await expect(page.getByLabel('Project owner on Optimism', { exact: true })).toHaveValue(signers[1])
  await page.getByRole('button', { name: 'Create a new multisig?' }).click()
  await page.getByRole('button', { name: 'Already have an owner in mind?' }).click()
  await expect(page.getByLabel('Project owner on Optimism', { exact: true })).toHaveValue(signers[1])
})

test('persists a new approval policy across a reload', async ({ page }) => {
  await page.goto('/create')
  await expect(page.locator('[data-create-ready="true"]')).toBeVisible()
  await page.getByRole('checkbox', { name: /Allow changes/ }).click()
  for (const [index, signer] of signers.entries()) {
    await page.getByLabel(`Owner signer ${index + 1}`, { exact: true }).fill(signer)
  }
  await page.getByLabel('Owner approval policy').selectOption('3')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('jbm-create-draft') ?? '{}').authorityThreshold)).toBe(3)
  await page.reload()
  await expect(page.getByLabel('Owner approval policy')).toHaveValue('3')
  for (const [index, signer] of signers.entries()) {
    await expect(page.getByLabel(`Owner signer ${index + 1}`, { exact: true })).toHaveValue(signer)
  }
})

for (const role of ['owner', 'operator'] as const) {
  test(`launch explains an incomplete ${role} multisig and links back to its settings`, async ({ page }) => {
    await page.goto('/create')
    await expect(page.locator('[data-create-ready="true"]')).toBeVisible()
    if (role === 'operator') await page.getByLabel('Project flavor').selectOption('revnet')
    await page.getByRole('checkbox', { name: role === 'owner' ? /Allow changes/ : /Enable limited operator controls/ }).click()
    const roleLabel = role === 'owner' ? 'Owner' : 'Operator'
    for (const index of [0, 1]) {
      await page.getByLabel(`${roleLabel} signer ${index + 1}`, { exact: true }).fill(signers[index])
    }
    const steps = page.getByRole('navigation', { name: 'Create steps' })
    await steps.getByRole('button', { name: 'Launch', exact: true }).click()
    const warning = page.getByRole('alert').filter({ hasText: `Complete the ${role} multisig` })
    await expect(warning).toBeVisible()
    await warning.getByRole('button', { name: role === 'owner' ? 'Edit project owner' : 'Edit revnet operator' }).click()
    await expect(steps.getByRole('button', { name: 'Flavor', exact: true })).toHaveAttribute('aria-current', 'step')
    await page.getByRole('button', { name: `Remove ${role} signer 3` }).click()
    await steps.getByRole('button', { name: 'Launch', exact: true }).click()
    await expect(warning).toHaveCount(0)
    await steps.getByRole('button', { name: 'Flavor', exact: true }).click()
    await page.getByLabel(`${roleLabel} signer 2`, { exact: true }).fill('')
    await steps.getByRole('button', { name: 'Launch', exact: true }).click()
    await expect(warning).toBeVisible()
    await warning.getByRole('button', { name: role === 'owner' ? 'Edit project owner' : 'Edit revnet operator' }).click()
    await page.getByRole('button', { name: `Already have an ${role} in mind?` }).click()
    await expect(page.getByLabel(role === 'owner' ? 'Project owner' : 'Revnet operator', { exact: true })).toHaveValue('')
    await steps.getByRole('button', { name: 'Launch', exact: true }).click()
    await expect(warning).toHaveCount(0)
  })
}
