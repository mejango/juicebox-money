'use client'

import type { Shop } from '@/hooks/useShop721'
import { defifaPhaseLabel } from '@/lib/defifa-phase'
import { formatTokenAmount } from '@/lib/format'

/** SDK protocol identity proves Defifa only, without application or range assumptions. */
export function DefifaInventory({ shop }: { shop: Shop }) {
  return (
    <div className="card space-y-4 p-5">
      <span className="field-label">Defifa NFT tiers</span>
      <p className="text-sm text-smoke-600">Protocol phase: {defifaPhaseLabel(shop.phase)}</p>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead><tr className="border-b border-smoke-200 text-smoke-600">
            <th className="py-2 pr-3 font-medium">Tier</th>
            <th className="py-2 pr-4 font-medium">Name</th>
            <th className="px-2 py-2 text-right font-medium">Price</th>
            <th className="py-2 pl-4 text-right font-medium">Current supply</th>
          </tr></thead>
          <tbody>{shop.tiers.map(tier => <tr key={tier.id} className="border-b border-smoke-100">
            <td className="py-2 pr-3 tabular-nums">{tier.id}</td>
            <td className="py-2 pr-4">{tier.name ?? `Tier #${tier.id}`}</td>
            <td className="px-2 py-2 text-right tabular-nums">{formatTokenAmount(tier.price, shop.pricing.decimals)} {shop.pricing.symbol}</td>
            <td className="py-2 pl-4 text-right tabular-nums">{tier.currentSupply?.toLocaleString('en-US') ?? 'Unavailable'}</td>
          </tr>)}</tbody>
        </table>
      </div>
      {shop.tiers.length === 0 ? <p className="text-sm text-smoke-600">No NFT tiers configured.</p> : null}
    </div>
  )
}
