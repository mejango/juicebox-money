// @vitest-environment jsdom
import { createElement } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { NftCheckoutImage } from '@/components/project/NftCheckoutImage'
import { NftCheckoutCard } from '@/components/project/NftCheckoutCard'
import { NftCartLine } from '@/components/project/NftCartLine'

describe('checkout media decode failures', () => {
  it('shows the fallback on error, retries a changed source and ignores a stale image error', async () => {
    const props = { image: 'broken.svg', name: 'Away team', className: 'preview', fallback: createElement('span', null, 'Away team') }
    let view!: TestRenderer.ReactTestRenderer
    await act(async () => { view = TestRenderer.create(createElement(NftCheckoutImage, props)) })
    const originalError = view.root.findByType('img').props.onError
    await act(async () => originalError())
    expect(view.root.findAllByType('img')).toHaveLength(0)
    expect(JSON.stringify(view.toJSON())).toContain('Away team')
    await act(async () => view.update(createElement(NftCheckoutImage, { ...props, image: 'valid.svg' })))
    expect(view.root.findByType('img').props.src).toBe('valid.svg')
    await act(async () => originalError())
    expect(view.root.findByType('img').props.src).toBe('valid.svg')
    await act(async () => view.root.findByType('img').props.onError())
    await act(async () => originalError())
    expect(view.root.findAllByType('img')).toHaveLength(0)
    await act(async () => view.unmount())
  })
  it('preserves named card selection and selected cart quantity actions after image errors', async () => {
    const onSelect = vi.fn(), onAdd = vi.fn(), onRemove = vi.fn()
    let card!: TestRenderer.ReactTestRenderer, cart!: TestRenderer.ReactTestRenderer
    await act(async () => {
      card = TestRenderer.create(createElement(NftCheckoutCard, { tierId: 2, name: 'Away team', image: 'broken.svg', qty: 0, priceLabel: '2.75 USDC', soldOut: false, busy: false, canAdd: true, onSelect, onAdd, onRemove }))
      cart = TestRenderer.create(createElement(NftCartLine, { tierId: 2, name: 'Away team', image: 'broken.svg', quantity: 1, onAdd, onRemove }))
    })
    await act(async () => { card.root.findByType('img').props.onError(); cart.root.findByType('img').props.onError() })
    expect(card.root.findAllByType('img')).toHaveLength(0)
    expect(cart.root.findAllByType('img')).toHaveLength(0)
    expect(JSON.stringify(card.toJSON())).toContain('Away team')
    expect(JSON.stringify(cart.toJSON())).toContain('Away team')
    await act(async () => { card.root.findByProps({ 'aria-label': 'Away team' }).props.onClick(); cart.root.findByProps({ 'aria-label': 'Add one Away team' }).props.onClick() })
    expect(onSelect).toHaveBeenCalledOnce(); expect(onAdd).toHaveBeenCalledOnce()
    await act(async () => { card.unmount(); cart.unmount() })
  })
})
