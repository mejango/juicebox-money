import { effectiveTierPrice } from '@bananapus/nana-sdk-core/v6'

/** Subtotal in the shop's pricing units; credits and payment routes stay with callers. */
export function shopCartTotal(
  tiers: readonly { id: number; price: bigint; discountPercent: number }[],
  quantities: Readonly<Record<number, number>>,
): bigint {
  return tiers.reduce(
    (sum, tier) => sum + effectiveTierPrice(tier.price, tier.discountPercent) * BigInt(quantities[tier.id] ?? 0),
    0n,
  )
}

/**
 * Whether a cart must wait before checkout. A credit read that failed is not
 * zero credits: checkout waits for it, so credits are never left unspent.
 */
export function shopCheckoutBlocked(cart: {
  count: number
  routesLoading: boolean
  creditsLoading: boolean
  creditsFailed: boolean
  matchesToken: boolean
}): boolean {
  return cart.count > 0 && (cart.routesLoading || cart.creditsLoading || cart.creditsFailed || !cart.matchesToken)
}
