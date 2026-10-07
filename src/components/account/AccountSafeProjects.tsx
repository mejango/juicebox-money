'use client'

import type { JBChainId } from '@bananapus/nana-sdk-core'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import type { Address } from 'viem'
import {
  AccountProjectCard,
  projectKey,
  type SafeOwnership,
} from '@/components/account/AccountProjectCard'
import { getProjectsOwnedBy, type BsProject } from '@/lib/bendystraw'
import { fetchSafesOwnedBy } from '@bananapus/nana-sdk-core/safe-service'
import { SAFE_SERVICE } from '@/lib/safe'
import { safeAccountQueryOptions } from '@/lib/safe-account-query'
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
  const queryClient = useQueryClient()

  useEffect(() => {
    let stopped = false
    // Leaving the account stops its indexed read.
    const left = new AbortController()
    ;(async () => {
      try {
        // Chains without Safe's transaction service contribute nothing.
        const owned = await fetchSafesOwnedBy(
          address,
          SUPPORTED_CHAINS.map(chain => chain.id),
          SAFE_SERVICE,
        )
        const safes = [...new Set(owned.map(entry => entry.safe))]
        if (!safes.length) {
          if (!stopped) setRows([])
          return
        }
        const projects = await getProjectsOwnedBy(safes, { signal: left.signal })
        const deduped = dedupeSafeProjects(projects, safes, ownedKeys)
        const withThresholds = await Promise.all(
          deduped.map(async ({ project, safe }) => {
            const info = await queryClient.fetchQuery(safeAccountQueryOptions(
              project.chainId as JBChainId, safe as Address,
            )).then(account => account.safe, () => null)
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
      left.abort()
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
