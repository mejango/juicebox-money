import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import TestRenderer, { act } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { CheckoutAmountRow, CHECKOUT_ACTION_BUTTON_CLASS, CHECKOUT_AMOUNT_INPUT_CLASS } from '@/components/project/CheckoutAmountRow'
import { NftCartLine } from '@/components/project/NftCartLine'

describe('shared checkout presentation', () => {
  it('keeps ordinary input, currency wrapper and action markup in their original order', () => {
    const html = renderToStaticMarkup(createElement(CheckoutAmountRow, {
      amount: createElement('input', { className: CHECKOUT_AMOUNT_INPUT_CLASS, value: '$12', readOnly: true }),
      currency: createElement('span', null, 'ETH'),
      action: createElement('button', { className: CHECKOUT_ACTION_BUTTON_CLASS }, 'Pay'),
    }))
    expect(html).toBe('<div class="input-well flex items-stretch overflow-hidden !p-0"><input class="min-w-0 flex-1 bg-transparent px-4 py-3 text-lg font-medium outline-none placeholder:text-smoke-500 disabled:opacity-60" readOnly="" value="$12"/><div class="flex shrink-0 flex-col items-end justify-center gap-0.5 pr-3"><span>ETH</span></div><button class="btn-primary shrink-0 rounded-l-none px-5 text-sm disabled:opacity-60">Pay</button></div>')
  })

  it('preserves the actual amount/select/action callbacks supplied by the checkout', async () => {
    const amount = vi.fn(), currency = vi.fn(), action = vi.fn()
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => { renderer = TestRenderer.create(createElement(CheckoutAmountRow, {
      amount: createElement('input', { className: CHECKOUT_AMOUNT_INPUT_CLASS, onChange: amount }),
      currency: createElement('select', { onChange: currency }, createElement('option', null, 'USDC')),
      action: createElement('button', { className: CHECKOUT_ACTION_BUTTON_CLASS, onClick: action, disabled: true }, 'Pay'),
    })) })
    const amountEvent = { target: { value: '12.5' } }, currencyEvent = { target: { value: 'USDC' } }
    await act(async () => { renderer.root.findByType('input').props.onChange(amountEvent); renderer.root.findByType('select').props.onChange(currencyEvent); renderer.root.findByType('button').props.onClick() })
    expect(amount).toHaveBeenCalledWith(amountEvent)
    expect(currency).toHaveBeenCalledWith(currencyEvent)
    expect(action).toHaveBeenCalledOnce()
    expect(renderer.root.findByType('button').props.disabled).toBe(true)
    await act(async () => renderer.unmount())
  })

  it('keeps the selected name, fallback tier number, quantity and original button styling', () => {
    const html = renderToStaticMarkup(createElement(NftCartLine, { tierId: 7, name: 'Away team', quantity: 3, onRemove: () => {}, onAdd: () => {}, addDisabled: true }))
    expect(html).toBe('<div class="flex min-w-0 items-center gap-2"><span class="text-sm text-smoke-500">+</span><span class="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded bg-white text-[10px] text-smoke-500">#7</span><span class="min-w-0 flex-1 truncate text-xs font-medium text-ink">Away team</span><div class="flex shrink-0 items-center gap-1"><button type="button" aria-label="Remove one Away team" class="flex h-6 w-6 items-center justify-center rounded-full border border-smoke-300 text-xs text-smoke-700 disabled:opacity-40">−</button><span class="min-w-4 text-center text-xs tabular-nums text-ink">3</span><button type="button" disabled="" aria-label="Add one Away team" class="flex h-6 w-6 items-center justify-center rounded-full border border-smoke-300 text-xs text-smoke-700 disabled:opacity-40">+</button></div></div>')
  })

  it('passes quantity actions unchanged and preserves cosmetic image and disabled choices', async () => {
    const remove = vi.fn(), add = vi.fn()
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => { renderer = TestRenderer.create(createElement(NftCartLine, { tierId: 2, name: 'Home team', image: '/team.svg', quantity: 1, onRemove: remove, onAdd: add, removeDisabled: true, addDisabled: false })) })
    expect(renderer.root.findByType('img').props).toMatchObject({ src: '/team.svg', alt: '', className: 'h-full w-full object-cover' })
    const [removeButton, addButton] = renderer.root.findAllByType('button')
    expect(removeButton.props.disabled).toBe(true)
    expect(addButton.props.disabled).toBe(false)
    expect(removeButton.props.onClick).toBe(remove)
    expect(addButton.props.onClick).toBe(add)
    await act(async () => addButton.props.onClick())
    expect(add).toHaveBeenCalledOnce()
    expect(remove).not.toHaveBeenCalled()
    await act(async () => renderer.unmount())
  })
})
