'use client'

import { resolveSuckers, type JBChainId, type SuckerPair } from '@bananapus/nana-sdk-core'
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { wagmiConfig } from '@/providers/Providers'
import { chainName } from '@/lib/urn'

/** A project deployment as the page lists it: [chainId, projectId]. */
export type ProjectPair = readonly [number, number]

const groups = new Map<string, Promise<readonly SuckerPair[]>>()

/**
 * The project's sucker group as the onchain registries name it. The page's
 * chain list comes from the indexer, which can be wrong; the SDK reads each
 * registry and checks that every remote sucker points back. Read once per
 * session; a failed read is tried again next time.
 */
function loadSuckerGroup(chainId: number, projectId: number): Promise<readonly SuckerPair[]> {
  const key = `${chainId}:${projectId}`
  let group = groups.get(key)
  if (!group) {
    group = resolveSuckers({ config: wagmiConfig, chainId: chainId as JBChainId, projectId: BigInt(projectId), version: 6 })
    group.catch(() => { if (groups.get(key) === group) groups.delete(key) })
    groups.set(key, group)
  }
  return group
}

/** Tests only: forget every read group. */
export function clearSuckerGroups() { groups.clear() }

const unlinkedPairLine = (chainId: number) => `The ${chainName(chainId)} project listed here isn't linked onchain.`
export const unconfirmedPairLine = (chainId: number) => `Couldn't confirm ${chainName(chainId)} belongs to this project.`

const sameDeployment = (a: ProjectPair, b: ProjectPair) => a[0] === b[0] && a[1] === b[1]
const inGroup = (group: readonly SuckerPair[], pair: ProjectPair) =>
  group.some(member => member.peerChainId === pair[0] && member.projectId === BigInt(pair[1]))

/**
 * Before a write builds calldata for another chain's deployment: the page's
 * pairing, confirmed onchain. Its message is the line the flow shows.
 */
export async function requireLinkedPairs(home: ProjectPair, pairs: readonly ProjectPair[]): Promise<void> {
  const others = pairs.filter(pair => !sameDeployment(pair, home))
  if (!others.length) return
  let group: readonly SuckerPair[]
  try {
    group = await loadSuckerGroup(home[0], home[1])
  } catch {
    throw new Error(unconfirmedPairLine(others[0][0]))
  }
  const unlinked = others.find(pair => !inGroup(group, pair))
  if (unlinked) throw new Error(unlinkedPairLine(unlinked[0]))
}

function useSuckerGroup(home: ProjectPair, enabled: boolean) {
  return useQuery({ queryKey: ['suckerGroup', home[0], home[1]], queryFn: () => loadSuckerGroup(home[0], home[1]), staleTime: Infinity, enabled })
}

/**
 * The same check for a form's chosen deployment: pending while the group is
 * read (the form's button shows its loading state), then linked or one line.
 * A multichain page starts the read on mount, so it has normally landed first.
 */
export function useLinkedPair(home: ProjectPair, pair: ProjectPair | null, multichain: boolean) {
  const own = !pair || sameDeployment(pair, home)
  const group = useSuckerGroup(home, multichain)
  if (own) return { linked: true, pending: false, line: null }
  if (group.data) return inGroup(group.data, pair) ? { linked: true, pending: false, line: null } : { linked: false, pending: false, line: unlinkedPairLine(pair[0]) }
  if (group.isError) return { linked: false, pending: false, line: unconfirmedPairLine(pair[0]) }
  return { linked: false, pending: true, line: null }
}

/**
 * For a section whose writes act on every listed deployment: only the page's
 * own deployment and the ones the onchain registry links. Others join once the
 * group is read; an unlinked or unconfirmed one stays out, with its line.
 */
type Deployment = ProjectPair | { readonly chainId: number; readonly projectId: number }
const pairOf = (item: Deployment): ProjectPair => 'chainId' in item ? [item.chainId, item.projectId] : item

export function useLinkedDeployments<T extends Deployment>(home: ProjectPair, items: readonly T[]) {
  const [homeChain, homeProject] = home
  const multichain = items.some(item => !sameDeployment(pairOf(item), home))
  const group = useSuckerGroup(home, multichain)
  const { data, isError } = group
  return useMemo(() => {
    const own: ProjectPair = [homeChain, homeProject]
    const out = items.find(item => !sameDeployment(pairOf(item), own) && (!data || !inGroup(data, pairOf(item))))
    return {
      // The caller's own list when nothing is left out, so its identity stays stable.
      deployments: (out ? items.filter(item => sameDeployment(pairOf(item), own) || (!!data && inGroup(data, pairOf(item)))) : items) as T[],
      line: !out ? null : data ? unlinkedPairLine(pairOf(out)[0]) : isError ? unconfirmedPairLine(pairOf(out)[0]) : null,
    }
  }, [items, data, isError, homeChain, homeProject])
}
