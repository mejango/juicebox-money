import { expect, test, type Page } from '@playwright/test'

// Next re-requests a prefetch without end once more than four links to a
// dynamic route whose segment holds a `:` (every `chain:id` project URN) are in
// view, so project links must never prefetch.
test.use({ viewport: { width: 1280, height: 1000 } })

const QUIET_MS = 2_000
const SETTLE_DEADLINE_MS = 12_000

function watchRscRequests(page: Page) {
  const paths: string[] = []
  const prefetchedPaths: string[] = []
  let lastAt = 0
  page.on('request', request => {
    if (request.headers()['rsc'] !== '1') return
    const pathname = new URL(request.url()).pathname
    paths.push(pathname)
    if (request.headers()['next-router-prefetch'] === '1') {
      prefetchedPaths.push(pathname)
    }
    lastAt = Date.now()
  })
  return {
    paths,
    prefetchedPaths,
    sinceLast: () => Date.now() - lastAt,
  }
}

function busiest(paths: string[]) {
  const counts = new Map<string, number>()
  for (const path of paths) counts.set(path, (counts.get(path) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 5)
}

test('home settles with more than four project links in view', async ({
  context,
  page,
}) => {
  await context.route(/^https?:\/\//, async route => {
    const { hostname } = new URL(route.request().url())
    if (['127.0.0.1', 'localhost', '::1'].includes(hostname)) {
      await route.continue()
    } else {
      await route.fulfill({ status: 503, body: 'External browser traffic is disabled' })
    }
  })
  const rsc = watchRscRequests(page)

  await page.goto('/', { waitUntil: 'load' })

  const projectLinks = page.locator('#home-trending-panel a[href*=":"]')
  await expect(projectLinks.first()).toBeVisible()
  const linksInView = await projectLinks.evaluateAll(
    links =>
      new Promise<number>(resolve => {
        const observer = new IntersectionObserver(entries => {
          observer.disconnect()
          resolve(entries.filter(entry => entry.isIntersecting).length)
        })
        for (const link of links) observer.observe(link)
      }),
  )
  expect(linksInView, 'the fold must hold more than four project links').toBeGreaterThan(4)

  // Give viewport prefetching time to run even when every visible link opts
  // out. The explicit navigation below also proves the client is interactive.
  await page.waitForTimeout(QUIET_MS)
  const deadline = Date.now() + SETTLE_DEADLINE_MS
  while (rsc.sinceLast() < QUIET_MS && Date.now() < deadline) {
    await page.waitForTimeout(250)
  }

  expect(
    rsc.sinceLast(),
    `RSC requests never went quiet: ${rsc.paths.length} so far, busiest ${JSON.stringify(busiest(rsc.paths))}`,
  ).toBeGreaterThanOrEqual(QUIET_MS)
  expect(
    rsc.paths.filter(path => path.includes(':')),
    'project routes must not be prefetched',
  ).toEqual([])
  const unrelatedRoutes = new Set(['/learn', '/build', '/audit', '/create'])
  expect(
    rsc.prefetchedPaths.filter(path => unrelatedRoutes.has(path)),
    'guide and creation downloads must not compete with project entry',
  ).toEqual([])

  await projectLinks.filter({ hasText: 'Browser Fixture Project' }).first().click()
  await expect(page.getByRole('tablist', { name: 'Project sections' })).toBeVisible()
  await expect(page.locator('#project-pay-card').getByLabel('Payment token', { exact: true })).toContainText('USDC')
  await page.waitForTimeout(QUIET_MS)
  expect(
    rsc.prefetchedPaths.filter(path => unrelatedRoutes.has(path)),
    'project navigation must not start guide or creation prefetches',
  ).toEqual([])
})
