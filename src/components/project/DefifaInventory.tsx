import type { JBChainId } from '@bananapus/nana-sdk-core'
import type { Shop } from '@/hooks/useShop721'
import { formatTokenAmount } from '@/lib/format'

/** Native inventory is display-only here; entries and settlement use Metalog. */
export function DefifaInventory({ chainId, projectId, shop }: {
  chainId: JBChainId
  projectId: number
  shop: Shop
}) {
  return (
    <div className="card space-y-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="field-label">Market positions</span>
        <a className="text-sm text-bluebs-600 underline underline-offset-4" href={`https://metalog.money/markets/${chainId}/${projectId}`}>
          Open in Metalog →
        </a>
      </div>
      <p className="text-sm text-smoke-700">Entries, transfers and settlement are managed in Metalog.</p>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead><tr className="border-b border-smoke-200 text-smoke-600">
            <th className="py-2 pr-4 font-medium">Range</th>
            <th className="px-2 py-2 text-right font-medium">Entry price</th>
            <th className="py-2 pl-4 text-right font-medium">NFTs</th>
          </tr></thead>
          <tbody>{shop.tiers.map(tier => <tr key={tier.id} className="border-b border-smoke-100">
            <td className="py-2 pr-4">{tier.name ?? `Range #${tier.id}`}</td>
            <td className="px-2 py-2 text-right tabular-nums">{formatTokenAmount(tier.price, shop.pricing.decimals)} {shop.pricing.symbol}</td>
            <td className="py-2 pl-4 text-right tabular-nums">{tier.currentSupply?.toLocaleString('en-US') ?? 'Unavailable'}</td>
          </tr>)}</tbody>
        </table>
      </div>
      {shop.tiers.length === 0 ? <p className="text-sm text-smoke-600">No ranges configured.</p> : null}
    </div>
  )
}
