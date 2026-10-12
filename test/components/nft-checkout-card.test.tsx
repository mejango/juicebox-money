// @vitest-environment jsdom
import { createElement } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { NftCheckoutCard } from '@/components/project/NftCheckoutCard'

describe('shared NFT checkout card', () => {
  it('keeps the ordinary preview, price selection and stepper callbacks', async () => {
    const onSelect = vi.fn(), onAdd = vi.fn(), onRemove = vi.fn()
    const props = { tierId: 3, name: 'Away team', image: 'data:image/svg+xml;base64,PHN2Zy8+', qty: 0, priceLabel: '2.75 USDC', soldOut: false, busy: false, canAdd: true, onSelect, onAdd, onRemove }
    let view!: TestRenderer.ReactTestRenderer
    await act(async () => { view = TestRenderer.create(createElement(NftCheckoutCard, props)) })
    expect(view.root.findByType('img').props).toMatchObject({ src: props.image, alt: props.name, loading: 'lazy' })
    const preview = view.root.findAllByType('button')[0]
    await act(async () => { preview.props.onClick() })
    expect(onSelect).toHaveBeenCalledOnce()
    await act(async () => { view.update(createElement(NftCheckoutCard, { ...props, qty: 1 })) })
    await act(async () => { view.root.findByProps({ 'aria-label': 'Add one Away team' }).props.onClick(); view.root.findByProps({ 'aria-label': 'Remove one Away team' }).props.onClick() })
    expect(onAdd).toHaveBeenCalledOnce(); expect(onRemove).toHaveBeenCalledOnce()
    await act(async () => { view.unmount() })
  })
  it('retains sold-out placeholder and busy quantity protection', async () => {
    const props = { tierId: 4, name: 'Draw', qty: 0, priceLabel: '1 ETH', soldOut: true, busy: false, canAdd: false, onSelect: vi.fn(), onAdd: vi.fn(), onRemove: vi.fn() }
    let view!: TestRenderer.ReactTestRenderer
    await act(async () => { view = TestRenderer.create(createElement(NftCheckoutCard, props)) })
    expect(view.root.findAllByType('img')).toHaveLength(0)
    expect(JSON.stringify(view.toJSON())).toContain('Sold out')
    expect(view.root.findByType('button').props.disabled).toBe(true)
    await act(async () => { view.update(createElement(NftCheckoutCard, { ...props, soldOut: false, qty: 1, busy: true })) })
    expect(view.root.findByProps({ 'aria-label': 'Add one Draw' }).props.disabled).toBe(true)
    expect(view.root.findByProps({ 'aria-label': 'Remove one Draw' }).props.disabled).toBe(true)
    await act(async () => { view.unmount() })
  })
})
