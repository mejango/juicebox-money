import { beforeEach, describe, expect, it, vi } from 'vitest'

const resolveSuckers = vi.hoisted(() => vi.fn())
vi.mock('@bananapus/nana-sdk-core', async original => ({ ...(await original<typeof import('@bananapus/nana-sdk-core')>()), resolveSuckers }))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: { name: 'config' } }))
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, create } from 'react-test-renderer'
import { clearSuckerGroups, requireLinkedPairs, useLinkedDeployments } from '@/lib/sucker-group'

const HOME = [1, 42] as const
beforeEach(() => {
  clearSuckerGroups()
  resolveSuckers.mockReset().mockResolvedValue([{ peerChainId: 1, projectId: 42n }, { peerChainId: 8453, projectId: 7n }])
})

describe('a deployment the indexer lists, before a write', () => {
  it('needs no read for the page\'s own deployment', async () => {
    await requireLinkedPairs(HOME, [HOME])
    expect(resolveSuckers).not.toHaveBeenCalled()
  })
  it('passes when the onchain registry names the same chain and project', async () => {
    await requireLinkedPairs(HOME, [HOME, [8453, 7]])
    expect(resolveSuckers).toHaveBeenCalledWith({ config: { name: 'config' }, chainId: 1, projectId: 42n, version: 6 })
  })
  it('refuses another project on a linked chain', async () => {
    await expect(requireLinkedPairs(HOME, [[8453, 8]])).rejects.toThrow("The Base project listed here isn't linked onchain.")
  })
  it('refuses a chain the registry does not link', async () => {
    await expect(requireLinkedPairs(HOME, [[10, 7]])).rejects.toThrow("The Optimism project listed here isn't linked onchain.")
  })
  it('refuses when the registry cannot be read, and reads again next time', async () => {
    resolveSuckers.mockRejectedValueOnce(new Error('rpc down'))
    await expect(requireLinkedPairs(HOME, [[8453, 7]])).rejects.toThrow("Couldn't confirm Base belongs to this project.")
    await requireLinkedPairs(HOME, [[8453, 7]])
    expect(resolveSuckers).toHaveBeenCalledTimes(2)
  })
  it('reads the group once per page', async () => {
    await requireLinkedPairs(HOME, [[8453, 7]])
    await requireLinkedPairs(HOME, [[8453, 7]])
    expect(resolveSuckers).toHaveBeenCalledTimes(1)
  })
})

describe('a section that writes to every listed deployment', () => {
  const listed = [{ chainId: 1, projectId: 42 }, { chainId: 8453, projectId: 7 }, { chainId: 10, projectId: 9 }]
  async function linked() {
    let seen!: ReturnType<typeof useLinkedDeployments<(typeof listed)[number]>>
    const Probe = () => { seen = useLinkedDeployments(HOME, listed); return null }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await act(async () => { create(<QueryClientProvider client={client}><Probe /></QueryClientProvider>) })
    const first = seen
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    return { first, seen }
  }
  it('keeps only the page\'s own deployment until the group is read, then adds the linked ones', async () => {
    const { first, seen } = await linked()
    expect(first.deployments).toEqual([listed[0]])
    expect(seen.deployments).toEqual(listed.slice(0, 2))
    expect(seen.line).toBe("The Optimism project listed here isn't linked onchain.")
  })
  it('hands back the same list when the registry links every deployment', async () => {
    resolveSuckers.mockResolvedValue([{ peerChainId: 1, projectId: 42n }, { peerChainId: 8453, projectId: 7n }, { peerChainId: 10, projectId: 9n }])
    const { seen } = await linked()
    expect(seen.deployments).toBe(listed)
    expect(seen.line).toBeNull()
  })
  it('keeps only its own deployment when the registry cannot be read', async () => {
    resolveSuckers.mockRejectedValue(new Error('rpc down'))
    const { seen } = await linked()
    expect(seen.deployments).toEqual([listed[0]])
    expect(seen.line).toBe("Couldn't confirm Base belongs to this project.")
  })
})
