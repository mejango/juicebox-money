'use client'

import { formatUnits } from 'viem'

import {
  useParaAuth,
  type ParaOnRampAsset,
  type ParaOnRampNetwork,
} from '@/providers/ParaAuthContext'

/** Only the chains Para's on-ramp can actually deliver to. The other testnets
 *  we support have no on-ramp, so the affordance hides itself there. */
const NETWORKS: Record<number, ParaOnRampNetwork> = {
  1: 'ETHEREUM',
  10: 'OPTIMISM',
  8453: 'BASE',
  42161: 'ARBITRUM',
  11155111: 'SEPOLIA',
}

/** Wrapped and bridged variants are deliberately absent — an on-ramp that
 *  delivers plain ETH when the form wants WETH is worse than no link. */
const ASSETS: Record<string, ParaOnRampAsset> = {
  ETH: 'ETHEREUM',
  USDC: 'USDC',
}

/**
 * "Get ETH" / "Get USDC" — opens Para's on-ramp for the token and chain the
 * caller is actually transacting in. Renders nothing when that pair has no
 * on-ramp route.
 */
/** Trimmed so the amount we hand the provider reads like money rather than
 *  like wei. Six places is finer than any on-ramp minimum. */
function wholeUnits(amount: bigint, decimals: number): string {
  const text = formatUnits(amount, decimals)
  if (!text.includes('.')) return text
  const [whole, fraction] = text.split('.')
  const trimmed = fraction.slice(0, 6).replace(/0+$/, '')
  return trimmed ? `${whole}.${trimmed}` : whole
}

export function GetFunds({
  symbol,
  chainId,
  needed,
  balance,
  decimals,
  onNavigate,
  className = 'text-xs text-smoke-700 underline underline-offset-2 hover:text-ink',
}: {
  symbol: string
  chainId: number | undefined
  /** What the pending payment costs, if there is one. */
  needed?: bigint
  /** What the payer holds now. */
  balance?: bigint
  decimals?: number
  /** Lets a containing menu dismiss itself as the on-ramp takes over. */
  onNavigate?: () => void
  className?: string
}) {
  const { requestAddFunds } = useParaAuth()
  const asset = ASSETS[symbol?.toUpperCase() ?? '']
  const network = chainId ? NETWORKS[chainId] : undefined
  if (!asset || !network) return null

  // Buy the difference, not the whole payment: the payer's existing balance
  // already covers part of it, and asking them to work that out at a payment
  // wall is how a payment gets abandoned.
  const missing =
    needed !== undefined && balance !== undefined && needed > balance
      ? needed - balance
      : undefined
  // A shortfall under our display precision has no sensible amount to show —
  // "Get 0 more ETH" is worse copy than no amount at all.
  const shortfall =
    missing !== undefined && decimals !== undefined
      ? (wholeUnits(missing, decimals) === '0' ? undefined : wholeUnits(missing, decimals))
      : undefined

  return (
    <button
      type="button"
      onClick={() => {
        onNavigate?.()
        requestAddFunds({
          asset,
          network,
          assetQuantity: shortfall,
        })
      }}
      className={className}
    >
      {shortfall ? `Get ${shortfall} more ${symbol}` : `Get ${symbol}`}
    </button>
  )
}
