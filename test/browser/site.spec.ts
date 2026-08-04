import AxeBuilder from '@axe-core/playwright'
import {
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test'

const viewports = [
  { label: 'phone-320', width: 320, height: 720 },
  { label: 'phone-390', width: 390, height: 844 },
  { label: 'tablet-768', width: 768, height: 1024 },
  { label: 'wide-1100', width: 1100, height: 900 },
  { label: 'desktop-1280', width: 1280, height: 800 },
] as const

const routes = [
  {
    path: '/create',
    heading: 'Start a project',
    create: true,
  },
  {
    path: '/',
    heading: 'Fund your thing',
  },
  {
    path: '/eth:1',
    heading: 'Browser Fixture Project',
    project: true,
  },
] as const

function isLocalHostname(hostname: string) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
}

async function blockExternalTraffic(context: BrowserContext) {
  const attempts = { http: [] as string[], webSockets: [] as string[] }
  await context.route(/^https?:\/\//, async route => {
    const url = route.request().url()
    if (isLocalHostname(new URL(url).hostname)) {
      await route.continue()
      return
    }
    attempts.http.push(url)
    // Fulfil locally instead of opening a socket. A fast HTTP failure lets
    // client libraries exercise their normal error handling without turning
    // an intentionally blocked fetch into an unhandled browser exception.
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'External browser traffic is disabled' }),
    })
  })

  await context.routeWebSocket(
    url => !isLocalHostname(url.hostname),
    socket => {
      attempts.webSockets.push(socket.url())
      socket.close()
    },
  )
  return attempts
}

function securityHeaders(headers: Record<string, string>) {
  expect(headers['x-frame-options']).toBe('DENY')
  expect(headers['x-content-type-options']).toBe('nosniff')
  expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin')
  expect(headers['permissions-policy']).toContain('camera=()')
  expect(headers['permissions-policy']).toContain('microphone=()')
  expect(headers['permissions-policy']).toContain('geolocation=()')
}

async function expectNoDocumentOverflow(page: Page, surface: string) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))
  expect(
    dimensions.scrollWidth,
    `${surface} introduced document-level horizontal overflow`,
  ).toBeLessThanOrEqual(dimensions.clientWidth + 1)
}

async function expectVisibleFocus(page: Page, locator: Locator, surface: string) {
  await locator.focus()
  // Return to the target through keyboard navigation so :focus-visible (not
  // merely :focus after a pointer click) is the state under test. Traverse
  // backwards first: the content mounted by activating a tab can add the next
  // focusable element asynchronously, while the preceding focus order is
  // already stable.
  await locator.press('Shift+Tab')
  await page.keyboard.press('Tab')
  await expect(locator, `${surface} focus target`).toBeFocused()
  const focusIndicator = await locator.evaluate(element => {
    const style = getComputedStyle(element)
    return {
      boxShadow: style.boxShadow,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
    }
  })
  expect(
    (focusIndicator.outlineStyle !== 'none' &&
      focusIndicator.outlineWidth !== '0px') ||
      focusIndicator.boxShadow !== 'none',
    `${surface} must expose a visible keyboard focus indicator`,
  ).toBe(true)
}

async function expectAxeClean(page: Page, surface: string) {
  const axe = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  const severe = axe.violations.filter(
    violation =>
      violation.id !== 'color-contrast' &&
      (violation.impact === 'serious' || violation.impact === 'critical'),
  )
  expect(
    severe.map(violation => ({
      id: violation.id,
      impact: violation.impact,
      targets: violation.nodes.map(node => node.target),
    })),
    `${surface} has serious or critical accessibility violations`,
  ).toEqual([])

  const contrastNodes =
    axe.violations.find(violation => violation.id === 'color-contrast')?.nodes ??
    []
  expect(
    contrastNodes.map(node => ({
      target: node.target,
      html: node.html,
      failureSummary: node.failureSummary,
    })),
    `${surface} has color-contrast violations`,
  ).toEqual([])
}

async function expectSurface(page: Page, surface: string) {
  await expectNoDocumentOverflow(page, surface)
  await expectAxeClean(page, surface)
}

async function exerciseCreateWizard(page: Page, viewport: string) {
  const flavor = page.getByLabel('Project flavor')
  const stepper = page.getByRole('navigation', { name: 'Create steps' })

  await expect(page.locator('[data-create-ready="true"]')).toBeVisible()
  await expect(stepper.getByRole('button')).toHaveCount(4)
  const environment = page.getByLabel('Deployment environment')
  await expect(environment).toHaveValue('production')
  await environment.selectOption('testnet')
  await expect(
    page.getByRole('group', { name: 'Chains' }).getByRole('button'),
  ).toHaveCount(4)
  await expect(
    page.getByRole('button', { name: 'Remove Sepolia' }),
  ).toBeVisible()
  await environment.selectOption('production')
  // A state transition is a deterministic hydration handshake; changing the
  // select before React attaches would only mutate the temporary server DOM.
  await page.getByRole('button', { name: 'Next →' }).click()
  await expect(
    page.getByRole('heading', { level: 2, name: 'How should it appear?' }),
  ).toBeVisible()
  await page.getByRole('button', { name: '← Back' }).click()
  await expect(
    page.getByRole('heading', { level: 2, name: 'What are you launching?' }),
  ).toBeVisible()
  await flavor.selectOption('project')
  await expect(stepper.getByRole('button')).toHaveCount(5)
  await expect(
    page.getByText('The project owner sets the rules', { exact: false }),
  ).toBeVisible()
  await flavor.selectOption('revnet')
  await expect(stepper.getByRole('button')).toHaveCount(5)
  await expect(page.getByText('Fixed rules that run forever', { exact: false })).toBeVisible()

  const steps = [
    { index: 0, heading: 'What are you launching?', label: 'Flavor' },
    { index: 1, heading: 'How should it appear?', label: 'Look & Feel' },
    { index: 2, heading: 'How should it work?', label: 'Stages' },
    { index: 3, heading: 'Stock your shop', label: 'Shop' },
    { index: 4, heading: 'Review & launch', label: 'Launch' },
  ] as const

  for (const step of steps) {
    const button = stepper.getByRole('button').nth(step.index)
    await button.click()
    await expect(button).toHaveAttribute('aria-current', 'step')
    await expect(
      page.getByRole('heading', { level: 2, name: step.heading }),
    ).toBeVisible()
    await expectVisibleFocus(page, button, `${viewport} create ${step.label}`)
    await expectSurface(page, `${viewport} create ${step.label}`)
  }

  await expect(
    page.getByText('Wallet connected at launch', { exact: true }),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sign in to launch' })).toBeVisible()
}

async function exerciseProjectSurfaces(
  page: Page,
  viewport: (typeof viewports)[number],
) {
  const projectTabs = page.getByRole('tablist', { name: 'Project sections' })
  const activeTab = viewport.width <= 800 ? 'Activity' : 'Overview'
  await expect(projectTabs).toBeVisible()
  await expect(
    projectTabs.getByRole('tab', { name: activeTab, exact: true }),
  ).toHaveAttribute('aria-selected', 'true')
  const tabScroll = page.locator('[data-project-tab-scroll]')
  await expect(tabScroll).toHaveCSS('touch-action', 'pan-x')
  await expect(tabScroll).toHaveCSS('overflow-y', 'hidden')
  const overviewBox = await projectTabs
    .getByRole('tab', { name: 'Overview', exact: true })
    .boundingBox()
  const overflowBox = await page
    .getByRole('button', { name: /^More project sections/ })
    .boundingBox()
  expect(overviewBox).not.toBeNull()
  expect(overflowBox).not.toBeNull()
  expect(
    Math.abs(
      overviewBox!.y + overviewBox!.height / 2 -
        (overflowBox!.y + overflowBox!.height / 2),
    ),
  ).toBeLessThanOrEqual(1)

  const payCard = page.locator('#project-pay-card')
  await expect(payCard.getByLabel('Amount')).toBeVisible()
  const payBox = await payCard.boundingBox()
  const tabsBox = await projectTabs.boundingBox()
  expect(payBox).not.toBeNull()
  expect(tabsBox).not.toBeNull()
  if (viewport.width > 800) {
    expect(payBox!.x).toBeLessThan(tabsBox!.x)
  } else {
    expect(tabsBox!.y).toBeGreaterThanOrEqual(payBox!.y + payBox!.height)
    expect(Math.abs(tabsBox!.x - payBox!.x)).toBeLessThanOrEqual(8)
  }
  // USDC only appears after the ABI-correct accounting-context and ERC-20
  // reads resolve; the unhydrated fallback says ETH.
  await expect(payCard.getByText('USDC', { exact: true })).toBeVisible()
  await expect(
    payCard.getByText("Couldn't verify this project's accepted tokens"),
  ).toHaveCount(0)
  await expect(
    payCard.getByText("This project doesn't list the direct payment terminal"),
  ).toHaveCount(0)

  await expect(page.getByText('2 owners', { exact: true })).toBeVisible()
  const metadataIndex = viewport.width >= 768 ? 1 : 0
  await expect(page.getByText('Flavor:', { exact: true }).nth(metadataIndex)).toBeVisible()
  await expect(page.getByText('Created:', { exact: true }).nth(metadataIndex)).toBeVisible()
  const inlineMetadata = page.locator('[data-project-metadata-inline]')
  if (viewport.width >= 768) {
    await expect(inlineMetadata).toBeVisible()
    const metadataRows = await inlineMetadata.locator(':scope > span').evaluateAll(nodes =>
      new Set(nodes.map(node => Math.round(node.getBoundingClientRect().top))).size,
    )
    expect(metadataRows).toBe(1)
  } else {
    await expect(inlineMetadata).toBeHidden()
  }

  const statSeparators = await page
    .locator('header [data-project-stats] [data-project-stat]')
    .evaluateAll(nodes =>
      nodes.map(node => {
        const rect = node.getBoundingClientRect()
        return {
          middle: Math.round(rect.top + rect.height / 2),
          left: rect.left,
          right: rect.right,
          hasLeadingSeparator: parseFloat(getComputedStyle(node).borderLeftWidth) > 0,
        }
      }),
    )
  for (let index = 0; index < statSeparators.length; index += 1) {
    const previous = statSeparators[index - 1]
    const sameLine = !!previous && Math.abs(statSeparators[index].middle - previous.middle) <= 1
    expect(statSeparators[index].hasLeadingSeparator).toBe(sameLine)
  }
  if (viewport.width < 768) {
    const firstRowGap = statSeparators[1].left - statSeparators[0].right
    const secondRowGap = statSeparators[3].left - statSeparators[2].right
    expect(Math.abs(firstRowGap - secondRowGap)).toBeLessThanOrEqual(1)
  }

  const shopPreview = payCard.getByText('Shop', { exact: true })
  if ((await shopPreview.count()) === 0) {
    const paySpacing = await payCard.evaluate(card => {
      const select = card.querySelector<HTMLSelectElement>('select[aria-label="Payment mode"]')
      const label = select?.previousElementSibling
      const note = card.querySelector<HTMLInputElement>('input[aria-label="Note"]')
      if (!label || !note) return null
      const cardRect = card.getBoundingClientRect()
      const labelRect = label.getBoundingClientRect()
      const noteRect = note.getBoundingClientRect()
      return {
        top: labelRect.top - cardRect.top,
        bottom: cardRect.bottom - noteRect.bottom,
      }
    })
    expect(paySpacing).not.toBeNull()
    expect(Math.abs(paySpacing!.top - paySpacing!.bottom)).toBeLessThanOrEqual(6)
  }

  if (viewport.width <= 800) {
    const activity = projectTabs.getByRole('tab', {
      name: 'Activity',
      exact: true,
    })
    await expect(
      activity.locator('[data-project-tab-icon="activity"]'),
    ).toHaveCount(1)
    await activity.click()
    await expect(activity).toHaveAttribute('aria-selected', 'true')
    await expectVisibleFocus(page, activity, `${viewport.label} project Activity`)
  } else {
    await expect(
      page.getByRole('heading', { level: 2, name: 'Activity' }),
    ).toBeVisible()
  }
  await expectSurface(page, `${viewport.label} project Activity`)

  await page.evaluate(() => {
    const monitorWindow = window as typeof window & {
      projectRouteSkeletonObserver?: MutationObserver
    }
    document.documentElement.dataset.projectRouteSkeletonObserved = 'false'
    monitorWindow.projectRouteSkeletonObserver?.disconnect()
    monitorWindow.projectRouteSkeletonObserver = new MutationObserver(() => {
      if (document.querySelector('[aria-label="Loading project"]')) {
        document.documentElement.dataset.projectRouteSkeletonObserved = 'true'
      }
    })
    monitorWindow.projectRouteSkeletonObserver.observe(document.body, {
      childList: true,
      subtree: true,
    })
  })

  const tabs = [
    {
      label: 'Overview',
      icon: 'globe',
      ready: () => page.getByText('Details', { exact: true }),
    },
    {
      label: 'Terms',
      icon: 'stages',
      ready: () => page.getByText('Token issuance', { exact: true }),
    },
    {
      label: 'Owners',
      icon: 'stack',
      ready: () => page.getByText('Sign in to see your position.', { exact: true }),
    },
    {
      label: 'Shop',
      icon: 'shop',
      ready: () => page.getByText('No store yet.', { exact: false }),
    },
    {
      label: 'Extras',
      icon: 'extras',
      ready: () => page.getByRole('heading', { level: 2, name: 'Payer address' }),
    },
    {
      label: 'Operator',
      icon: 'operator',
      ready: () => page.getByText('Everyday owner/operator changes.', { exact: false }),
    },
  ] as const

  for (const tab of tabs) {
    const overflow = tab.label === 'Extras' || tab.label === 'Operator'
    const moreButton = page.getByRole('button', { name: /^More project sections/ })
    let button = projectTabs.getByRole('tab', {
      name: tab.label,
      exact: true,
    })
    if (overflow) {
      await expect(
        moreButton.locator('[data-project-tab-icon="more"]'),
      ).toHaveCount(1)
      if ((await button.count()) === 0) await moreButton.click()
      button = projectTabs.getByRole('tab', { name: tab.label, exact: true })
      await expect(
        button.locator(`[data-project-tab-icon="${tab.icon}"]`),
      ).toHaveCount(1)
      await expect(moreButton.locator('[data-overflow-orientation="horizontal"]')).toHaveCount(1)
      await button.click()
      await expect(moreButton).toHaveAttribute(
        'aria-label',
        `More project sections, current: ${tab.label}`,
      )
    } else {
      await expect(
        button.locator(`[data-project-tab-icon="${tab.icon}"]`),
      ).toHaveCount(1)
      await button.click()
      await expect(button).toHaveAttribute('aria-selected', 'true')
    }
    await expect(tab.ready()).toBeVisible()
    await expectVisibleFocus(page, button, `${viewport.label} project ${tab.label}`)
    await expectSurface(page, `${viewport.label} project ${tab.label}`)
  }

  expect(
    await page.locator('html').getAttribute('data-project-route-skeleton-observed'),
  ).toBe('false')
  await page.evaluate(() => {
    const monitorWindow = window as typeof window & {
      projectRouteSkeletonObserver?: MutationObserver
    }
    monitorWindow.projectRouteSkeletonObserver?.disconnect()
    delete monitorWindow.projectRouteSkeletonObserver
    delete document.documentElement.dataset.projectRouteSkeletonObserved
  })

  const moreButton = page.getByRole('button', { name: /^More project sections/ })
  await moreButton.click()
  await expect(moreButton).toHaveAttribute('aria-expanded', 'false')
  await expect(
    moreButton.locator('[data-overflow-orientation="vertical"]'),
  ).toHaveCount(1)
  await expect(
    projectTabs.getByRole('tab', { name: 'Extras', exact: true }),
  ).toHaveCount(0)
}

for (const viewport of viewports) {
  test.describe(viewport.label, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } })

    for (const route of routes) {
      test(`${route.path} keeps its production shape and safety invariants`, async ({
        context,
        page,
      }, testInfo) => {
        if ('project' in route || 'create' in route) {
          testInfo.setTimeout(90_000)
        }

        const pageErrors: string[] = []
        page.on('pageerror', error => pageErrors.push(error.message))
        const externalTraffic = await blockExternalTraffic(context)
        await page.emulateMedia({ reducedMotion: 'reduce' })

        const response = await page.goto(route.path, { waitUntil: 'domcontentloaded' })
        expect(response?.status()).toBe(200)
        securityHeaders(response?.headers() ?? {})

        await page.evaluate(() => document.fonts.ready)
        await expect(page.locator('main:visible')).toHaveCount(1)
        await expect(
          page.getByRole('heading', {
            level: 1,
            name: new RegExp(route.heading, 'i'),
          }),
        ).toBeVisible()

        if ('project' in route) {
          await exerciseProjectSurfaces(page, viewport)
        } else if ('create' in route) {
          await exerciseCreateWizard(page, viewport.label)
        } else {
          const fixtureHeading = page.getByRole('heading', {
            level: 3,
            name: 'Browser Fixture Project',
          })
          // The production route uses stale-while-revalidate. A build made
          // before the fixture starts can serve one empty cached response;
          // reload until the local revalidation has populated it.
          await expect(async () => {
            if (!(await fixtureHeading.isVisible())) {
              await page.reload({ waitUntil: 'domcontentloaded' })
            }
            await expect(fixtureHeading).toBeVisible()
          }).toPass({ timeout: 15_000, intervals: [250, 500, 1_000] })
          await expect(
            fixtureHeading,
          ).toBeVisible()
          await expect(
            page.getByRole('link', {
              name: 'Open Browser Fixture Project',
              exact: true,
            }),
          ).toBeVisible()
          if (viewport.width < 1024) {
            await page
              .getByRole('radio', { name: 'Fresh activity', exact: true })
              .evaluate(element => {
                const input = element as HTMLInputElement
                input.checked = true
                input.dispatchEvent(new Event('input', { bubbles: true }))
                input.dispatchEvent(new Event('change', { bubbles: true }))
              })
          }
          await expect(
            page.getByText('5 token credits', { exact: false }),
          ).toBeVisible()
          await page.keyboard.press('Tab')
          await expectVisibleFocus(
            page,
            page.locator(':focus'),
            `${viewport.label} home`,
          )
          await expectSurface(page, `${viewport.label} home`)
        }

        await page.waitForTimeout(500)
        expect(pageErrors).toEqual([])
        expect(externalTraffic).toEqual({ http: [], webSockets: [] })
      })
    }
  })
}
