import { expect, test, type Browser, type Page } from '@playwright/test'
import sharp from 'sharp'

const CID = 'QmbWqxBEKC3P8tqsKc98xmWNzrzDtRLMiMPL8wBuTGsMnR'
const sourcePrefix = `https://juicebox.center/ipfs/${CID}/`
const kinds = new Set(['raster', 'alpha', 'panorama', 'svg', 'gif', 'avif', 'avis', 'recover', 'missing', 'bigcritical', 'transition'])
type Delivery = { width: number; height: number; bytes: Buffer; contentType: string }

async function fixture(browser: Browser, baseURL: string, width: number, density: number, javaScriptEnabled = true, delayCover = false) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: density, serviceWorkers: 'block', javaScriptEnabled })
  const deliveries = new Map<string, Delivery>()
  const attempts = new Map<string, number>()
  let releaseCover = () => undefined as void
  const coverReleased = new Promise<void>(resolve => { releaseCover = resolve })
  let coverRequested = () => undefined as void
  const pendingCover = new Promise<void>(resolve => { coverRequested = resolve })
  const page = await context.newPage()
  await context.route('**/*', async route => {
    const requested = new URL(route.request().url())
    const original = requested.pathname === '/_next/image' ? requested.searchParams.get('url') : requested.href
    if (original?.startsWith(sourcePrefix)) {
      const kind = original.slice(sourcePrefix.length)
      expect(kinds.has(kind)).toBe(true)
      const optimized = requested.pathname === '/_next/image'
      if (delayCover && kind === 'transition' && optimized && Number(requested.searchParams.get('w')) >= 1024) {
        coverRequested()
        await coverReleased
      }
      const key = `${kind}:${optimized ? 'optimized' : 'original'}`
      attempts.set(key, (attempts.get(key) ?? 0) + 1)
      if (kind === 'missing' || (kind === 'recover' && optimized)) {
        await route.fulfill({ status: 503, body: 'Image unavailable' })
        return
      }
      // Only fixture CIDs are remapped. The app emits its real allowlisted URL;
      // Next receives a deterministic internal original and does the actual work.
      // This proves router/decoder/rendering integration, not live gateway latency.
      const source = `/image-proof/source/${kind === 'recover' ? 'raster' : kind === 'transition' ? 'panorama' : kind}`
      const target = new URL(optimized ? '/_next/image' : source, baseURL)
      if (optimized) {
        target.search = requested.search
        target.searchParams.set('url', source)
      }
      const response = await route.fetch({ url: target.href, timeout: 10_000 })
      if (response.ok()) {
        const bytes = await response.body()
        const metadata = kind === 'avis' ? { width: 0, height: 0 } : await sharp(bytes).metadata()
        deliveries.set(requested.href, { width: metadata.width!, height: metadata.height!, bytes, contentType: response.headers()['content-type'] })
      }
      await route.fulfill({ response })
      return
    }
    if (requested.hostname === '127.0.0.1' || requested.hostname === 'localhost') await route.continue()
    else await route.abort('blockedbyclient')
  })
  await page.goto(`${baseURL}/image-proof`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: 'Responsive image proof' })).toBeVisible()
  return { context, page, deliveries, attempts, releaseCover, pendingCover }
}

function imageLocator(page: Page, alt: string) {
  if (alt === 'Critical project logo') return page.getByTestId('critical-project-logo').locator('img')
  return page.getByAltText(alt, { exact: true })
}

async function loaded(page: Page, alt: string) {
  const image = imageLocator(page, alt)
  await image.scrollIntoViewIfNeeded()
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0 && getComputedStyle(element).visibility === 'visible')).toBe(true)
  return image
}

async function displayedPixels(page: Page, alt: string, deliveries: Map<string, Delivery>) {
  const image = await loaded(page, alt)
  const display = await image.evaluate((element: HTMLImageElement) => {
    const box = element.getBoundingClientRect()
    return { src: element.currentSrc, width: box.width, height: box.height, fit: getComputedStyle(element).objectFit, density: window.devicePixelRatio, scale: Math.max(1, window.visualViewport?.scale ?? 1), original: element.dataset.originalFallback === 'true' || !element.currentSrc.includes('/_next/image') }
  })
  const decoded = deliveries.get(display.src)
  expect(decoded, `${alt}: selected body must have been decoded`).toBeDefined()
  const fittedWidth = display.height * decoded!.width / decoded!.height
  const required = (display.fit === 'cover' ? Math.max(display.width, fittedWidth) : display.fit === 'contain' ? Math.min(display.width, fittedWidth) : display.width) * display.density * display.scale
  // Original is the quality ceiling. Otherwise use actual decoded body pixels,
  // never just a claimed width in the URL or density-corrected naturalWidth.
  if (!display.original && !decoded!.contentType.includes('svg')) expect(decoded!.width, `${alt} needs ${required} physical pixels`).toBeGreaterThanOrEqual(Math.floor(required))
  return { alt, ...display, decodedWidth: decoded!.width, bytes: decoded!.bytes.length, required }
}

async function originalDifference(page: Page, alt: string) {
  const image = await loaded(page, alt)
  await expect(image).not.toHaveAttribute('data-original-fallback', 'true')
  expect(await image.evaluate((element: HTMLImageElement) => element.currentSrc)).toContain('/_next/image?')
  const optimized = await image.screenshot()
  await image.evaluate((element: HTMLImageElement) => {
    const original = element.dataset.originalSrc!
    element.dataset.originalFallback = 'true'
    element.removeAttribute('srcset')
    element.removeAttribute('sizes')
    element.src = original
  })
  await loaded(page, alt)
  const original = await image.screenshot()
  return { difference: await channelDifference(optimized, original), optimized, original }
}

async function channelDifference(first: Buffer, second: Buffer) {
  const a = await sharp(first).ensureAlpha().raw().toBuffer()
  const b = await sharp(second).ensureAlpha().raw().toBuffer()
  expect(a.length).toBe(b.length)
  let difference = 0
  for (let index = 0; index < a.length; index += 1) difference += Math.abs(a[index] - b[index])
  return difference / a.length
}

// Revnet's suite repeats tests at five viewports; this test supplies its own
// complete viewport/density matrix, so run it once per browser engine.
test.beforeEach(({}, testInfo) => {
  test.skip(!['chromium', 'desktop-1280'].includes(testInfo.project.name), 'Density matrix owns viewports')
})

test('real derivatives retain detail at desktop/mobile 1x, 2x, and 3x', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(120_000)
  const evidence = []
  for (const width of [1280, 390]) {
    for (const density of [1, 2, 3]) {
      const { context, page, deliveries } = await fixture(browser, baseURL!, width, density)
      try {
        for (const alt of ['Critical project logo', 'Critical header cover', 'Critical inline cover', 'High priority thumbnail', 'Default cart thumbnail', 'Raster preview', 'Transparent image', 'Description image', 'Shop thumbnail slot', 'Shop detail slot', 'Panorama cover']) {
          await loaded(page, alt)
          if (['Critical project logo', 'Critical header cover', 'Critical inline cover', 'Panorama cover'].includes(alt)) {
            await expect(imageLocator(page, alt)).toHaveCSS('object-fit', 'cover')
          }
          const display = await displayedPixels(page, alt, deliveries)
          expect(display.original, `${alt}: ordinary geometry must use a sufficient derivative`).toBe(false)
          expect(new URL(display.src).searchParams.get('q')).toBe('90')
          evidence.push({ viewport: width, ...display })
        }
        if (density === (width === 390 ? 3 : 1)) {
          await testInfo.attach(`critical-header-final-${width}`, { body: await imageLocator(page, 'Critical header cover').screenshot(), contentType: 'image/png' })
        }
        const description = page.getByRole('img', { name: 'Description image', exact: true })
        await expect(description).not.toHaveAttribute('onerror')
        await expect(description).toHaveAttribute('data-original-src', `${sourcePrefix}raster`)
        if (width === 390 && density === 3) {
          for (const alt of ['Raster preview', 'Transparent image', 'SVG image', 'Critical project logo', 'Shop detail slot']) {
            const comparison = await originalDifference(page, alt)
            expect(comparison.difference, `${alt}: mean displayed channel error versus original`).toBeLessThan(3)
            await testInfo.attach(`${alt}-optimized-3x`, { body: comparison.optimized, contentType: 'image/png' })
            await testInfo.attach(`${alt}-original-3x`, { body: comparison.original, contentType: 'image/png' })
          }
          expect(await page.evaluate(() => '__imageScriptRan' in window || '__badImage' in window)).toBe(false)
        }
      } finally { await context.close() }
    }
  }
  const raster = evidence.filter(item => !item.original && item.src.includes(encodeURIComponent(`${sourcePrefix}raster`)))
  expect(raster.length).toBeGreaterThan(0)
  await testInfo.attach('decoded-delivery-matrix', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' })
})

test('resize and density changes keep source detail; failures and animations recover', async ({ browser, baseURL }, testInfo) => {
  const { context, page, deliveries, attempts } = await fixture(browser, baseURL!, 390, 1)
  try {
    for (const kind of ['gif', 'avif', 'avis']) {
      const image = await loaded(page, `${kind} animation`)
      if (kind === 'avis') await expect(image).toHaveAttribute('data-original-fallback', 'true')
      else {
        await expect(image).not.toHaveAttribute('data-original-fallback', 'true')
        expect(await image.evaluate((element: HTMLImageElement) => element.currentSrc)).toContain('/_next/image?')
      }
      const selected = deliveries.get(await image.evaluate((element: HTMLImageElement) => element.currentSrc))!
      const original = await context.request.get(`${baseURL}/image-proof/source/${kind}`)
      expect(selected.bytes.equals(await original.body()), `${kind} bytes must remain untouched`).toBe(true)
    }
    const gif = await loaded(page, 'gif animation')
    const first = await gif.screenshot()
    await expect.poll(async () => !(await gif.screenshot()).equals(first)).toBe(true)
    const resized = await loaded(page, 'Resizable image')
    const session = await context.newCDPSession(page)
    await session.send('Emulation.setDeviceMetricsOverride', { width: 391, height: 900, deviceScaleFactor: 3, mobile: false })
    await expect.poll(() => page.evaluate(() => window.devicePixelRatio)).toBe(3)
    // CDP density-only overrides emit no resolution/resize event; change the
    // real viewport too, then inspect after Chromium processes its frame.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await displayedPixels(page, 'Resizable image', deliveries)
    await page.getByRole('button', { name: 'Expand beyond derivatives' }).click()
    await expect(resized).toHaveAttribute('data-original-fallback', 'true')
    await displayedPixels(page, 'Resizable image', deliveries)
    const recovered = await loaded(page, 'Recovered image')
    await expect(recovered).toHaveAttribute('data-original-fallback', 'true')
    await expect(page.getByText('Original also unavailable', { exact: true })).toBeVisible()
    expect(attempts.get('missing:original')).toBe(1)
    expect(attempts.get('recover:original')).toBe(1)
    await testInfo.attach('fallback-attempts', { body: JSON.stringify(Object.fromEntries(attempts), null, 2), contentType: 'application/json' })
  } finally { await context.close() }
})


test('critical imagery paints bounded contained derivatives before hydration', async ({ browser, baseURL }, testInfo) => {
  const evidence = []
  for (const [width, density] of [[390, 3], [1280, 1]]) {
    const { context, page, deliveries, attempts } = await fixture(browser, baseURL!, width, density, false)
    try {
      const original = await context.request.get(`${baseURL}/image-proof/source/bigcritical`)
      expect(original.ok()).toBe(true)
      const sourceBytes = (await original.body()).length
      expect(sourceBytes).toBeGreaterThan(1_000_000)
      for (const alt of ['Critical project logo', 'Critical header cover', 'Critical inline cover', 'High priority thumbnail', 'Default cart thumbnail', 'Shop detail slot']) {
        const image = await loaded(page, alt)
        await expect(image).toHaveCSS('object-fit', 'contain')
        await expect(image).toHaveAttribute('srcset', /_next\/image/)
        const display = await displayedPixels(page, alt, deliveries)
        expect(display.original).toBe(false)
        expect(new URL(display.src).searchParams.get('q')).toBe('90')
        // A specimen-specific bound, not a universal raster/vector/animation cap.
        expect(display.bytes).toBeLessThan(Math.min(sourceBytes / 4, 512_000))
        evidence.push({ viewport: width, sourceBytes, ...display })
      }
      expect(attempts.get('bigcritical:original') ?? 0).toBe(0)
      await testInfo.attach(`critical-header-contained-no-javascript-${width}`, { body: await imageLocator(page, 'Critical header cover').screenshot(), contentType: 'image/png' })
      await testInfo.attach(`critical-logo-contained-no-javascript-${width}`, { body: await imageLocator(page, 'Critical project logo').screenshot(), contentType: 'image/png' })
    } finally { await context.close() }
  }
  await testInfo.attach('critical-without-javascript-delivery', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' })
})

test('the real optimizer transforms a cold raster and reuses identical cached bytes', async ({ request }, testInfo) => {
  const source = `/image-proof/source/raster-${Date.now()}`
  const url = `/_next/image?${new URLSearchParams({ url: source, w: '128', q: '90' })}`
  const original = await request.get(source)
  expect(original.ok()).toBe(true)
  const first = await request.get(url, { headers: { Accept: 'image/webp' } })
  const second = await request.get(url, { headers: { Accept: 'image/webp' } })
  expect(first.status()).toBe(200)
  expect(first.headers()['x-nextjs-cache']).toBe('MISS')
  expect(second.headers()['x-nextjs-cache']).toBe('HIT')
  const sourceBytes = (await original.body()).length
  const bytes = await first.body()
  expect(bytes.equals(await second.body())).toBe(true)
  expect(bytes.length).toBeLessThan(sourceBytes)
  const decoded = await sharp(bytes).metadata()
  expect(decoded.width).toBe(128)
  expect(decoded.height).toBe(64)
  await testInfo.attach('real-next-cache-and-transfer', { body: JSON.stringify({ sourceBytes, outputBytes: bytes.length, width: decoded.width, height: decoded.height, first: first.headers()['x-nextjs-cache'], second: second.headers()['x-nextjs-cache'] }), contentType: 'application/json' })
})


test('pinch zoom selects the smallest sufficient larger derivative', async ({ browser, baseURL }, testInfo) => {
  const { context, page, deliveries } = await fixture(browser, baseURL!, 390, 1)
  try {
    const image = await loaded(page, 'Resizable image')
    expect(await image.evaluate((element: HTMLImageElement) => element.currentSrc)).toContain('/_next/image?')
    const candidates = (await image.getAttribute('srcset'))!.split(',').map(candidate => Number(candidate.trim().match(/ (\d+)w$/)![1]))
    const before = await displayedPixels(page, 'Resizable image', deliveries)
    const session = await context.newCDPSession(page)
    await session.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 })
    await expect.poll(() => page.evaluate(() => window.visualViewport?.scale)).toBe(2)
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await expect(image).not.toHaveAttribute('data-original-fallback', 'true')
    await expect.poll(async () => (await displayedPixels(page, 'Resizable image', deliveries)).decodedWidth).toBe(Math.min(...candidates.filter(width => width >= before.required * 2)))
    const display = await displayedPixels(page, 'Resizable image', deliveries)
    expect(display.original).toBe(false)
    expect(display.decodedWidth).toBeGreaterThanOrEqual(display.required)
    await testInfo.attach('pinch-zoom-delivery', { body: JSON.stringify({ before, after: display }), contentType: 'application/json' })
  } finally { await context.close() }
})


test('a delayed larger crop stays visibly contained until enough pixels arrive', async ({ browser, baseURL }, testInfo) => {
  const { context, page, deliveries, releaseCover, pendingCover } = await fixture(browser, baseURL!, 390, 1, true, true)
  try {
    await pendingCover
    const image = imageLocator(page, 'Critical inline cover')
    await image.scrollIntoViewIfNeeded()
    await expect(image).toHaveCSS('object-fit', 'contain')
    await expect(image).toHaveCSS('visibility', 'visible')
    // Chromium clears currentSrc/naturalWidth while replacing srcset with src,
    // although it still paints the prior bitmap. Verify that bitmap directly
    // against the captured decoded response before unblocking the larger body.
    const pending = await image.evaluate((element: HTMLImageElement) => ({
      currentSrc: element.currentSrc, src: element.src, complete: element.complete,
      naturalWidth: element.naturalWidth, naturalHeight: element.naturalHeight,
      fit: getComputedStyle(element).objectFit, visibility: getComputedStyle(element).visibility,
      width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height,
    }))
    const retained = [...deliveries].find(([src]) => new URL(src).searchParams.get('url') === `${sourcePrefix}transition` && new URL(src).searchParams.get('w') === '128')
    expect(retained, 'The initial response must have completed before the upgrade').toBeDefined()
    expect(retained![1].width).toBe(128)
    expect(retained![1].height).toBe(16)
    const screenshot = await image.screenshot()
    const reference = await sharp(retained![1].bytes).resize({ width: pending.width, height: pending.height, fit: 'contain', background: '#fff' }).png().toBuffer()
    const difference = await channelDifference(screenshot, reference)
    expect(difference, 'Pending paint must retain the actual sharp contained bitmap').toBeLessThan(1)
    const retainedBitmap = { src: retained![0], decodedWidth: retained![1].width, decodedHeight: retained![1].height, bytes: retained![1].bytes.length, difference }
    await testInfo.attach('cover-delayed-contained', { body: screenshot, contentType: 'image/png' })
    await testInfo.attach('cover-delayed-known-body-reference', { body: reference, contentType: 'image/png' })
    releaseCover()
    await expect(image).toHaveCSS('object-fit', 'cover')
    const final = await displayedPixels(page, 'Critical inline cover', deliveries)
    expect(final.original).toBe(false)
    expect(final.decodedWidth).toBeGreaterThanOrEqual(final.required)
    expect(final.decodedWidth).toBe(1080)
    await testInfo.attach('cover-delayed-restored', { body: await image.screenshot(), contentType: 'image/png' })
    await testInfo.attach('cover-transition-delivery', { body: JSON.stringify({ pending, retainedBitmap, final }, null, 2), contentType: 'application/json' })
  } finally { releaseCover(); await context.close() }
})
