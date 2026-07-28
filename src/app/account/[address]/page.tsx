import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { cache } from 'react'
import { getAddress, isAddress } from 'viem'
import { AccountActivity } from '@/components/account/AccountActivity'
import { AccountHeader } from '@/components/account/AccountHeader'
import {
  AccountShopHoldings,
  AccountTokenHoldings,
  groupNftHoldings,
  groupTokenHoldings,
  nftHoldingIdentity,
  tokenHoldingIdentity,
} from '@/components/account/AccountHoldings'
import {
  AccountOperatedProjects,
  groupOperatorGrants,
} from '@/components/account/AccountOperatedProjects'
import { AccountPendingRelayr } from '@/components/account/AccountPendingRelayr'
import {
  AccountProjectCard,
  projectKey,
} from '@/components/account/AccountProjectCard'
import { AccountSafeProjects } from '@/components/account/AccountSafeProjects'
import { AccountTabs } from '@/components/account/AccountTabs'
import {
  dedupeVersionedRows,
  getAccountActivity,
  getAccountNfts,
  getAccountTokenHoldings,
  getOperatorGrants,
  getProjectsByRefs,
  getProjectsOwnedBy,
  type BsAccountActivityEvent,
  type BsAccountNft,
  type BsAccountTokenHolding,
  type BsOperatorGrant,
  type BsProject,
} from '@/lib/bendystraw'
import { looksLikeEns, lookupEnsAddress } from '@/lib/ens'
import { truncateAddress } from '@/lib/format'

// Bendystraw calls are POSTs, which Next's fetch cache doesn't dedupe —
// memoize per request so generateMetadata + page share one round trip.
const resolveAccount = cache(async (param: string) => {
  const input = decodeURIComponent(param).trim()
  if (isAddress(input)) {
    return { address: getAddress(input), ensName: null }
  }
  if (looksLikeEns(input)) {
    // Server-side ENS → address via viem's getEnsAddress (mainnet client).
    const resolved = await lookupEnsAddress(input)
    if (resolved) {
      return { address: getAddress(resolved), ensName: input.toLowerCase() }
    }
  }
  return null
})
const getFirstActivityPage = cache((address: string) =>
  getAccountActivity(address, { limit: 25 }),
)
const getOwnedProjects = cache((address: string) =>
  getProjectsOwnedBy([address]),
)
const getGrants = cache(getOperatorGrants)
const getTokenHoldings = cache(getAccountTokenHoldings)
const getNftHoldings = cache(getAccountNfts)

/** Resolve display projects for holding rows, one lookup per section. */
const getHoldingProjects = cache(
  (refs: { chainId: number; projectId: number; version: number }[]) =>
    refs.length
      ? getProjectsByRefs(refs).catch(() => [] as BsProject[])
      : Promise.resolve([] as BsProject[]),
)

export async function generateMetadata({
  params,
}: {
  params: Promise<{ address: string }>
}): Promise<Metadata> {
  const resolved = await resolveAccount((await params).address)
  if (!resolved) notFound()
  const label = resolved.ensName ?? truncateAddress(resolved.address)
  return {
    title: `${label} — Account`,
    description: `Activity, holdings, owned projects, and operator permissions for ${label} on Juicebox.`,
  }
}

export default async function AccountPage({
  params,
}: {
  params: Promise<{ address: string }>
}) {
  const resolved = await resolveAccount((await params).address)
  if (!resolved) notFound()
  const { address, ensName } = resolved

  const [activity, owned, grants, tokenHoldings, nftHoldings] =
    await Promise.all([
      getFirstActivityPage(address).catch(() => ({
        items: [] as BsAccountActivityEvent[],
        totalCount: 0,
      })),
      getOwnedProjects(address).catch(() => [] as BsProject[]),
      getGrants(address).catch(() => [] as BsOperatorGrant[]),
      getTokenHoldings(address).catch(() => [] as BsAccountTokenHolding[]),
      getNftHoldings(address).catch(() => [] as BsAccountNft[]),
    ])
  const [grantProjects, tokenProjects, nftProjects] = await Promise.all([
    grants.length
      ? getProjectsByRefs(
          grants.map(grant => ({
            chainId: grant.chainId,
            projectId: grant.projectId,
            version: grant.version,
          })),
        ).catch(() => [] as BsProject[])
      : ([] as BsProject[]),
    getHoldingProjects(
      dedupeVersionedRows(tokenHoldings, tokenHoldingIdentity),
    ),
    getHoldingProjects(dedupeVersionedRows(nftHoldings, nftHoldingIdentity)),
  ])
  const operated = groupOperatorGrants(grants, grantProjects)
  const tokenGroups = groupTokenHoldings(tokenHoldings, tokenProjects)
  const itemGroups = groupNftHoldings(nftHoldings, nftProjects)
  const ownedKeys = owned.map(projectKey)

  return (
    <div className="mx-auto max-w-6xl px-6 py-8 sm:py-12">
      <AccountHeader address={address} ensName={ensName} />

      <div className="mt-10">
        <AccountTabs
          tabs={[
            {
              label: 'Activity',
              content: (
                <section>
                  <AccountPendingRelayr address={address} />
                  <AccountActivity
                    address={address}
                    initialEvents={activity.items}
                    totalCount={activity.totalCount}
                  />
                </section>
              ),
            },
            {
              label: 'Holdings',
              content: (
                <section className="space-y-8">
                  <div>
                    <h2 className="mb-3 font-agrandir text-lg font-medium">
                      Tokens
                    </h2>
                    <AccountTokenHoldings groups={tokenGroups} />
                  </div>
                  <div>
                    <h2 className="mb-3 font-agrandir text-lg font-medium">
                      Store items
                    </h2>
                    <AccountShopHoldings groups={itemGroups} />
                  </div>
                </section>
              ),
            },
            {
              label: 'Projects',
              content: (
                <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {owned.map(project => (
                    <AccountProjectCard
                      key={projectKey(project)}
                      project={project}
                    />
                  ))}
                  <AccountSafeProjects
                    address={address}
                    ownedKeys={ownedKeys}
                    ownedCount={owned.length}
                  />
                </section>
              ),
            },
            {
              label: 'Roles',
              content: (
                <section>
                  <AccountOperatedProjects groups={operated} />
                </section>
              ),
            },
          ]}
        />
      </div>
    </div>
  )
}
