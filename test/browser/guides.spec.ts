import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Locator, type Page } from '@playwright/test'

const routes = [
  { path: '/learn', heading: /Learn Juicebox/, contents: 'Learn Juicebox contents' },
  { path: '/build', heading: /Build on Juicebox/, contents: 'Build with Juicebox contents' },
] as const

async function openGuide(page: Page, route: (typeof routes)[number]) {
  const response = await page.goto(route.path)
  expect(response?.status()).toBe(200)
  await expect(page.getByRole('heading', { level: 1, name: route.heading })).toBeVisible()
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
  await page.evaluate(() => document.fonts.ready)
  const skip = page.getByRole('link', { name: 'Skip to content', exact: true })
  await page.keyboard.press('Tab')
  await expect(
    skip,
    'The first keyboard stop must let readers skip the site navigation',
  ).toBeFocused()
  await skip.press('Enter')
  await expect(page.locator((await skip.getAttribute('href'))!)).toBeFocused()
}

async function expectContained(page: Page) {
  const geometry = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }))
  expect(
    geometry.document,
    'The guide must not cause horizontal document scrolling',
  ).toBeLessThanOrEqual(geometry.viewport + 1)
  expect(geometry.body, 'The guide must not cause horizontal body scrolling').toBeLessThanOrEqual(
    geometry.viewport + 1,
  )
}

async function expectVisibleKeyboardFocus(page: Page, target: Locator) {
  await target.focus()
  await target.press('Shift+Tab')
  await page.keyboard.press('Tab')
  await expect(target).toBeFocused()
  const indicator = await target.evaluate((element) => {
    const style = getComputedStyle(element)
    return (
      (style.outlineStyle !== 'none' && style.outlineWidth !== '0px') || style.boxShadow !== 'none'
    )
  })
  expect(indicator, 'Keyboard navigation must have a visible focus indicator').toBe(true)
}

async function exerciseContents(page: Page, route: (typeof routes)[number]) {
  const contents = page.getByRole('navigation', { name: route.contents })
  await expect(contents).toBeVisible()
  const summary = contents.locator('summary')
  if (await summary.isVisible()) {
    await expectVisibleKeyboardFocus(page, summary)
    await summary.press('Enter')
    await expect(summary.locator('..')).toHaveAttribute('open', '')
  }

  const links = contents.locator('a[href^="#"]:visible')
  const hrefs = await links.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('href')!),
  )
  expect(hrefs.length, 'Contents must link to guide sections').toBeGreaterThan(0)
  const invalidTargets = await page.evaluate(
    (fragments) =>
      fragments.flatMap((fragment) => {
        const id = decodeURIComponent(fragment.slice(1))
        const targets = Array.from(document.querySelectorAll('[id]')).filter(
          (element) => element.id === id,
        )
        return targets.length === 1 &&
          targets[0].matches('section') &&
          targets[0].querySelector('h2')
          ? []
          : [fragment]
      }),
    hrefs,
  )
  expect(invalidTargets, 'Every contents link must resolve to one section with a heading').toEqual(
    [],
  )

  const link = links.nth(Math.floor(hrefs.length / 2))
  const href = (await link.getAttribute('href'))!
  const section = page.locator(href)
  await expectVisibleKeyboardFocus(page, link)
  await link.press('Enter')
  await expect(page).toHaveURL((url) => url.hash === href)
  await expect(section).toBeFocused()
  await expect(section.getByRole('heading', { level: 2 })).toBeInViewport()

  const back = section.getByRole('link', { name: /^Back to contents/ })
  const backHref = (await back.getAttribute('href'))!
  await expectVisibleKeyboardFocus(page, back)
  await back.press('Enter')
  await expect(page).toHaveURL((url) => url.hash === backHref)
  await expect(page.locator(backHref)).toBeFocused()

  // A copied section URL must also work on a fresh document, before hydration.
  await page.goto(`${route.path}${href}`)
  await expect(section.getByRole('heading', { level: 2 })).toBeInViewport()
}

async function openPrompt(page: Page) {
  const summary = page.locator('summary').filter({ hasText: /^Build with an AI assistant$/ })
  await expectVisibleKeyboardFocus(page, summary)
  await summary.press('Enter')
  await expect(
    page.getByRole('button', { name: 'Copy the Juicebox build prompt', exact: true }),
  ).toBeVisible()
}

async function showManualPrompt(page: Page) {
  const summary = page.locator('summary').filter({ hasText: /^Read or manually copy the prompt$/ })
  await expectVisibleKeyboardFocus(page, summary)
  await summary.press('Enter')
  const prompt = page.getByRole('textbox', { name: 'Juicebox build prompt', exact: true })
  await expect(prompt).toBeVisible()
  await expect(prompt).toHaveAttribute('readonly', '')
  await expect(prompt).toHaveValue(/My product:/)
  return prompt
}

async function expectAccessible(page: Page) {
  // Include content inside the native disclosures in the accessibility scan.
  for (const summary of await page.locator('summary').all()) {
    if (
      (await summary.isVisible()) &&
      (await summary.locator('..').getAttribute('open')) === null
    ) {
      await summary.press('Enter')
    }
  }
  await expectContained(page)
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  expect(
    results.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.map((node) => ({
        target: node.target,
        failureSummary: node.failureSummary,
      })),
    })),
    'Guides must pass WCAG 2 and 2.1 A/AA checks, including color contrast',
  ).toEqual([])
}

async function installClipboard(page: Page, blocked: boolean) {
  await page.addInitScript((shouldBlock) => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          if (shouldBlock) throw new DOMException('Clipboard access denied', 'NotAllowedError')
          Object.defineProperty(window, '__guideCopiedPrompt', { configurable: true, value })
        },
      },
    })
  }, blocked)
}

for (const viewport of [
  { width: 320, height: 720 },
  { width: 1280, height: 900 },
]) {
  test.describe(`guides at ${viewport.width}px`, () => {
    test.use({ viewport })

    for (const route of routes) {
      test(`${route.path} supports keyboard navigation, readable layout, and WCAG accessibility`, async ({
        page,
      }) => {
        await openGuide(page, route)
        await exerciseContents(page, route)
        if (route.path === '/build') {
          await openPrompt(page)
          await showManualPrompt(page)
        }
        await expectContained(page)
        await expectAccessible(page)
      })
    }

    test.describe('without JavaScript', () => {
      test.use({ javaScriptEnabled: false })

      for (const route of routes) {
        test(`${route.path} delivers its content, native contents, and deep links`, async ({
          page,
        }) => {
          await openGuide(page, route)
          await exerciseContents(page, route)
          await expect(page.locator('section[id] p').first()).toBeVisible()
          if (route.path === '/build') {
            await openPrompt(page)
            const prompt = await showManualPrompt(page)
            await prompt.focus()
            await prompt.press('ControlOrMeta+A')
            expect(
              await prompt.evaluate((element) => {
                const textarea = element as HTMLTextAreaElement
                return textarea.selectionEnd - textarea.selectionStart === textarea.value.length
              }),
              'The entire prompt must be selectable without JavaScript',
            ).toBe(true)
          }
          await expectContained(page)
        })
      }
    })

    for (const blocked of [false, true]) {
      test(`build prompt handles ${blocked ? 'blocked clipboard with a manual fallback' : 'successful clipboard copying'}`, async ({
        page,
      }) => {
        await installClipboard(page, blocked)
        await openGuide(page, routes[1])
        await openPrompt(page)
        const button = page.getByRole('button', {
          name: 'Copy the Juicebox build prompt',
          exact: true,
        })
        const status = page
          .getByRole('status')
          .filter({ hasText: /^(?:Prompt copied|Copy was blocked)/ })
        const message = blocked
          ? 'Copy was blocked by your browser. Select and copy the prompt below.'
          : 'Prompt copied. Paste it into your assistant and describe your product.'
        // A server-rendered button can appear before its React handler attaches.
        await expect(async () => {
          await button.click()
          await expect(status).toHaveText(message, { timeout: 2_000 })
        }).toPass({ timeout: 15_000 })
        await expect(status).toHaveAttribute('aria-atomic', 'true')
        await expect(button).toBeEnabled()

        const prompt = blocked
          ? page.getByRole('textbox', { name: 'Juicebox build prompt', exact: true })
          : await showManualPrompt(page)
        await expect(prompt).toBeVisible()
        await expect(prompt).toHaveAttribute('readonly', '')
        await expect(prompt).toHaveValue(/My product:/)
        if (!blocked) {
          const copied = await page.evaluate(() => Reflect.get(window, '__guideCopiedPrompt'))
          expect(copied).toBe(await prompt.inputValue())
        }
        await expectVisibleKeyboardFocus(page, prompt)
        await prompt.press('ControlOrMeta+A')
        expect(
          await prompt.evaluate((element) => {
            const textarea = element as HTMLTextAreaElement
            return textarea.selectionEnd - textarea.selectionStart === textarea.value.length
          }),
          'The fallback prompt must support keyboard selection',
        ).toBe(true)
        await expectContained(page)
        await expectAccessible(page)
      })
    }
  })
}
