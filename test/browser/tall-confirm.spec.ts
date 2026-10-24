import { expect, test } from '@playwright/test'

/**
 * A review taller than the viewport must stay reachable from both ends at
 * 640 px and wider. With the overlay centering its content, the top of a tall
 * dialog sat above the scrollable area and could never be scrolled to.
 * Class names cannot prove that; layout can.
 */
for (const viewport of [
  { width: 320, height: 720 },
  { width: 640, height: 480 },
  { width: 900, height: 600 },
  { width: 1280, height: 720 },
]) {
  test(`a tall review keeps its header and footer reachable at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport)
    await page.goto('/tall-confirm-proof', { waitUntil: 'domcontentloaded' })
    const dialog = page.locator('dialog[open]')
    await expect(dialog).toBeVisible()

    const section = dialog.locator('section[data-tx-confirm]')
    const label = section.getByText('Project owner', { exact: true })
    const labelSize = await label.evaluate(node => {
      // The grid item stretches with a wrapped value; measure the text itself.
      const text = document.createRange()
      text.selectNodeContents(node)
      return {
        height: text.getBoundingClientRect().height,
        lineHeight: parseFloat(getComputedStyle(node).lineHeight),
        whiteSpace: getComputedStyle(node).whiteSpace,
      }
    })
    expect(labelSize.whiteSpace).toBe('nowrap')
    expect(labelSize.height).toBeLessThanOrEqual(labelSize.lineHeight + 1)
    expect(await section.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
    const scroller = dialog
    const taller = await section.evaluate((node, height) => node.getBoundingClientRect().height > height, viewport.height)
    expect(taller, 'the proof content must be taller than the viewport').toBe(true)

    // At the top: the header is fully inside the viewport.
    await scroller.evaluate(node => { node.scrollTop = 0 })
    const header = await dialog.locator('header').first().boundingBox()
    expect(header!.y).toBeGreaterThanOrEqual(0)

    await page.screenshot({ path: testInfo.outputPath('modal-labels.png') })

    // At the bottom: the footer's confirm button is inside the viewport and clickable.
    await scroller.evaluate(node => { node.scrollTop = node.scrollHeight })
    const footer = await dialog.locator('footer').boundingBox()
    expect(footer!.y + footer!.height).toBeLessThanOrEqual(viewport.height)
    await expect(dialog.getByRole('button', { name: 'Try again' })).toBeInViewport()
  })
}
