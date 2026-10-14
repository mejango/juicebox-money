'use client'

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

export type ShopCartItem = {
  tierId: number
  name?: string
  image?: string
}

type ShopCartContextValue = {
  quantities: Record<number, number>
  /** What the user chose, kept through automatic reconciliation: a checkout's write intent. */
  chosen: Record<number, number>
  items: Record<number, ShopCartItem>
  count: number
  quantityOf: (tierId: number) => number
  setQuantity: (
    tierId: number,
    quantity: number,
    item?: ShopCartItem,
  ) => void
  registerItem: (item: ShopCartItem) => void
  /** An automatic change (a clamp to live supply, a pruned tier): the cart follows, the user's choice stays. */
  reconcile: (tierId: number, quantity: number) => void
  clear: () => void
}

const ShopCartContext = createContext<ShopCartContextValue | null>(null)

/**
 * One cart per mounted project page. The Shop tab and pay card live in
 * separate client subtrees, so keeping the selection here makes every item
 * stepper, preview thumbnail, and checkout receipt reflect the same cart.
 */
export function ShopCartProvider({ children }: { children: ReactNode }) {
  const [quantities, setQuantities] = useState<Record<number, number>>({})
  const [chosen, setChosen] = useState<Record<number, number>>({})
  const [items, setItems] = useState<Record<number, ShopCartItem>>({})

  const registerItem = useCallback((item: ShopCartItem) => {
    setItems(current => {
      const previous = current[item.tierId]
      if (
        previous?.name === item.name &&
        previous?.image === item.image
      ) {
        return current
      }
      return {
        ...current,
        [item.tierId]: {
          tierId: item.tierId,
          name: item.name ?? previous?.name,
          image: item.image ?? previous?.image,
        },
      }
    })
  }, [])

  const reconcile = useCallback((tierId: number, rawQuantity: number) => {
    setQuantities(current => withQuantity(current, tierId, rawQuantity))
  }, [])
  const setQuantity = useCallback(
    (tierId: number, rawQuantity: number, item?: ShopCartItem) => {
      setQuantities(current => withQuantity(current, tierId, rawQuantity))
      setChosen(current => withQuantity(current, tierId, rawQuantity))
      if (item) registerItem(item)
    },
    [registerItem],
  )

  const clear = useCallback(() => {
    setQuantities({})
    setChosen({})
  }, [])
  const count = useMemo(
    () => Object.values(quantities).reduce((sum, quantity) => sum + quantity, 0),
    [quantities],
  )
  const quantityOf = useCallback(
    (tierId: number) => quantities[tierId] ?? 0,
    [quantities],
  )

  const value = useMemo<ShopCartContextValue>(
    () => ({
      quantities,
      chosen,
      items,
      count,
      quantityOf,
      setQuantity,
      registerItem,
      reconcile,
      clear,
    }),
    [quantities, chosen, items, count, quantityOf, setQuantity, registerItem, reconcile, clear],
  )

  return (
    <ShopCartContext.Provider value={value}>
      {children}
    </ShopCartContext.Provider>
  )
}

function withQuantity(current: Record<number, number>, tierId: number, rawQuantity: number): Record<number, number> {
  const quantity = Math.max(0, Math.floor(rawQuantity || 0))
  if ((current[tierId] ?? 0) === quantity) return current
  if (quantity === 0) {
    const next = { ...current }
    delete next[tierId]
    return next
  }
  return { ...current, [tierId]: quantity }
}

export function useShopCart(): ShopCartContextValue {
  const value = useContext(ShopCartContext)
  if (!value) {
    throw new Error('useShopCart must be used inside ShopCartProvider.')
  }
  return value
}
