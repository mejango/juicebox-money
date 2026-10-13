import { expect, test } from '@playwright/test'

/**
 * A review taller than the viewport must stay reachable from both ends at
 * 640 px and wider. With the overlay centering its content, the top of a tall
 * dialog sat above the scrollable area and could never be scrolled to.
 * Class names cannot prove that; layout can.
 */
for (const viewport of [
  { width: 640, height: 480 },
  { width: 900, height: 600 },
  { width: 1280, height: 720 },
]) {
  test(`a tall review keeps its header and footer reachable at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await page.goto('/tall-confirm-proof', { waitUntil: 'domcontentloaded' })
    const dialog = page.locator('dialog[open]')
    await expect(dialog).toBeVisible()

    const section = dialog.locator('section[data-tx-confirm]')
    const scroller = dialog
    const taller = await section.evaluate((node, height) => node.getBoundingClientRect().height > height, viewport.height)
    expect(taller, 'the proof content must be taller than the viewport').toBe(true)

    // At the top: the header is fully inside the viewport.
    await scroller.evaluate(node => { node.scrollTop = 0 })
    const header = await dialog.locator('header').first().boundingBox()
    expect(header!.y).toBeGreaterThanOrEqual(0)

    // At the bottom: the footer's confirm button is inside the viewport and clickable.
    await scroller.evaluate(node => { node.scrollTop = node.scrollHeight })
    const footer = await dialog.locator('footer').boundingBox()
    expect(footer!.y + footer!.height).toBeLessThanOrEqual(viewport.height)
    await expect(dialog.getByRole('button', { name: 'Confirm' })).toBeInViewport()
  })
}
