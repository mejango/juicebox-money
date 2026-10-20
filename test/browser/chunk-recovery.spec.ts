import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'

// A lazy chunk that fails to download once must not strand the visitor.
// React.lazy keeps a failed component failed, so next/dynamic recovers only
// through a reload (the app error boundary reloads once on its own). Webpack
// forgets a failed chunk, so a plain import() recovers on the next call.
const manifest = () =>
  JSON.parse(readFileSync('.next/react-loadable-manifest.json', 'utf8')) as Record<string, { files: string[] }>

function lazyChunk(key: string) {
  const files = manifest()[key]?.files.filter(file => file.endsWith('.js')) ?? []
  expect(files.length, `${key} must be a lazy import`).toBeGreaterThan(0)
  // The module's own chunk: the one no import of another module shares.
  const target = key.split(' -> ')[1]
  const shared = new Set(
    Object.entries(manifest()).filter(([other]) => other.split(' -> ')[1] !== target).flatMap(([, entry]) => entry.files),
  )
  const own = files.filter(file => !shared.has(file))
  expect(own.length, `${key} must have a chunk of its own`).toBeGreaterThan(0)
  return `/_next/${own[0]}`
}

async function failOnce(page: Page, path: string) {
  let failed = 0
  await page.route(url => url.pathname === path, async route => {
    if (failed++ === 0) return route.abort('failed')
    return route.continue()
  })
  return () => failed
}

test('a tab whose chunk failed once loads after the reload', async ({ page }) => {
  const failures = await failOnce(page, lazyChunk('components/project/LazyProjectTabs.tsx -> @/components/project/TermsTab'))
  await page.goto('/eth:1')
  const tabs = page.getByRole('tablist', { name: 'Project sections' })
  await tabs.getByRole('tab', { name: 'Terms', exact: true }).click()
  // The boundary reloads the document once, back on the Terms tab.
  await page.waitForEvent('load')
  const stages = page.getByRole('region', { name: 'Revnet stages' })
  await expect(stages.locator('tbody tr').first()).toBeVisible()
  await expect(page.getByRole('tablist', { name: 'Project sections' }).getByRole('tab', { name: 'Terms', exact: true }))
    .toHaveAttribute('aria-selected', 'true')
  expect(failures()).toBe(2)
})

test('a handle route whose normalizer chunk failed once still verifies', async ({ page }) => {
  const failures = await failOnce(page, lazyChunk('lib/project-handle-route.ts -> @/lib/project-handles'))
  await page.goto('/@browser-fixture')
  const heading = page.getByRole('heading', { name: 'Browser Fixture Project', exact: true })
  const tryAgain = page.getByRole('button', { name: 'Try again', exact: true })
  // A later handle read on the page may load the chunk before verification
  // needs it; otherwise Try again requests it again.
  await expect(heading.or(tryAgain)).toBeVisible()
  if (await tryAgain.isVisible()) await tryAgain.click()
  await expect(heading).toBeVisible()
  await expect(page.getByText('Checking the project link…')).toHaveCount(0)
  expect(failures()).toBe(2)
})
