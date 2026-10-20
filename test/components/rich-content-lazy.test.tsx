// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { RichContent } from '@/components/RichContent'

it('shows the escaped fallback until the lazy sanitizer renders the allowlisted HTML', async () => {
  const host = document.createElement('div')
  const root = createRoot(host)
  act(() => {
    root.render(
      <RichContent html={'Hello **world**<script>alert(1)</script>'} fallback={['Hello world']} />,
    )
  })
  expect(host.innerHTML).toBe('<div class=""><p>Hello world</p></div>')
  await act(async () => { await import('@/lib/rich-content-sanitize') })
  await vi.waitFor(() => expect(host.querySelector('strong')?.textContent).toBe('world'))
  expect(host.querySelector('script')).toBeNull()
  act(() => root.unmount())
})
