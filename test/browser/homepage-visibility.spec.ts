import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { fulfillHomepageImage, homepageImageFeed } from './homepage-images'

async function watchHomepage(context: BrowserContext, page: Page) {
  const images: string[] = []
  const polls: string[] = []
  let completedPolls = 0
  const external: string[] = []
  page.on('request', request => {
    const feed = homepageImageFeed(request.url())
    if (feed) images.push(feed)
    const url = new URL(request.url())
    if (url.pathname === '/api/activity' && url.searchParams.get('offset') === '0') polls.push(url.href)
  })
  page.on('requestfinished', request => {
    const url = new URL(request.url())
    if (url.pathname === '/api/activity' && url.searchParams.get('offset') === '0') completedPolls += 1
  })
  await context.route('**/*', async route => {
    if (await fulfillHomepageImage(route)) return
    const url = new URL(route.request().url())
    if (['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) await route.continue()
    else {
      external.push(url.href)
      await route.fulfill({ status: 503, body: 'External browser traffic is disabled' })
    }
  })
  return { images, polls, external, completedPolls: () => completedPolls }
}

async function homepageReady(page: Page) {
  await page.goto('/', { waitUntil: 'load' })
  await expect(page.getByRole('heading', { name: 'Fund your thing.', exact: true })).toBeVisible()
  // Every streamed panel must exist before an absence of its requests counts.
  await expect(page.locator('#home-top-panel img[data-original-src]')).toHaveCount(5)
  for (const feed of ['trending', 'new', 'activity']) {
    await expect(page.locator(`#home-${feed}-panel img[data-original-src]`)).toHaveCount(1)
  }
  await expect.poll(() => page.locator('#home-top-panel img[data-original-src]').first().evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true)
}

async function selectFeed(page: Page, width: number, name: string) {
  const tab = page.getByRole('tablist', { name: width < 640 ? 'Project feeds' : 'Project rankings' }).getByRole('tab', { name, exact: true })
  await expect(async () => {
    await tab.click()
    await expect(tab).toHaveAttribute('aria-selected', 'true')
  }).toPass()
}

async function expectLoaded(page: Page, feed: string) {
  const image = page.locator(`#home-${feed}-panel img[data-original-src]`).first()
  await image.scrollIntoViewIfNeeded()
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true)
}

for (const width of [390, 768, 1280]) {
  test(`homepage requests only visible feed logos at ${width}px and loads revealed feeds`, async ({ context, page }) => {
    await page.setViewportSize({ width, height: 900 })
    const requests = await watchHomepage(context, page)
    await homepageReady(page)
    const top = page.locator('#home-top-panel img[data-original-src]')
    for (let index = 0; index < 5; index += 1) {
      await expect(top.nth(index)).toHaveAttribute('loading', index < 4 ? 'eager' : 'lazy')
      await expect(top.nth(index)).toHaveAttribute('fetchpriority', index < 4 ? 'high' : 'auto')
    }
    for (const feed of ['trending', 'new', 'activity']) {
      const image = page.locator(`#home-${feed}-panel img[data-original-src]`)
      await expect(image).toHaveAttribute('loading', 'lazy')
      await expect(image).toHaveAttribute('fetchpriority', 'auto')
    }
    if (width < 1280) {
      for (const feed of ['trending', 'new', ...(width < 640 ? ['activity'] : [])]) {
        await expect(page.locator(`#home-${feed}-panel`)).toBeHidden()
        expect(requests.images, `${feed} must not request while hidden`).not.toContain(feed)
      }
      for (const [name, feed] of [['Trending', 'trending'], ['New', 'new'], ...(width < 640 ? [['Latest', 'activity']] : [])]) {
        await selectFeed(page, width, name)
        await expectLoaded(page, feed)
        expect(requests.images).toContain(feed)
      }
    } else {
      for (const feed of ['trending', 'new', 'activity']) await expectLoaded(page, feed)
      await page.setViewportSize({ width: 390, height: 900 })
      await expect(page.locator('#home-activity-panel')).toBeHidden()
      await page.setViewportSize({ width, height: 900 })
      for (const feed of ['trending', 'new', 'activity']) await expectLoaded(page, feed)
    }
    expect(requests.external).toEqual([])
  })
}

test('homepage activity polls only while its actual responsive panel and document are visible', async ({ context, page }) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 390, height: 900 })
  await page.clock.install()
  const requests = await watchHomepage(context, page)
  await homepageReady(page)
  // Prove hydration without revealing Latest or altering its initial refresh state.
  await selectFeed(page, 390, 'Trending')
  await selectFeed(page, 390, 'Top')
  const initialRow = await page.locator('#home-activity-panel li').first().elementHandle()
  const pause = async () => {
    const now = await page.evaluate(() => Date.now())
    await page.clock.pauseAt(now + 100)
  }
  const reveal = async (action: () => Promise<void>) => {
    await page.clock.resume()
    await action()
    await pause()
  }
  const settledPoll = async (count: number) => {
    await expect.poll(requests.completedPolls).toBe(count)
    // requestfinished means the complete body arrived; let the browser process
    // its fetch/json continuation before simulating another polling deadline.
    await page.clock.runFor(1)
    expect(requests.polls).toHaveLength(count)
  }
  await pause()
  await page.clock.runFor(45_000)
  expect(requests.polls).toHaveLength(0)

  await reveal(() => selectFeed(page, 390, 'Latest'))
  await settledPoll(1)
  await expect(page.locator('#home-activity-panel')).toBeVisible()
  for (const count of [2, 3]) {
    await page.clock.runFor(15_000)
    await settledPoll(count)
  }
  await reveal(() => selectFeed(page, 390, 'Top'))
  await page.clock.runFor(45_000)
  expect(requests.polls).toHaveLength(3)
  expect(await initialRow!.evaluate(row => row.isConnected)).toBe(true)

  await reveal(async () => {
    await page.setViewportSize({ width: 768, height: 900 })
    await expect(page.locator('#home-activity-panel')).toBeVisible()
  })
  await settledPoll(4)
  // Ordinary size changes retain the interval; they are not new reveals.
  await reveal(() => page.setViewportSize({ width: 800, height: 900 }))
  expect(requests.polls).toHaveLength(4)

  // Controlled document visibility event; CSS transitions above use real layout.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.clock.runFor(45_000)
  expect(requests.polls).toHaveLength(4)
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await settledPoll(5)
  await reveal(async () => {
    await page.setViewportSize({ width: 390, height: 900 })
    await expect(page.locator('#home-activity-panel')).toBeHidden()
  })
  await page.clock.runFor(45_000)
  expect(requests.polls).toHaveLength(5)
  expect(await initialRow!.evaluate(row => row.isConnected)).toBe(true)
  expect(requests.external).toEqual([])
})
