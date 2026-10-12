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
