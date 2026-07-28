'use client'

import type { JBChainId } from '@bananapus/nana-sdk-core'
import { useEffect, useState } from 'react'
import type { Address } from 'viem'
import {
  AccountProjectCard,
  projectKey,
  type SafeOwnership,
} from '@/components/account/AccountProjectCard'
import { getProjectsOwnedBy, type BsProject } from '@/lib/bendystraw'
import { fetchSafeInfo, hasSafeService, safesForOwner } from '@/lib/safe'
import { SUPPORTED_CHAINS } from '@/providers/Providers'

export type SafeOwnedProject = { project: BsProject; viaSafe: SafeOwnership }

/**
 * Map projects owned by the account's Safes into cards, dropping deployments
 * the account already owns directly (`ownedKeys`) and duplicates.
 */
export function dedupeSafeProjects(
  projects: BsProject[],
  safes: string[],
  ownedKeys: string[],
): { project: BsProject; safe: string }[] {
  const safeSet = new Set(safes.map(safe => safe.toLowerCase()))
  const seen = new Set(ownedKeys)
  return projects.flatMap(project => {
    const owner = project.owner?.toLowerCase()
    const key = projectKey(project)
    if (!owner || !safeSet.has(owner) || seen.has(key)) return []
    seen.add(key)
    return [{ project, safe: project.owner! }]
  })
}

/**
 * The Safe-owned layer of the owned-projects grid. This runs client-side:
 * the Safe Transaction Service helpers (and their localStorage overrides)
 * live in the client-only safe module.
 */
export function AccountSafeProjects({
  address,
  ownedKeys,
  ownedCount,
}: {
  address: string
  ownedKeys: string[]
  ownedCount: number
}) {
  const [rows, setRows] = useState<SafeOwnedProject[] | null>(null)

  useEffect(() => {
    let stopped = false
    ;(async () => {
      try {
        const chainIds = SUPPORTED_CHAINS.map(chain => chain.id).filter(
          chainId => hasSafeService(chainId),
        )
        const perChain = await Promise.all(
          chainIds.map(chainId =>
            safesForOwner(address as Address, chainId).then(safes =>
              safes.map(safe => ({ chainId, safe })),
            ),
          ),
        )
        const safes = [
          ...new Set(perChain.flat().map(entry => entry.safe)),
        ]
        if (!safes.length) {
          if (!stopped) setRows([])
          return
        }
        const projects = await getProjectsOwnedBy(safes)
        const deduped = dedupeSafeProjects(projects, safes, ownedKeys)
        const withThresholds = await Promise.all(
          deduped.map(async ({ project, safe }) => {
            const info = await fetchSafeInfo(
              project.chainId as JBChainId,
              safe as Address,
            )
            return {
              project,
              viaSafe: {
                safe,
                threshold: info?.threshold ?? null,
                ownerCount: info?.owners.length ?? null,
              },
            }
          }),
        )
        if (!stopped) setRows(withThresholds)
      } catch {
        if (!stopped) setRows([])
      }
    })()
    return () => {
      stopped = true
    }
    // ownedKeys is derived server-side per address; address identifies it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address])

  if (rows === null) {
    return ownedCount === 0 ? (
      <p className="col-span-full text-sm text-smoke-500">
        Checking Safe ownership…
      </p>
    ) : null
  }
  if (rows.length === 0) {
    return ownedCount === 0 ? (
      <p className="col-span-full text-sm text-smoke-600">
        This account does not own any projects yet.
      </p>
    ) : null
  }
  return (
    <>
      {rows.map(({ project, viaSafe }) => (
        <AccountProjectCard
          key={projectKey(project)}
          project={project}
          viaSafe={viaSafe}
        />
      ))}
    </>
  )
}
