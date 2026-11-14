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
import { fetchSafesOwnedBy } from '@/lib/safe-service-config'
import { SAFE_SERVICE } from '@/lib/safe'
import { safeAccountQueryOptions } from '@/lib/safe-account-query'
import { PRODUCTION_CHAINS } from '@/lib/chains'

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
 * The account's Safes, and whether every chain answered. The SDK reads a failed
 * request as no Safes, so the answers are watched here. A 429 it retries counts
 * only if the last try failed; a 404 is an account the service doesn't know.
 * Testnets are left out: the indexer read that follows covers mainnets only.
 */
export async function lookUpOwnedSafes(address: string) {
  const failed = new Set<string>()
  const owned = await fetchSafesOwnedBy(
    address,
    PRODUCTION_CHAINS.map(chain => chain.id),
    {
      ...SAFE_SERVICE,
      fetch: async (input, init) => {
        const url = String(input)
        try {
          const response = await (SAFE_SERVICE.fetch ?? fetch)(input, init)
          if (response.ok || response.status === 404) failed.delete(url)
          else failed.add(url)
          return response
        } catch (error) {
          failed.add(url)
          throw error
        }
      },
    },
  )
  return { owned, complete: failed.size === 0 }
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
  const [incomplete, setIncomplete] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const queryClient = useQueryClient()

  useEffect(() => {
    let stopped = false
    // Leaving the account stops its indexed read.
    const left = new AbortController()
    ;(async () => {
      try {
        // Chains without Safe's transaction service contribute nothing.
        const { owned, complete } = await lookUpOwnedSafes(address)
        if (!stopped) setIncomplete(!complete)
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
        if (!stopped) {
          setIncomplete(true)
          setRows([])
        }
      }
    })()
    return () => {
      stopped = true
      left.abort()
    }
    // ownedKeys is derived server-side per address; address identifies it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, attempt])

  if (rows === null) {
    return ownedCount === 0 ? (
      <p className="col-span-full text-sm text-smoke-500">
        Checking Safe ownership…
      </p>
    ) : null
  }
  const unfinished = incomplete ? (
    <p className="col-span-full text-sm text-smoke-600">
      Couldn&apos;t finish checking this account&apos;s Safes.{' '}
      <button
        type="button"
        className="font-medium text-bluebs-600 underline underline-offset-2 hover:text-bluebs-700"
        onClick={() => {
          setRows(null)
          setIncomplete(false)
          setAttempt(current => current + 1)
        }}
      >
        Try again
      </button>
    </p>
  ) : null
  if (rows.length === 0) {
    if (unfinished) return unfinished
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
      {unfinished}
    </>
  )
}
