'use client'

import {
  JBCoreContracts,
  jbV6ContractAddress,
  jbTokensAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { erc20Abi, zeroAddress } from 'viem'
import { usePublicClient, useReadContract, useReadContracts } from 'wagmi'
import { currentRulesetQuery } from '@/lib/project-display-queries'
import { chainName } from '@/lib/urn'
import { ChainIcon } from '@/components/ChainIcon'
import { TokenPanelSkeleton } from '@/components/LoadingSkeletons'
import { AddressLink } from '@/components/ui/AddressLink'
import { ConceptTerm } from '@/components/project/ConceptTerm'

/**
 * The project's own token, as a card (website/ parity: renderTokenPanel).
 * Reads JBTokens.tokenOf — bendystraw's `token` field is the ACCOUNTING
 * token, not this. Zero address means no ERC-20; rules and total supply
 * establish whether credits are being issued or already exist.
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
    address: jbV6ContractAddress[JBCoreContracts.JBTokens][chainId],
    functionName: 'tokenOf',
    args: [BigInt(projectId)],
    chainId,
    query: { staleTime: 60_000 },
  })

  const deployed = !!tokenAddress && tokenAddress !== zeroAddress
  const creditsOnly = tokenAddress === zeroAddress
  const publicClient = usePublicClient({ chainId })
  const ruleset = useQuery({
    ...currentRulesetQuery(publicClient!, { chainId, projectId: BigInt(projectId) }),
    enabled: creditsOnly && !!publicClient,
  })
  const { data: totalSupply, isLoading: supplyLoading, isSuccess: supplyKnown } = useReadContract({
    abi: jbTokensAbi,
    address: jbV6ContractAddress[JBCoreContracts.JBTokens][chainId],
    functionName: 'totalSupplyOf',
    args: [BigInt(projectId)],
    chainId,
    query: { enabled: creditsOnly, staleTime: 60_000 },
  })

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

  if (isLoading || (creditsOnly && (supplyLoading || (!!publicClient && ruleset.isPending)))) {
    return <TokenPanelSkeleton compact={compact} />
  }

  const creditEvidence = creditsOnly && supplyKnown && ruleset.isSuccess
  const noIssuance = ruleset.data?.ruleset.weight === 0n
  const creditDescription = !creditEvidence
    ? 'Token and credit information is temporarily unavailable.'
    : noIssuance
      ? totalSupply === 0n
        ? `This project does not currently offer tokens or credits for payments on ${chainName(chainId)}. No tokens or credits are in circulation on this chain.`
        : `Payments on ${chainName(chainId)} do not currently issue new credits. Existing credit balances are still recorded within Juicebox.`
      : 'Payments can issue credits recorded within Juicebox. If the project creates a wallet token (ERC-20), holders can claim it in exchange for those credits.'

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
        {
          label: 'Type',
          dd: (
            <dd className="text-ink">
              <ConceptTerm note="A token format that wallets and trading apps can recognize.">
                ERC-20
              </ConceptTerm>
            </dd>
          ),
        },
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
          {creditDescription}
        </p>
      )}
    </div>
  )
}
