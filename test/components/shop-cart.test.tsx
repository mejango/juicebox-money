// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { ShopCartProvider, useShopCart } from '@/components/project/ShopCartProvider'

describe('the shop cart', () => {
  it("keeps the user's choice through an automatic clamp, so a checkout retry carries the same intent", async () => {
    let cart!: ReturnType<typeof useShopCart>
    function Probe() {
      cart = useShopCart()
      return null
    }
    const root = createRoot(document.createElement('div'))
    await act(async () => root.render(<ShopCartProvider><Probe /></ShopCartProvider>))
    await act(async () => cart.setQuantity(1, 3))
    // Live supply dropped (the first attempt may have minted): the cart follows it, the choice stays.
    await act(async () => cart.reconcile(1, 2))
    expect(cart.quantities).toEqual({ 1: 2 })
    expect(cart.chosen).toEqual({ 1: 3 })
    // The user choosing again is a new choice.
    await act(async () => cart.setQuantity(1, 1))
    expect(cart.chosen).toEqual({ 1: 1 })
    await act(async () => root.unmount())
  })
})
