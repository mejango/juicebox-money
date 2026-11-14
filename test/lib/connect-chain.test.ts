import { MappableAsset, NATIVE_TOKEN, USDC_ADDRESSES, jbSuckerRegistryAbi, jbV6ContractAddress, type JBChainId } from '@bananapus/nana-sdk-core'
import { decodeFunctionData, type Address, type PublicClient } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ contexts: {} as Record<number, string[]>, dataHook: {} as Record<number, string> }))
vi.mock('@bananapus/nana-sdk-core/v6', async original => ({
  ...(await original<typeof import('@bananapus/nana-sdk-core/v6')>()),
  getCurrentRuleset: async (_client: unknown, { chainId }: { chainId: number }) => ({ metadata: { dataHook: mocks.dataHook[chainId], useDataHookForCashOut: true } }),
  getAccountingContexts: async (_client: unknown, { chainId }: { chainId: number }) => mocks.contexts[chainId].map(token => ({ token })),
}))

import { connectChainCandidates, planChainConnection } from '@/lib/connect-chain'

const OWNER = '0x00000000000000000000000000000000000000A1' as Address
const OTHER = '0x00000000000000000000000000000000000000B2' as Address
const SALT = `0x${'07'.repeat(32)}` as const
const members = [{ chainId: 1 as JBChainId, projectId: 12, authority: OWNER }, { chainId: 8453 as JBChainId, projectId: 40, authority: OWNER }]
let target: { owner: Address | Error; suckers: Address[] }
const clientFor = () => ({
  readContract: async ({ functionName }: { functionName: string }) => {
    if (functionName === 'suckersOf') return target.suckers
    if (target.owner instanceof Error) throw target.owner
    return target.owner
  },
}) as unknown as PublicClient
const plan = (patch: Partial<Parameters<typeof planChainConnection>[0]> = {}) =>
  planChainConnection({ members, targetChainId: 42161, targetProjectId: 77n, salt: SALT, clientFor, ...patch })

beforeEach(() => {
  target = { owner: OWNER, suckers: [] }
  mocks.dataHook = Object.fromEntries([1, 8453, 42161].map(id => [id, jbV6ContractAddress.JBOmnichainDeployer[id as JBChainId]]))
  mocks.contexts = { 1: [NATIVE_TOKEN, USDC_ADDRESSES[1]], 8453: [NATIVE_TOKEN], 42161: [NATIVE_TOKEN, USDC_ADDRESSES[42161]] }
})

describe('connecting a project to another chain', () => {
  it('offers only chains of the same environment the project is not on', () => {
    expect(connectChainCandidates([1, 8453])).toEqual([42161, 10])
    expect(connectChainCandidates([84532])).toEqual([11155111, 421614, 11155420])
  })

  it('wallet-action:connect-another-chain sends one registry call per chain from one account with one salt, mapping only tokens every chain accepts', async () => {
    const { calls, assets } = await plan()
    expect(assets).toEqual([MappableAsset.NATIVE])
    expect(calls.map(call => [call.chainId, call.authority, call.functionName])).toEqual([[1, OWNER, 'deploySuckersFor'], [8453, OWNER, 'deploySuckersFor'], [42161, OWNER, 'deploySuckersFor']])
    const decoded = calls.map(call => decodeFunctionData({ abi: jbSuckerRegistryAbi, data: call.data }).args as unknown as [bigint, string, { peer: string; mappings: { localToken: string }[] }[]])
    expect(decoded.map(args => [args[0], args[1], args[2].length])).toEqual([[12n, SALT, 1], [40n, SALT, 1], [77n, SALT, 2]])
    // The default peer (the sucker's own address) needs no extra permission, and only ETH is mapped.
    for (const [, , configurations] of decoded) for (const configuration of configurations) {
      expect(BigInt(configuration.peer)).toBe(0n)
      expect(configuration.mappings.map(mapping => mapping.localToken.toLowerCase())).toEqual([NATIVE_TOKEN.toLowerCase()])
    }
  })

  it('refuses a project owned by another account, missing, already connected, or sharing no token', async () => {
    target.owner = OTHER
    await expect(plan()).rejects.toThrow('owned by another account')
    target.owner = new Error('ERC721NonexistentToken')
    await expect(plan()).rejects.toThrow('Project #77 on Arbitrum could not be found.')
    target = { owner: OWNER, suckers: [OTHER] }
    await expect(plan()).rejects.toThrow('already connected to other chains')
    target.suckers = []
    mocks.contexts[42161] = [USDC_ADDRESSES[42161]]
    await expect(plan()).rejects.toThrow('no token in common')
  })

  it('refuses a project whose rules would not let a sucker create the tokens it brings in', async () => {
    mocks.dataHook[8453] = OTHER
    await expect(plan()).rejects.toThrow('Project #40 on Base cannot connect')
  })

  it('refuses when the project has different owners across its chains, or is already on the chain', async () => {
    await expect(plan({ members: [members[0], { ...members[1], authority: OTHER }] })).rejects.toThrow('same owner account on every chain')
    await expect(plan({ targetChainId: 8453 })).rejects.toThrow('already on Base')
  })
})
