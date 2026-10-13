import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { TxSteps } from '@/components/ui/TxSteps'

it('shows each step’s own state and status when results arrive out of order', () => {
  const html = renderToStaticMarkup(createElement(TxSteps, { activeIndex: -1, steps: [
    { key: 'a', title: 'A', state: 'complete', status: 'Confirmed' },
    { key: 'b', title: 'B', state: 'failed', status: 'Reverted' },
    { key: 'c', title: 'C' },
  ] }))
  expect(html).toContain('data-state="complete"')
  expect(html).toContain('data-state="failed"')
  expect(html).toContain('data-state="pending"')
  expect(html).toContain('Confirmed')
  expect(html).toContain('Reverted')
  expect(html).toContain('×')
})
