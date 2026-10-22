import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Address, PublicClient } from 'viem'

const m = vi.hoisted(() => ({ registered: vi.fn(), buildClaim: vi.fn() }))
vi.mock('@bananapus/nana-sdk-core/v6', async original => ({
  ...(await original<typeof import('@bananapus/nana-sdk-core/v6')>()),
  getRegisteredSucker: m.registered,
  classifySuckerTransport: async () => 'native',
}))
vi.mock('@/lib/sucker-claims', () => ({ buildClaim: m.buildClaim }))

import { UnverifiedSuckerError } from '@bananapus/nana-sdk-core/v6'
import { prepareClaim, prepareQueuedExecute } from '@/components/project/SettlementSection'
import type { BridgeMovement } from '@/lib/suckers-queries'

const INDEXED_SOURCE = '0x1111111111111111111111111111111111111111' as Address
const INDEXED_DEST = '0x4444444444444444444444444444444444444444' as Address
const REGISTERED_SOURCE = '0x2222222222222222222222222222222222222222' as Address
const REGISTERED_DEST = '0x5555555555555555555555555555555555555555' as Address
const TOKEN = '0x000000000000000000000000000000000000EEEe' as Address
const ACCOUNT = '0x3333333333333333333333333333333333333333' as Address
/** The project is 42 on Optimism and 7 on Base. */
const chains: [number, number][] = [[10, 42], [8453, 7]]
const client = { readContract: vi.fn(async () => 5n) } as unknown as PublicClient
const destClient = {} as PublicClient

beforeEach(() => {
  m.registered.mockReset()
  m.buildClaim.mockReset().mockResolvedValue({ token: TOKEN, leaf: {}, proof: [] })
  vi.mocked(client.readContract).mockClear()
})

describe("a queued movement's Execute", () => {
  const group = { sourceChainId: 10, destChainId: 8453, sucker: INDEXED_SOURCE, token: TOKEN, chains, account: ACCOUNT }

  it("sends toRemote to the source registry's sucker for the source chain's project", async () => {
    m.registered.mockResolvedValueOnce(REGISTERED_SOURCE)
    const { sucker, request } = await prepareQueuedExecute(client, group)
    expect(m.registered).toHaveBeenCalledWith(client, { chainId: 10, projectId: 42n, remoteChainId: 8453, sucker: INDEXED_SOURCE })
    expect(sucker).toBe(REGISTERED_SOURCE)
    expect(request.address).toBe(REGISTERED_SOURCE)
    expect(request.functionName).toBe('toRemote')
    expect(request.value).toBe(5n)
  })

  it('stops before any fee read or send when the registry does not list the sucker', async () => {
    m.registered.mockRejectedValueOnce(new UnverifiedSuckerError('unregistered'))
    await expect(prepareQueuedExecute(client, group)).rejects.toBeInstanceOf(UnverifiedSuckerError)
    expect(client.readContract).not.toHaveBeenCalled()
  })
})

describe("a move's Claim", () => {
  const move = { sourceChainId: 10, destChainId: 8453, sourceSucker: INDEXED_SOURCE, destSucker: INDEXED_DEST, token: TOKEN } as unknown as BridgeMovement

  it("reads and claims only through both registries' suckers, each for its own chain's project", async () => {
    m.registered.mockImplementation(async (_client: unknown, { chainId }: { chainId: number }) => chainId === 10 ? REGISTERED_SOURCE : REGISTERED_DEST)
    const request = await prepareClaim(client, destClient, move, chains)
    expect(m.registered).toHaveBeenCalledWith(client, { chainId: 10, projectId: 42n, remoteChainId: 8453, sucker: INDEXED_SOURCE })
    expect(m.registered).toHaveBeenCalledWith(destClient, { chainId: 8453, projectId: 7n, remoteChainId: 10, sucker: INDEXED_DEST })
    expect(m.buildClaim.mock.calls[0][2]).toMatchObject({ sourceSucker: REGISTERED_SOURCE, destSucker: REGISTERED_DEST })
    expect(m.buildClaim.mock.calls[0][3]).toEqual({ sourceProjectId: 42n, destinationProjectId: 7n })
    expect(request.address).toBe(REGISTERED_DEST)
  })

  it('reads no proof and builds no claim when the destination registry does not list its sucker', async () => {
    m.registered.mockImplementation(async (_client: unknown, { chainId }: { chainId: number }) => {
      if (chainId === 8453) throw new UnverifiedSuckerError('unregistered')
      return REGISTERED_SOURCE
    })
    await expect(prepareClaim(client, destClient, move, chains)).rejects.toBeInstanceOf(UnverifiedSuckerError)
    expect(m.buildClaim).not.toHaveBeenCalled()
  })
})
