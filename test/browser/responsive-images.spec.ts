import { expect, test, type Browser, type Page } from '@playwright/test'
import sharp from 'sharp'

const CID = 'QmbWqxBEKC3P8tqsKc98xmWNzrzDtRLMiMPL8wBuTGsMnR'
const sourcePrefix = `https://juicebox.center/ipfs/${CID}/`
const kinds = new Set(['raster', 'alpha', 'panorama', 'svg', 'gif', 'avif', 'avis', 'recover', 'missing'])
type Delivery = { width: number; height: number; bytes: Buffer; contentType: string }

async function fixture(browser: Browser, baseURL: string, width: number, density: number, javaScriptEnabled = true) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: density, serviceWorkers: 'block', javaScriptEnabled })
  const deliveries = new Map<string, Delivery>()
  const attempts = new Map<string, number>()
  const page = await context.newPage()
  await context.route('**/*', async route => {
    const requested = new URL(route.request().url())
    const original = requested.pathname === '/_next/image' ? requested.searchParams.get('url') : requested.href
    if (original?.startsWith(sourcePrefix)) {
      const kind = original.slice(sourcePrefix.length)
      expect(kinds.has(kind)).toBe(true)
      const optimized = requested.pathname === '/_next/image'
      const key = `${kind}:${optimized ? 'optimized' : 'original'}`
      attempts.set(key, (attempts.get(key) ?? 0) + 1)
      if (kind === 'missing' || (kind === 'recover' && optimized)) {
        await route.fulfill({ status: 503, body: 'Image unavailable' })
        return
      }
      // Only fixture CIDs are remapped. The app emits its real allowlisted URL;
      // Next receives a deterministic internal original and does the actual work.
      // This proves router/decoder/rendering integration, not live gateway latency.
      const source = `/image-proof/source/${kind === 'recover' ? 'raster' : kind}`
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
  return { context, page, deliveries, attempts }
}

async function loaded(page: Page, alt: string) {
  const image = page.getByAltText(alt, { exact: true })
  await image.scrollIntoViewIfNeeded()
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0 && getComputedStyle(element).visibility === 'visible')).toBe(true)
  return image
}

async function displayedPixels(page: Page, alt: string, deliveries: Map<string, Delivery>) {
  const image = await loaded(page, alt)
  const display = await image.evaluate((element: HTMLImageElement) => {
    const box = element.getBoundingClientRect()
    return { src: element.currentSrc, width: box.width, height: box.height, fit: getComputedStyle(element).objectFit, density: window.devicePixelRatio, original: element.dataset.originalFallback === 'true' || !element.currentSrc.includes('/_next/image') }
  })
  const decoded = deliveries.get(display.src)
  expect(decoded, `${alt}: selected body must have been decoded`).toBeDefined()
  const fittedWidth = display.height * decoded!.width / decoded!.height
  const required = (display.fit === 'cover' ? Math.max(display.width, fittedWidth) : display.fit === 'contain' ? Math.min(display.width, fittedWidth) : display.width) * display.density
  // Original is the quality ceiling. Otherwise use actual decoded body pixels,
  // never just a claimed width in the URL or density-corrected naturalWidth.
  if (!display.original && !decoded!.contentType.includes('svg')) expect(decoded!.width, `${alt} needs ${required} physical pixels`).toBeGreaterThanOrEqual(Math.floor(required))
  return { ...display, decodedWidth: decoded!.width, bytes: decoded!.bytes.length, required }
}

async function originalDifference(page: Page, alt: string) {
  const image = await loaded(page, alt)
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
  const a = await sharp(optimized).ensureAlpha().raw().toBuffer()
  const b = await sharp(original).ensureAlpha().raw().toBuffer()
  expect(a.length).toBe(b.length)
  let difference = 0
  for (let index = 0; index < a.length; index += 1) difference += Math.abs(a[index] - b[index])
  return { difference: difference / a.length, optimized, original }
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
        for (const alt of ['Raster preview', 'Transparent image', 'Description image', 'Shop thumbnail slot', 'Shop detail slot', 'Panorama cover']) {
          evidence.push({ viewport: width, ...await displayedPixels(page, alt, deliveries) })
        }
        await expect(page.getByRole('img', { name: 'Panorama cover', exact: true })).toHaveAttribute('data-original-fallback', 'true')
        const description = page.getByRole('img', { name: 'Description image', exact: true })
        await expect(description).not.toHaveAttribute('onerror')
        await expect(description).toHaveAttribute('data-original-src', `${sourcePrefix}raster`)
        if (width === 390 && density === 3) {
          for (const alt of ['Raster preview', 'Transparent image', 'SVG image']) {
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
    const resized = await loaded(page, 'Resizable image')
    const session = await context.newCDPSession(page)
    await session.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 3, mobile: false })
    await expect.poll(() => page.evaluate(() => window.devicePixelRatio)).toBe(3)
    await displayedPixels(page, 'Resizable image', deliveries)
    await page.getByRole('button', { name: 'Expand beyond derivatives' }).click()
    await expect(resized).toHaveAttribute('data-original-fallback', 'true')
    await displayedPixels(page, 'Resizable image', deliveries)
    const recovered = await loaded(page, 'Recovered image')
    await expect(recovered).toHaveAttribute('data-original-fallback', 'true')
    await expect(page.getByText('Original also unavailable', { exact: true })).toBeVisible()
    expect(attempts.get('missing:original')).toBe(1)
    expect(attempts.get('recover:original')).toBe(1)
    for (const kind of ['gif', 'avif', 'avis']) {
      const image = await loaded(page, `${kind} animation`)
      if (kind === 'avis') await expect(image).toHaveAttribute('data-original-fallback', 'true')
      const selected = deliveries.get(await image.evaluate((element: HTMLImageElement) => element.currentSrc))!
      const original = await context.request.get(`${baseURL}/image-proof/source/${kind}`)
      expect(selected.bytes.equals(await original.body()), `${kind} bytes must remain untouched`).toBe(true)
    }
    const gif = await loaded(page, 'gif animation')
    const first = await gif.screenshot()
    await expect.poll(async () => !(await gif.screenshot()).equals(first)).toBe(true)
    await testInfo.attach('fallback-attempts', { body: JSON.stringify(Object.fromEntries(attempts), null, 2), contentType: 'application/json' })
  } finally { await context.close() }
})


test('eager project imagery paints the original before hydration', async ({ browser, baseURL }, testInfo) => {
  const { context, page } = await fixture(browser, baseURL!, 390, 3, false)
  try {
    const image = page.getByTestId('eager-project-logo').locator('img')
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0 && getComputedStyle(element).visibility === 'visible')).toBe(true)
    await expect(image).toHaveAttribute('src', `${sourcePrefix}alpha`)
    await expect(image).not.toHaveAttribute('srcset')
    await testInfo.attach('eager-logo-without-javascript', { body: await image.screenshot(), contentType: 'image/png' })
  } finally { await context.close() }
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
