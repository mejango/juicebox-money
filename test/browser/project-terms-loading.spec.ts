import { readFileSync } from 'node:fs'
import { expect, test, type BrowserContext, type Page } from '@playwright/test'

let termsScripts: string[]
let heavyScripts: string[]

test.beforeAll(() => {
  const manifest = JSON.parse(readFileSync('.next/react-loadable-manifest.json', 'utf8')) as
    Record<string, { files: string[] }>
  const scriptsFor = (module: string) => {
    const entry = manifest[`components/project/LazyProjectTabs.tsx -> @/components/project/${module}`]
    expect(entry, `${module} must have its own production dynamic import`).toBeDefined()
    return entry.files.filter(file => file.endsWith('.js')).map(file => `/_next/${file}`)
  }
  const terms = scriptsFor('TermsTab')
  const heavy = scriptsFor('DeferredProjectTabs')
  termsScripts = terms.filter(file => !heavy.includes(file))
  heavyScripts = heavy.filter(file => !terms.includes(file))
  expect(termsScripts.length, 'Terms must load independently of the heavy tab group').toBeGreaterThan(0)
  expect(heavyScripts.length, 'heavy tabs must retain a separate chunk').toBeGreaterThan(0)
})

async function watchPage(context: BrowserContext, page: Page) {
  const scripts = new Map<string, number>()
  const documents: string[] = []
  const errors: string[] = []
  const external: string[] = []
  page.on('request', request => {
    const path = new URL(request.url()).pathname
    if (request.resourceType() === 'script') scripts.set(path, (scripts.get(path) ?? 0) + 1)
    if (request.resourceType() === 'document') documents.push(path)
  })
  page.on('pageerror', error => errors.push(error.message))
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
  return { scripts, documents, errors, external }
}

async function expectTerms(page: Page) {
  const stages = page.getByRole('region', { name: 'Revnet stages' })
  await expect(stages.locator('tbody tr').first().locator('td').nth(2)).toHaveText('1')
  await expect(page.getByRole('status', { name: 'Loading terms', exact: true })).toHaveCount(0)
}

for (const journey of [
  { path: '/eth:1', first: 'Terms', holdTerms: true },
  { path: '/@browser-fixture', first: 'Owners', holdTerms: false },
  { path: '/eth:1#terms', first: 'Terms', holdTerms: false },
] as const) {
  test(`${journey.path}: ${journey.first} loads independently before the other tab`, async ({ context, page }) => {
    const observed = await watchPage(context, page)
    const held = Promise.withResolvers<void>()
    if (journey.holdTerms) {
      await page.route(url => url.pathname === termsScripts[0], async route => {
        await held.promise
        await route.continue()
      })
    }
    try {
      await page.goto(journey.path)
      const heading = page.getByRole('heading', { name: 'Browser Fixture Project', exact: true })
      await expect(heading).toBeVisible()
      const note = page.locator('#project-pay-card').getByLabel('Note', { exact: true })
      await note.fill('Keep this draft while loading tabs')
      const tabs = page.getByRole('tablist', { name: 'Project sections' })
      const select = async (name: string) => {
        const tab = tabs.getByRole('tab', { name, exact: true })
        await tab.click()
        await expect(tab).toHaveAttribute('aria-selected', 'true')
      }
      if (!journey.path.includes('#')) {
        expect(termsScripts.filter(file => observed.scripts.has(file))).toEqual([])
        expect(heavyScripts.filter(file => observed.scripts.has(file))).toEqual([])
      }

      if (journey.first === 'Owners') {
        await select('Owners')
        await expect(page.getByText('Sign in to see your position.', { exact: true })).toBeVisible()
        expect(heavyScripts.every(file => observed.scripts.has(file))).toBe(true)
        expect(termsScripts.filter(file => observed.scripts.has(file))).toEqual([])
      }
      if (!journey.path.includes('#')) await select('Terms')
      if (journey.holdTerms) {
        await expect.poll(() => observed.scripts.has(termsScripts[0])).toBe(true)
        await expect(page.getByRole('status', { name: 'Loading terms', exact: true })).toBeVisible()
        await expect(heading).toBeVisible()
        await expect(note).toHaveValue('Keep this draft while loading tabs')
        await expect(page.getByRole('status', { name: 'Loading project', exact: true })).toHaveCount(0)
        held.resolve()
      }
      await expectTerms(page)
      expect(termsScripts.every(file => observed.scripts.has(file))).toBe(true)
      if (journey.first === 'Terms') {
        expect(heavyScripts.filter(file => observed.scripts.has(file))).toEqual([])
        await select('Owners')
        await expect(page.getByText('Sign in to see your position.', { exact: true })).toBeVisible()
        expect(heavyScripts.every(file => observed.scripts.has(file))).toBe(true)
        const scriptCounts = () => [...termsScripts, ...heavyScripts].map(file => observed.scripts.get(file) ?? 0)
        const beforeRepeat = scriptCounts()
        await select('Terms')
        await expectTerms(page)
        await select('Owners')
        await expect(page.getByText('Sign in to see your position.', { exact: true })).toBeVisible()
        expect(scriptCounts(), 'revisiting Terms and Owners must reuse their loaded scripts').toEqual(beforeRepeat)
      }
      await expect(note).toHaveValue('Keep this draft while loading tabs')
      expect(observed.documents).toEqual([journey.path.split('#')[0]])
      expect(observed.errors).toEqual([])
      expect(observed.external).toEqual([])
    } finally {
      held.resolve()
    }
  })
}

for (const persistent of [false, true]) {
  test(`a rejected Terms script ${persistent ? 'stops after one automatic reload' : 'recovers with the existing automatic reload'}`, async ({ context, page }) => {
    const observed = await watchPage(context, page)
    let rejected = 0
    await page.route(url => url.pathname === termsScripts[0], async route => {
      if (!persistent && rejected > 0) return route.continue()
      rejected++
      await route.fulfill({ status: 503, body: 'Fixture Terms chunk unavailable' })
    })
    await page.goto('/eth:1')
    await expect(page.getByRole('heading', { name: 'Browser Fixture Project', exact: true })).toBeVisible()
    await page.getByRole('tablist', { name: 'Project sections' }).getByRole('tab', { name: 'Terms', exact: true }).click()

    if (persistent) {
      await expect(page.getByRole('heading', { name: 'Something went wrong loading this page.', exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Reload', exact: true })).toBeVisible()
      expect(rejected).toBe(2)
    } else {
      await expectTerms(page)
      expect(rejected).toBe(1)
    }
    expect(observed.documents).toEqual(['/eth:1', '/eth:1'])
    expect(await page.evaluate(() => sessionStorage.getItem('stale-deployment-reload'))).toBe(page.url())
    expect(observed.errors.filter(message => !/Loading chunk .* failed/i.test(message))).toEqual([])
    expect(observed.external).toEqual([])
  })
}
