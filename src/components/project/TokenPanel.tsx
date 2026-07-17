'use client'

import {
  JBCoreContracts,
  jbContractAddress,
  jbTokensAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import { erc20Abi, zeroAddress } from 'viem'
import { useReadContract, useReadContracts } from 'wagmi'
import { ChainIcon } from '@/components/ChainIcon'
import { truncateAddress } from '@/lib/format'

/**
 * The project's own token, as a card (website/ parity: renderTokenPanel).
 * Reads JBTokens.tokenOf — bendystraw's `token` field is the ACCOUNTING
 * token, not this. Zero address = credits only, ERC-20 not deployed yet.
 */
export function TokenPanel({
  chainId,
  projectId,
  chainIds,
  etherscanHost,
}: {
  chainId: JBChainId
  projectId: number
  /** Every chain the project exists on (same token address everywhere). */
  chainIds: number[]
  etherscanHost?: string
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
    return (
      <div className="card p-5">
        <span className="field-label">Token</span>
        <p className="mt-2 text-sm text-smoke-500">Loading…</p>
      </div>
    )
  }

  return (
    <div className="card p-5">
      <span className="field-label">Token</span>
      {deployed ? (
        <dl className="mt-2 space-y-1.5 text-sm">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-smoke-700">Name</dt>
            <dd className="font-medium text-ink">
              {meta?.[0]?.result ?? '—'}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-smoke-700">Symbol</dt>
            <dd className="font-medium text-ink">
              {meta?.[1]?.result ? `$${meta[1].result}` : '—'}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-smoke-700">Type</dt>
            <dd className="text-ink">ERC-20</dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-smoke-700">Address</dt>
            <dd>
              {etherscanHost ? (
                <a
                  href={`https://${etherscanHost}/address/${tokenAddress}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-ink hover:underline"
                >
                  {truncateAddress(tokenAddress!)}
                </a>
              ) : (
                <span className="text-ink">
                  {truncateAddress(tokenAddress!)}
                </span>
              )}
            </dd>
          </div>
          {chainIds.length > 1 ? (
            <div className="flex items-center justify-between gap-3">
              <dt className="text-smoke-700">On</dt>
              <dd className="flex items-center gap-1">
                {chainIds.map(id => (
                  <ChainIcon key={id} chainId={id} size={16} />
                ))}
              </dd>
            </div>
          ) : null}
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
