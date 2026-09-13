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
  await page.getByRole('button', { name: 'Already have a multisig?' }).click()
  await expect(page.getByLabel('Project owner', { exact: true })).toBeVisible()
  await page.getByLabel('Project owner', { exact: true }).fill(signers[0])
  await page.getByRole('button', { name: 'Create a new multisig' }).click()
  await expect(page.getByLabel('Owner signer 1', { exact: true })).toHaveValue(signers[0])
  await page.getByLabel('Project flavor').selectOption('revnet')
  await expect(page.getByLabel('Operator signer 1', { exact: true })).toHaveValue(signers[0])
  await expect(page.getByText('The operator is made up of addresses that need to agree on decisions.')).toBeVisible()
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
  await page.getByRole('button', { name: 'Create a new multisig' }).click()
  await page.getByRole('button', { name: 'Already have a multisig?' }).click()
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
