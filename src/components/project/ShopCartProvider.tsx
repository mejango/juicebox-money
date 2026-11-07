'use client'

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react'

export type ShopCartItem = {
  tierId: number
  name?: string
  image?: string
}

type ChainCart = {
  quantities: Record<number, number>
  items: Record<number, ShopCartItem>
}

type ShopCartContextValue = ChainCart & {
  count: number
  /** Items waiting in each chain's cart, this one's included. */
  countsByChain: Record<number, number>
  quantityOf: (tierId: number) => number
  setQuantity: (
    tierId: number,
    quantity: number,
    item?: ShopCartItem,
  ) => void
  registerItem: (item: ShopCartItem) => void
  clear: () => void
}

const EMPTY_CART: ChainCart = { quantities: {}, items: {} }

const ShopCartContext = createContext<{
  chainId: number
  carts: Record<number, ChainCart>
  setCarts: Dispatch<SetStateAction<Record<number, ChainCart>>>
} | null>(null)

const itemCount = (cart: ChainCart) =>
  Object.values(cart.quantities).reduce((sum, quantity) => sum + quantity, 0)

/**
 * One cart per chain of the mounted project page. Tier IDs belong to each chain's own 721 hook,
 * so an item never moves to another chain's cart. The Shop tab and pay card live in separate
 * client subtrees, so keeping the selection here makes every item stepper, preview thumbnail,
 * and checkout receipt reflect the same cart.
 */
export function ShopCartProvider({ chainId, children }: { chainId: number; children: ReactNode }) {
  const [carts, setCarts] = useState<Record<number, ChainCart>>({})
  const value = useMemo(() => ({ chainId, carts, setCarts }), [chainId, carts])

  return (
    <ShopCartContext.Provider value={value}>
      {children}
    </ShopCartContext.Provider>
  )
}

/** The cart of `chainId`, or of the page's chain. */
export function useShopCart(chainId?: number): ShopCartContextValue {
  const context = useContext(ShopCartContext)
  if (!context) {
    throw new Error('useShopCart must be used inside ShopCartProvider.')
  }
  const { carts, setCarts } = context
  const cartChainId = chainId ?? context.chainId
  const { quantities, items } = carts[cartChainId] ?? EMPTY_CART

  const update = useCallback(
    (next: (cart: ChainCart) => ChainCart) =>
      setCarts(current => {
        const cart = current[cartChainId] ?? EMPTY_CART
        const updated = next(cart)
        return updated === cart ? current : { ...current, [cartChainId]: updated }
      }),
    [cartChainId, setCarts],
  )

  const registerItem = useCallback((item: ShopCartItem) => {
    update(cart => {
      const previous = cart.items[item.tierId]
      if (
        previous &&
        (item.name ?? previous.name) === previous.name &&
        (item.image ?? previous.image) === previous.image
      ) {
        return cart
      }
      return {
        ...cart,
        items: {
          ...cart.items,
          [item.tierId]: {
            tierId: item.tierId,
            name: item.name ?? previous?.name,
            image: item.image ?? previous?.image,
          },
        },
      }
    })
  }, [update])

  const setQuantity = useCallback(
    (tierId: number, rawQuantity: number, item?: ShopCartItem) => {
      const quantity = Math.max(0, Math.floor(rawQuantity || 0))
      update(cart => {
        if ((cart.quantities[tierId] ?? 0) === quantity) return cart
        if (quantity === 0) {
          const next = { ...cart.quantities }
          delete next[tierId]
          return { ...cart, quantities: next }
        }
        return { ...cart, quantities: { ...cart.quantities, [tierId]: quantity } }
      })
      if (item) registerItem(item)
    },
    [registerItem, update],
  )

  const clear = useCallback(() => update(cart => ({ ...cart, quantities: {} })), [update])
  const count = useMemo(() => itemCount({ quantities, items }), [quantities, items])
  const countsByChain = useMemo(
    () => Object.fromEntries(Object.entries(carts).map(([id, cart]) => [id, itemCount(cart)])),
    [carts],
  )
  const quantityOf = useCallback(
    (tierId: number) => quantities[tierId] ?? 0,
    [quantities],
  )

  return useMemo<ShopCartContextValue>(
    () => ({
      quantities,
      items,
      count,
      countsByChain,
      quantityOf,
      setQuantity,
      registerItem,
      clear,
    }),
    [quantities, items, count, countsByChain, quantityOf, setQuantity, registerItem, clear],
  )
}

function subscribeToHash(onChange: () => void) {
  window.addEventListener('hashchange', onChange)
  return () => window.removeEventListener('hashchange', onChange)
}

/** The Shop tab has the grid, so the pay card leaves out its preview of the same items. */
export function useShopTabOpen() {
  return useSyncExternalStore(
    subscribeToHash,
    () => window.location.hash.replace('#', '').split('/')[0] === 'shop',
    () => false,
  )
}
