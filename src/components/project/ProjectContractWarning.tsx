'use client'

import type { JBChainId } from '@bananapus/nana-sdk-core'
import { useQuery } from '@tanstack/react-query'
import { ChainIcon } from '@/components/ChainIcon'
import { AddressLink } from '@/components/ui/AddressLink'
import { displayChainName } from '@/lib/chainDisplay'

/**
 * Says so when a project points at a contract this app does not recognize, or when the check
 * could not finish. Renders nothing while it runs and nothing for a project whose contracts are
 * all known.
 */
export function ProjectContractWarning({
  chains,
  isRevnet,
}: {
  chains: [number, number][]
  isRevnet: boolean
}) {
  const { data, isError } = useQuery({
    queryKey: ['project-contract-audit', chains, isRevnet],
    queryFn: async () => {
      // Loaded on demand: the check's readers stay out of the page's first load.
      const [{ auditProjectContracts }, { clientFor }] = await Promise.all([
        import('@bananapus/nana-sdk-core/review/contract-audit'),
        import('@/lib/authority'),
      ])
      return Promise.all(
        chains.map(([chainId, projectId]) =>
          auditProjectContracts(clientFor(chainId as JBChainId), {
            chainId: chainId as JBChainId,
            projectId: BigInt(projectId),
            isRevnet,
          }),
        ),
      )
    },
    staleTime: 5 * 60_000,
  })
  if (!data && !isError) return null
  const unknown = data?.flatMap(audit => audit.unknown) ?? []
  const failed = isError
    ? chains.map(([chainId]) => displayChainName(chainId))
    : data!.filter(audit => audit.failed).map(audit => displayChainName(audit.chainId))
  if (!unknown.length && !failed.length) return null

  if (!unknown.length) {
    return (
      <div role="status" className="callout callout-warning my-5 text-sm">
        <p className="font-medium">Could not verify this project’s contracts</p>
        <p className="mt-1">
          The contract check did not finish on {failed.join(', ')}. That is not evidence the
          contracts are canonical. Reload, or review them yourself, before transacting.
        </p>
      </div>
    )
  }
  return (
    <div role="status" className="callout callout-warning my-5 text-sm">
      <p className="font-medium">Unknown project contracts</p>
      <p className="mt-1">
        This project uses contracts this app does not recognize. Some data may load, but this app
        cannot verify how those contracts behave.
      </p>
      <ul className="mt-3 space-y-2">
        {unknown.map(row => (
          <li key={`${row.chainId}:${row.role}:${row.address}`}>
            <span className="inline-flex items-center gap-1.5 font-medium">
              <ChainIcon chainId={row.chainId} size={14} />
              {displayChainName(row.chainId)} | {row.role}
            </span>{' '}
            <AddressLink address={row.address} chainId={row.chainId} explorer />
            <span className="block text-xs">{row.note}</span>
          </li>
        ))}
      </ul>
      {failed.length ? (
        <p className="mt-3">
          The check also did not finish on {failed.join(', ')}, so contracts there are unverified.
        </p>
      ) : null}
    </div>
  )
}
