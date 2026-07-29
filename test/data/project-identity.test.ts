import { describe, expect, it } from 'vitest'
import {
  projectGroupPaymentsCount,
  resolveProjectDeployments,
  type BsProject,
} from '@/lib/bendystraw'
import { chainName, parseUrn, toUrn } from '@/lib/urn'

function project(overrides: Partial<BsProject> = {}): BsProject {
  return {
    projectId: 7,
    chainId: 1,
    version: 6,
    name: 'Home',
    logoUri: null,
    projectTagline: null,
    volume: '0',
    volumeUsd: '0',
    balance: '0',
    paymentsCount: 0,
    contributorsCount: 0,
    createdAt: 1,
    suckerGroupId: 'group-a',
    token: null,
    tokenSymbol: null,
    decimals: null,
    currency: null,
    isRevnet: false,
    owner: null,
    metadataUri: null,
    ...overrides,
  }
}

describe('Bendystraw project identity is treated as untrusted input', () => {
  it('retains verified per-chain project IDs instead of copying the home ID', () => {
    const home = project()
    const deployments = resolveProjectDeployments(home, [
      home,
      project({ chainId: 10, projectId: 12, name: 'Optimism' }),
      project({ chainId: 8453, projectId: 99, name: 'Base' }),
    ])

    expect(deployments.map(row => [row.chainId, row.projectId])).toEqual([
      [1, 7],
      [10, 12],
      [8453, 99],
    ])
  })

  it('fails closed to home-only when the route chain reports another project', () => {
    const home = project()
    const deployments = resolveProjectDeployments(home, [
      project({ chainId: 1, projectId: 8 }),
      project({ chainId: 10, projectId: 12 }),
    ])

    expect(deployments).toEqual([home])
  })

  it('omits an ambiguous remote chain while retaining unambiguous peers', () => {
    const home = project()
    const deployments = resolveProjectDeployments(home, [
      project({ chainId: 10, projectId: 12 }),
      project({ chainId: 10, projectId: 13 }),
      project({ chainId: 8453, projectId: 22 }),
    ])

    expect(deployments.map(row => [row.chainId, row.projectId])).toEqual([
      [1, 7],
      [8453, 22],
    ])
  })

  it('drops wrong-group, wrong-version, and invalid numeric identities', () => {
    const home = project()
    const deployments = resolveProjectDeployments(home, [
      project({ chainId: 10, projectId: 12, suckerGroupId: 'group-b' }),
      project({ chainId: 8453, projectId: 13, version: 5 }),
      project({ chainId: 42161, projectId: Number.NaN }),
      project({ chainId: 0, projectId: 14 }),
    ])

    expect(deployments).toEqual([home])
  })

  it('never links a project that has no sucker group', () => {
    const home = project({ suckerGroupId: null })
    expect(
      resolveProjectDeployments(home, [project({ chainId: 10, projectId: 12 })]),
    ).toEqual([home])
  })
})

describe('cross-chain payment totals', () => {
  it('adds payments across the verified deployment set', () => {
    expect(
      projectGroupPaymentsCount([
        project({ chainId: 1, paymentsCount: 7 }),
        project({ chainId: 10, projectId: 12, paymentsCount: 4 }),
        project({ chainId: 8453, projectId: 33, paymentsCount: 9 }),
      ]),
    ).toBe(20)
  })

  it('ignores malformed indexed counts instead of poisoning the total', () => {
    expect(
      projectGroupPaymentsCount([
        project({ paymentsCount: -1 }),
        project({ chainId: 10, projectId: 12, paymentsCount: Number.NaN }),
        project({ chainId: 8453, projectId: 33, paymentsCount: 2 }),
      ]),
    ).toBe(2)
  })
})

describe('route identity', () => {
  it('round-trips canonical chain slugs and positive integer project IDs', () => {
    expect(parseUrn(toUrn(1, 42))).toEqual({ chainId: 1, projectId: 42 })
    expect(parseUrn('eth%3A42')).toEqual({ chainId: 1, projectId: 42 })
  })

  it.each(['unknown:42', 'eth:0', 'eth:-1', 'eth:1.5', 'eth:not-a-number'])(
    'rejects an invalid route identity (%s)',
    urn => {
      expect(parseUrn(urn)).toBeNull()
    },
  )

  it('keeps unknown chain display fallbacks explicit', () => {
    expect(toUrn(999, 7)).toBe('999:7')
    expect(chainName(999)).toBe('Chain 999')
  })
})
