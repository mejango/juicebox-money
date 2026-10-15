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
  items: Record<number, ShopCartItem>
  count: number
  quantityOf: (tierId: number) => number
  setQuantity: (
    tierId: number,
    quantity: number,
    item?: ShopCartItem,
  ) => void
  registerItem: (item: ShopCartItem) => void
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

  const setQuantity = useCallback(
    (tierId: number, rawQuantity: number, item?: ShopCartItem) => {
      const quantity = Math.max(0, Math.floor(rawQuantity || 0))
      setQuantities(current => {
        if ((current[tierId] ?? 0) === quantity) return current
        if (quantity === 0) {
          const next = { ...current }
          delete next[tierId]
          return next
        }
        return { ...current, [tierId]: quantity }
      })
      if (item) registerItem(item)
    },
    [registerItem],
  )

  const clear = useCallback(() => setQuantities({}), [])
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
      items,
      count,
      quantityOf,
      setQuantity,
      registerItem,
      clear,
    }),
    [quantities, items, count, quantityOf, setQuantity, registerItem, clear],
  )

  return (
    <ShopCartContext.Provider value={value}>
      {children}
    </ShopCartContext.Provider>
  )
}

export function useShopCart(): ShopCartContextValue {
  const value = useContext(ShopCartContext)
  if (!value) {
    throw new Error('useShopCart must be used inside ShopCartProvider.')
  }
  return value
}
