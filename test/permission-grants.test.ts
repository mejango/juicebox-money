import { describe, expect, it } from 'vitest'

import {
  aggregateGrants,
  permissionIdsOnChain,
} from '@/components/project/AuthorityOverview'

// The Permissions card has to answer "which accounts hold which permissions, where" honestly. Three
// things the raw indexed rows don't say: whether the grantor is still the owner, that the granted set
// is PER CHAIN, and that a wildcard (projectId 0) grant is a different grant with a wider blast radius.
const OWNER = '0x1111111111111111111111111111111111111111'
const FORMER = '0x9999999999999999999999999999999999999999'
const OP = '0x3333333333333333333333333333333333333333'

const DEPLOYMENTS = [
  { chainId: 8453, projectId: 5, indexedAuthority: null },
  { chainId: 1, projectId: 5, indexedAuthority: null },
] as never[]

const authorityRows = (base = OWNER) =>
  [
    { chainId: 8453, projectId: 5, authority: base },
    { chainId: 1, projectId: 5, authority: base },
  ] as never[]

const holder = (
  account: string,
  permissions: number[],
  chainId = 8453,
  extra: Record<string, unknown> = {},
) => ({
  chainId,
  account,
  operator: OP,
  permissions,
  isRevnetOperator: false,
  ...extra,
})

describe('aggregateGrants', () => {
  it('flags a grant whose grantor is no longer the project authority', () => {
    const [dead] = aggregateGrants(
      [holder(FORMER, [24, 26])] as never[],
      DEPLOYMENTS,
      authorityRows(),
    )
    expect(dead.live).toBe(false)

    const [alive] = aggregateGrants(
      [holder(OWNER, [24, 26])] as never[],
      DEPLOYMENTS,
      authorityRows(),
    )
    expect(alive.live).toBe(true)
  })

  it('stays live when any chain still carries the current authority’s grant', () => {
    const [grant] = aggregateGrants(
      [holder(FORMER, [24]), holder(OWNER, [24], 1)] as never[],
      DEPLOYMENTS,
      authorityRows(),
    )
    expect(grant.live).toBe(true)
  })

  // The union alone claims powers the operator may hold on exactly one chain.
  it('keeps the granted set per chain so an edit cannot silently widen it', () => {
    const [grant] = aggregateGrants(
      [holder(OWNER, [24, 26]), holder(OWNER, [24], 1)] as never[],
      DEPLOYMENTS,
      authorityRows(),
    )
    expect(grant.union).toEqual([24, 26])
    expect(permissionIdsOnChain(grant, 8453)).toEqual([24, 26])
    expect(permissionIdsOnChain(grant, 1)).toEqual([24])
    expect(permissionIdsOnChain(grant, 10)).toEqual([])
    expect(grant.differs).toBe(true)
  })

  it('is uniform only when every deployed chain carries the same set', () => {
    const [uniform] = aggregateGrants(
      [holder(OWNER, [24, 26]), holder(OWNER, [26, 24], 1)] as never[],
      DEPLOYMENTS,
      authorityRows(),
    )
    expect(uniform.differs).toBe(false)

    // Granted on Base but the project also lives on mainnet — not uniform.
    const [partial] = aggregateGrants(
      [holder(OWNER, [24, 26])] as never[],
      DEPLOYMENTS,
      authorityRows(),
    )
    expect(partial.differs).toBe(true)
  })

  // A wildcard grant reaches every project the owner holds, so it can't be folded into the project row.
  it('keeps wildcard grants separate from project-scoped ones for the same operator', () => {
    const grants = aggregateGrants(
      [
        holder(OWNER, [24]),
        holder(OWNER, [1], 8453, { wildcard: true }),
      ] as never[],
      DEPLOYMENTS,
      authorityRows(),
    )
    expect(grants).toHaveLength(2)
    expect(grants.find(grant => grant.wildcard)?.union).toEqual([1])
    expect(grants.find(grant => !grant.wildcard)?.union).toEqual([24])
  })
})
