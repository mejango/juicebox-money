'use client'

import {
  JBCoreContracts,
  jbContractAddress,
  jbTokensAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import type { ReactNode } from 'react'
import { erc20Abi, zeroAddress } from 'viem'
import { useReadContract, useReadContracts } from 'wagmi'
import { ChainIcon } from '@/components/ChainIcon'
import { TokenPanelSkeleton } from '@/components/LoadingSkeletons'
import { AddressLink } from '@/components/ui/AddressLink'

/**
 * The project's own token, as a card (website/ parity: renderTokenPanel).
 * Reads JBTokens.tokenOf — bendystraw's `token` field is the ACCOUNTING
 * token, not this. Zero address = credits only, ERC-20 not deployed yet.
 */
export function TokenPanel({
  chainId,
  projectId,
  chainIds,
  compact = false,
}: {
  chainId: JBChainId
  projectId: number
  /** Every chain the project exists on (same token address everywhere). */
  chainIds: number[]
  /** Condense token metadata into one wrapping line above a larger panel. */
  compact?: boolean
}) {
  const { data: tokenAddress, isLoading } = useReadContract({
    abi: jbTokensAbi,
    address: jbContractAddress['6'][JBCoreContracts.JBTokens][chainId],
    functionName: 'tokenOf',
    args: [BigInt(projectId)],
    chainId,
    query: { staleTime: 60_000 },
  })

  const deployed = !!tokenAddress && tokenAddress !== zeroAddress

  const { data: meta } = useReadContracts({
    contracts: [
      {
        abi: erc20Abi,
        address: tokenAddress as `0x${string}`,
        functionName: 'name',
        chainId,
      },
      {
        abi: erc20Abi,
        address: tokenAddress as `0x${string}`,
        functionName: 'symbol',
        chainId,
      },
    ],
    query: { enabled: deployed, staleTime: 60_000 },
  })

  if (isLoading) {
    return <TokenPanelSkeleton compact={compact} />
  }

  // One row list for both variants; a row can align items-center instead of
  // items-baseline per variant (the full Address row centers, compact's
  // doesn't).
  const rows: {
    label: string
    centerCompact?: boolean
    centerFull?: boolean
    dd: ReactNode
  }[] = deployed
    ? [
        {
          label: 'Name',
          dd: (
            <dd className="font-medium text-ink">{meta?.[0]?.result ?? '—'}</dd>
          ),
        },
        {
          label: 'Symbol',
          dd: (
            <dd className="font-medium text-ink">
              {meta?.[1]?.result ? `$${meta[1].result}` : '—'}
            </dd>
          ),
        },
        { label: 'Type', dd: <dd className="text-ink">ERC-20</dd> },
        {
          label: 'Address',
          centerFull: true,
          dd: (
            <dd>
              <AddressLink
                address={tokenAddress!}
                chainId={chainId}
                className="text-ink"
              />
            </dd>
          ),
        },
        ...(chainIds.length > 1
          ? [
              {
                label: 'On',
                centerCompact: true,
                centerFull: true,
                dd: (
                  <dd className="flex items-center gap-1">
                    {chainIds.map(id => (
                      <ChainIcon key={id} chainId={id} size={16} standalone />
                    ))}
                  </dd>
                ),
              },
            ]
          : []),
      ]
    : []

  return (
    <div className={compact ? 'card px-5 py-4' : 'card p-5'}>
      <span className="field-label">Token</span>
      {deployed ? (
        <dl
          className={
            compact
              ? 'mt-3 flex min-w-0 flex-wrap items-center gap-x-5 gap-y-2 text-sm'
              : 'mt-2 space-y-1.5 text-sm'
          }
        >
          {rows.map(row => {
            const center = compact ? row.centerCompact : row.centerFull
            return (
              <div
                key={row.label}
                className={
                  compact
                    ? `inline-flex ${center ? 'items-center' : 'items-baseline'} gap-1.5 whitespace-nowrap`
                    : `flex ${center ? 'items-center' : 'items-baseline'} justify-between gap-3`
                }
              >
                <dt className={compact ? 'text-xs text-smoke-500' : 'text-smoke-700'}>
                  {row.label}
                </dt>
                {row.dd}
              </div>
            )
          })}
        </dl>
      ) : (
        <p className="mt-2 text-sm leading-relaxed text-smoke-700">
          No ERC-20 yet — supporters hold token credits that can claim the
          ERC-20 once it&apos;s deployed.
        </p>
      )}
    </div>
  )
}
