import { expect, test, type BrowserContext, type Page } from '@playwright/test'

/**
 * The real proof of the modal accessibility contract.
 *
 * jsdom has no top layer, no hit testing and no focus scoping, so the unit
 * suite can only assert the state machine around `showModal()`. Everything
 * that actually protects a screen-reader or keyboard user — the page behind an
 * open modal being unreachable, a stacked dialog sitting above the one under
 * it regardless of z-index, the page coming back afterwards — is a browser
 * behaviour, and this is where it is checked.
 *
 * `/modal-proof` is a deterministic-build-only route (see
 * `src/app/modal-proof/page.browsertest.tsx`).
 */

function isLocalHostname(hostname: string) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
}

async function blockExternalTraffic(context: BrowserContext) {
  await context.route(/^https?:\/\//, async route => {
    if (isLocalHostname(new URL(route.request().url()).hostname)) {
      await route.continue()
      return
    }
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'External browser traffic is disabled' }),
    })
  })
  await context.routeWebSocket(
    url => !isLocalHostname(url.hostname),
    socket => socket.close(),
  )
}

const INTERACTIVE =
  'a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])'

/**
 * Nothing outside the topmost dialog can take focus: not by tabbing, and not
 * even by calling `focus()` on it, because everything behind a `showModal()`
 * dialog is inert.
 */
async function expectFocusScopedToTopDialog(page: Page) {
  const startedInside = await page.evaluate(() => {
    const dialog = [...document.querySelectorAll('dialog[open]')].pop()
    return !!dialog && !!document.activeElement && dialog.contains(document.activeElement)
  })
  expect(startedInside, 'showModal() must move focus into the dialog').toBe(true)

  for (let step = 0; step < 12; step += 1) {
    await page.keyboard.press('Tab')
    const escaped = await page.evaluate(interactive => {
      const dialog = [...document.querySelectorAll('dialog[open]')].pop()
      const active = document.activeElement
      if (!dialog || !active || dialog.contains(active)) return null
      // Chrome parks focus on <body> when it cycles past the last control;
      // that is still inside the modal scope. Reaching a real control outside
      // the dialog is what would break the contract.
      return active.matches(interactive) ? active.outerHTML.slice(0, 120) : null
    }, INTERACTIVE)
    expect(escaped, `Tab ${step + 1} reached content behind the modal`).toBeNull()
  }
}

/** Inert elements refuse programmatic focus — the AT-visibility guarantee. */
async function expectRefusesFocus(page: Page, selector: string) {
  const focused = await page.evaluate(target => {
    const element = document.querySelector<HTMLElement>(target)
    element?.focus()
    return document.activeElement === element
  }, selector)
  expect(focused, `${selector} must be inert while a modal is open`).toBe(false)
}

test.beforeEach(async ({ context, page }) => {
  await blockExternalTraffic(context)
  await page.goto('/modal-proof', { waitUntil: 'domcontentloaded' })
  await expect(
    page.getByRole('heading', { level: 1, name: 'Modal accessibility proof' }),
  ).toBeVisible()
  // Nothing is clickable until React has attached its handlers.
  await expect(page.locator('[data-modal-proof-ready="true"]')).toBeVisible()
})

test('an open modal makes the page behind it unreachable, and gives it back on close', async ({
  page,
}) => {
  const backgroundButton = page.getByTestId('background-button')
  const overflowBefore = await page.evaluate(() => document.body.style.overflow)

  await backgroundButton.click()
  await expect(page.getByTestId('background-state')).toHaveText('1')

  await page.getByTestId('open-modal').click()
  const dialog = page.locator('dialog[open]')
  await expect(dialog).toHaveCount(1)

  const modalGeometry = await dialog.evaluate(node => {
    const card = node.querySelector<HTMLElement>('[data-modal-card]')!
    const body = node.querySelector<HTMLElement>('[data-modal-body]')!
    const footer = node.querySelector<HTMLElement>('[data-modal-footer]')!
    const closeIcon = node.querySelector<SVGElement>(
      'button[aria-label="Close"] svg',
    )!
    const cardBox = card.getBoundingClientRect()
    const bodyBox = body.getBoundingClientRect()
    const footerBox = footer.getBoundingClientRect()
    const closeIconBox = closeIcon.getBoundingClientRect()
    const bodyStyles = getComputedStyle(body)
    const cardStyles = getComputedStyle(card)
    return {
      closeRight: closeIconBox.right,
      contentRight:
        bodyBox.right - Number.parseFloat(bodyStyles.paddingRight),
      footerBottom: footerBox.bottom,
      cardBottom: cardBox.bottom,
      cardOverflow: cardStyles.overflow,
      bottomRadius: Number.parseFloat(cardStyles.borderBottomRightRadius),
    }
  })
  expect(
    Math.abs(modalGeometry.closeRight - modalGeometry.contentRight),
  ).toBeLessThanOrEqual(2)
  expect(
    Math.abs(modalGeometry.footerBottom - modalGeometry.cardBottom),
  ).toBeLessThanOrEqual(1)
  expect(modalGeometry.cardOverflow).toBe('hidden')
  expect(modalGeometry.bottomRadius).toBeGreaterThan(0)

  // `showModal()` gives the dialog modal semantics natively. `:modal` is the
  // browser's own answer to "is the rest of the page inert?".
  expect(await dialog.evaluate(node => node.matches(':modal'))).toBe(true)
  // ...and it is implicit, so the markup must not restate it.
  await expect(dialog).not.toHaveAttribute('role', /.+/)
  await expect(dialog).not.toHaveAttribute('aria-modal', /.+/)
  await expect(dialog).toHaveAttribute('aria-labelledby', /.+/)

  // The top layer paints above every stacking context: the backdrop swallows
  // pointer events aimed at the page, with no z-index involved.
  await expect(async () => {
    await backgroundButton.click({ timeout: 1_000 })
  }).rejects.toThrow()
  await expect(page.getByTestId('background-state')).toHaveText('1')

  // Keyboard users cannot leave the dialog either, and the page behind it
  // refuses focus outright — that is what hides it from assistive technology.
  await expectFocusScopedToTopDialog(page)
  await expectRefusesFocus(page, '[data-testid="background-button"]')
  await expectRefusesFocus(page, '[data-testid="background-link"]')

  // Body scroll is locked while any modal is open.
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden')

  // The content inside is fully interactive.
  await page.getByTestId('inside-button').click()
  await expect(page.getByTestId('inside-state')).toHaveText('clicked')

  // Escape reaches the shell through the native `cancel` event.
  await page.keyboard.press('Escape')
  await expect(page.locator('dialog')).toHaveCount(0)

  // Everything is restored: pointer events, and the page's own scrolling.
  await backgroundButton.click()
  await expect(page.getByTestId('background-state')).toHaveText('2')
  expect(await page.evaluate(() => document.body.style.overflow)).toBe(
    overflowBefore,
  )
})

test('a review dialog opened over a modal is interactive above it', async ({
  page,
}) => {
  await page.getByTestId('open-modal').click()
  await page.getByTestId('open-review').click()

  const dialogs = page.locator('dialog[open]')
  await expect(dialogs).toHaveCount(2)
  const review = dialogs.nth(1)
  await expect(
    review.getByRole('heading', { name: 'Stacked review dialog' }),
  ).toBeVisible()

  // Top-layer order, not z-index, decides which dialog is on top: the shell
  // below carries no z-index at all and the review dialog is still above it.
  for (const dialog of [dialogs.nth(0), review]) {
    expect(await dialog.evaluate(node => getComputedStyle(node).zIndex)).toBe(
      'auto',
    )
  }

  // The modal underneath is now the inert background.
  await expect(async () => {
    await page.getByTestId('open-review').click({ timeout: 1_000 })
  }).rejects.toThrow()
  await expectFocusScopedToTopDialog(page)
  await expectRefusesFocus(page, '[data-testid="inside-button"]')

  // The dialog on top is interactive.
  await review.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialogs).toHaveCount(1)
  await expect(page.getByTestId('review-state')).toHaveText('cancelled')

  // Closing the stacked dialog must NOT unlock the page: the shell is still
  // open. This is the reference-counted scroll lock.
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden')
  await page.getByTestId('inside-button').click()
  await expect(page.getByTestId('inside-state')).toHaveText('clicked')

  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page.locator('dialog')).toHaveCount(0)
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('')
})

test('a backdrop click closes the modal but a click inside it does not', async ({
  page,
}) => {
  await page.getByTestId('open-modal').click()
  const dialog = page.locator('dialog[open]')
  await expect(dialog).toHaveCount(1)

  await page.getByTestId('inside-state').click()
  await expect(dialog).toHaveCount(1)

  // Backdrop clicks land on the dialog element itself; content is in a child.
  const box = (await dialog.boundingBox())!
  await page.mouse.click(box.x + 4, box.y + box.height - 4)
  await expect(page.locator('dialog')).toHaveCount(0)
})

test('a body-level overlay is inert under an open modal, a dialog-hosted one is not', async ({
  page,
}) => {
  // The reason `ParaModalHost` owns a `showModal()` dialog. Everything that is
  // not a descendant of the topmost open dialog is inert — z-index cannot buy
  // its way out, and neither can a body-level portal, which is what a
  // third-party sign-in overlay renders by default.
  await page.getByTestId('open-modal').click()
  await expect(page.locator('dialog[open]')).toHaveCount(1)

  await page.getByTestId('mount-body-overlay').click()
  await expect(page.getByTestId('body-overlay-button')).toBeAttached()
  await expectRefusesFocus(page, '[data-testid="body-overlay-button"]')
  await expect(async () => {
    await page.getByTestId('body-overlay-button').click({ timeout: 1_000 })
  }).rejects.toThrow()
  await expect(page.getByTestId('body-overlay-button')).not.toHaveAttribute(
    'data-clicked',
    'true',
  )

  // The same overlay hosted in its own `showModal()` dialog is live.
  await page.getByTestId('mount-hosted-overlay').click()
  await expect(page.locator('dialog[open]')).toHaveCount(2)
  const hosted = page.getByTestId('hosted-overlay-button')
  await hosted.focus()
  await expect(hosted).toBeFocused()
  await hosted.click()
  await expect(hosted).toHaveAttribute('data-clicked', 'true')
})
