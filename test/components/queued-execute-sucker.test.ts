import { describe, expect, it, vi } from 'vitest'
import type { Address, PublicClient } from 'viem'

const registered = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('@bananapus/nana-sdk-core/v6', async original => ({
  ...(await original<typeof import('@bananapus/nana-sdk-core/v6')>()),
  getRegisteredSucker: registered.get,
  classifySuckerTransport: async () => 'native',
}))

import { UnverifiedSuckerError } from '@bananapus/nana-sdk-core/v6'
import { prepareQueuedExecute } from '@/components/project/SettlementSection'

const INDEXED = '0x1111111111111111111111111111111111111111' as Address
const REGISTERED = '0x2222222222222222222222222222222222222222' as Address
const TOKEN = '0x000000000000000000000000000000000000EEEe' as Address
const ACCOUNT = '0x3333333333333333333333333333333333333333' as Address
const group = { sourceChainId: 10, destChainId: 8453, sucker: INDEXED, token: TOKEN, projectId: 7, account: ACCOUNT }
const client = { readContract: vi.fn(async () => 5n) } as unknown as PublicClient

describe("a queued movement's Execute", () => {
  it("sends toRemote to the registry's sucker, never the indexer's", async () => {
    registered.get.mockResolvedValueOnce(REGISTERED)
    const { sucker, request } = await prepareQueuedExecute(client, group)
    expect(registered.get).toHaveBeenCalledWith(client, { chainId: 10, projectId: 7n, remoteChainId: 8453, sucker: INDEXED })
    expect(sucker).toBe(REGISTERED)
    expect(request.address).toBe(REGISTERED)
    expect(request.functionName).toBe('toRemote')
    expect(request.value).toBe(5n)
  })

  it('stops before any fee read or send when the registry does not list the sucker', async () => {
    vi.mocked(client.readContract).mockClear()
    registered.get.mockRejectedValueOnce(new UnverifiedSuckerError('unregistered'))
    await expect(prepareQueuedExecute(client, group)).rejects.toBeInstanceOf(UnverifiedSuckerError)
    expect(client.readContract).not.toHaveBeenCalled()
  })
})
