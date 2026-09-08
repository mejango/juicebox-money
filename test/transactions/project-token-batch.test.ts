import { decodeFunctionData, getAddress, type Address } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { JBCoreContracts, RevnetCoreContracts, jbContractAddress, jbControllerAbi, revOwnerAbi } from '@bananapus/nana-sdk-core'

const mocks = vi.hoisted(() => ({
  clients: new Map<number, { readContract: ReturnType<typeof vi.fn>; getBlock: ReturnType<typeof vi.fn> }>(),
  credits: vi.fn(), token: vi.fn(), amount: vi.fn(),
}))
vi.mock('@/lib/authority', () => ({ clientFor: (chain: number) => mocks.clients.get(chain) }))
vi.mock('@/lib/token-symbol', () => ({ tokenSymbol: async (_client: unknown, token: string) => token.endsWith('1') ? 'ONE' : 'TWO' }))
vi.mock('@bananapus/nana-sdk-core/v6', async original => ({
  ...await original<typeof import('@bananapus/nana-sdk-core/v6')>(),
  getCreditBalance: mocks.credits, getTokenAddress: mocks.token, getAmountToAutoIssue: mocks.amount,
}))

import { readAutoIssueCalls, readAutoIssueAllocationCall, readClaimCalls, reverifyAutoIssueCall, reverifyClaimCall } from '@/lib/project-token-batch'

const ACCOUNT = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address
const BENEFICIARY = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Address
const OTHER = '0xcccccccccccccccccccccccccccccccccccccccc' as Address
const TOKEN_ONE = '0x1000000000000000000000000000000000000001' as Address
const TOKEN_TWO = '0x2000000000000000000000000000000000000002' as Address
const controller = (chain: 1 | 10) => jbContractAddress['6'][JBCoreContracts.JBController][chain]
const owner = (chain: 1 | 10) => jbContractAddress['6'][RevnetCoreContracts.REVOwner][chain]
const chains = [[1, 42], [10, 84]] as const

beforeEach(() => {
  mocks.clients.clear()
  for (const chain of [1, 10] as const) {
    mocks.clients.set(chain, {
      readContract: vi.fn(async ({ functionName, args }) => {
        if (functionName === 'controllerOf' || functionName === 'CONTROLLER') return controller(chain)
        if (functionName === 'ownerOf') return owner(chain)
        if (functionName === 'getRulesetOf') return [{ id: args[1], start: args[1] === 2n ? 2_000 : 500 }, {}]
        throw new Error(`Unexpected read ${functionName}`)
      }),
      getBlock: vi.fn().mockResolvedValue({ timestamp: 1_000n }),
    })
  }
  mocks.token.mockImplementation(async (_client, { chainId }) => chainId === 1 ? TOKEN_ONE : TOKEN_TWO)
  mocks.credits.mockImplementation(async (_client, { projectId }) => projectId === 42n ? 7n * 10n ** 18n : 13n * 10n ** 18n)
  mocks.amount.mockImplementation(async (_client, { stageId, beneficiary }) => stageId === 3n ? 0n : beneficiary === BENEFICIARY ? 200n : 100n)
})

describe('cross-chain credit claims', () => {
  it('freezes each local project, token and credit balance while keeping the holder as beneficiary', async () => {
    const calls = await readClaimCalls(chains, ACCOUNT)
    expect(calls).toHaveLength(2)
    for (const [index, projectId] of [42n, 84n].entries()) {
      expect(decodeFunctionData({ abi: jbControllerAbi, data: calls[index].data })).toMatchObject({
        functionName: 'claimTokensFor', args: [getAddress(ACCOUNT), projectId, index ? 13n * 10n ** 18n : 7n * 10n ** 18n, getAddress(ACCOUNT)],
      })
      expect(calls[index]).toMatchObject({ authority: ACCOUNT, projectId: Number(projectId), context: {
        holder: ACCOUNT, token: index ? TOKEN_TWO : TOKEN_ONE, symbol: index ? 'TWO' : 'ONE',
      } })
    }
    expect(mocks.clients.get(10)!.readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'controllerOf', args: [84n] }))
  })

  it('does not invent a claim for credits without a deployed ERC-20 or an empty balance', async () => {
    mocks.token.mockResolvedValue(null)
    await expect(readClaimCalls(chains, ACCOUNT)).rejects.toThrow(/No selected chain/)
    mocks.token.mockResolvedValue(TOKEN_ONE)
    mocks.credits.mockResolvedValue(0n)
    await expect(readClaimCalls(chains, ACCOUNT)).rejects.toThrow(/No selected chain/)
  })

  it.each(['credits', 'token'] as const)('refuses to send when the reviewed %s changed', async field => {
    const [call] = await readClaimCalls(chains, ACCOUNT)
    if (field === 'credits') mocks.credits.mockResolvedValue(1n)
    else mocks.token.mockResolvedValue(TOKEN_TWO)
    await expect(reverifyClaimCall(call)).rejects.toThrow(/changed/)
  })

  it('binds a saved claim’s calldata to the unchanged holder and amount', async () => {
    const [call] = await readClaimCalls(chains, ACCOUNT)
    await expect(reverifyClaimCall({ ...call, data: '0x1234' })).rejects.toThrow(/changed/)
  })
})

describe('aggregate auto issuance', () => {
  it('builds an individual row with the same live project context and call identity as its aggregate', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ stored: [{ stageId: '1', beneficiary: BENEFICIARY }] })))
    const [aggregate] = await readAutoIssueCalls([[10, 84]], ACCOUNT)
    const row = await readAutoIssueAllocationCall(10, 84, '01', BENEFICIARY, ACCOUNT)
    expect(row).toEqual(aggregate)
    expect(decodeFunctionData({ abi: revOwnerAbi, data: row.data }).args).toEqual([84n, 1n, getAddress(BENEFICIARY)])
  })

  it.each(['2', '3'])('refuses an individual locked or exhausted stage %s', async stage => {
    await expect(readAutoIssueAllocationCall(1, 42, stage, BENEFICIARY, ACCOUNT)).rejects.toThrow(/Nothing left to distribute/)
  })

  it('includes every unlocked beneficiary and stage, retaining multiple calls on one chain', async () => {
    vi.mocked(fetch).mockImplementation(async input => new Response(JSON.stringify({ stored: String(input).includes('projectId=42') ? [
      { stageId: '1', beneficiary: ACCOUNT }, { stageId: '1', beneficiary: BENEFICIARY },
      { stageId: '1', beneficiary: ACCOUNT }, { stageId: '2', beneficiary: ACCOUNT },
      { stageId: '3', beneficiary: ACCOUNT },
    ] : [{ stageId: '5', beneficiary: OTHER }] })))
    const calls = await readAutoIssueCalls(chains, ACCOUNT)
    expect(calls.map(call => [call.chainId, call.projectId])).toEqual([[1, 42], [1, 42], [10, 84]])
    expect(calls.map(call => decodeFunctionData({ abi: revOwnerAbi, data: call.data }).args)).toEqual([
      [42n, 1n, getAddress(ACCOUNT)], [42n, 1n, getAddress(BENEFICIARY)], [84n, 5n, getAddress(OTHER)],
    ])
    expect(new Set(calls.map(call => call.id)).size).toBe(3)
    expect(calls[1].context).toMatchObject({ amount: '200', beneficiary: BENEFICIARY, token: TOKEN_ONE })
  })

  it('refuses a partial candidate read instead of omitting a selected chain', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('unavailable', { status: 502 }))
    await expect(readAutoIssueCalls(chains, ACCOUNT)).rejects.toThrow(/every selected chain/)
  })

  it('rechecks the original allocation before its round can be funded', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ stored: [{ stageId: '1', beneficiary: BENEFICIARY }] })))
    const [call] = await readAutoIssueCalls([[1, 42]], ACCOUNT)
    mocks.amount.mockResolvedValue(0n)
    await expect(reverifyAutoIssueCall(call)).rejects.toThrow(/allocation.*changed/)
  })

  it('refuses a saved auto-issuance payload with a substituted recipient', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ stored: [{ stageId: '1', beneficiary: BENEFICIARY }] })))
    const [call] = await readAutoIssueCalls([[1, 42]], ACCOUNT)
    await expect(reverifyAutoIssueCall({ ...call, data: '0x1234' })).rejects.toThrow(/changed/)
  })

  it('does not issue through a controller or project owner which no longer belongs to the revnet', async () => {
    mocks.clients.get(1)!.readContract.mockImplementation(async ({ functionName }) => {
      if (functionName === 'controllerOf' || functionName === 'CONTROLLER') return controller(1)
      if (functionName === 'ownerOf') return OTHER
      throw new Error('Unexpected read')
    })
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ stored: [{ stageId: '1', beneficiary: BENEFICIARY }] })))
    await expect(readAutoIssueCalls([[1, 42]], ACCOUNT)).rejects.toThrow(/owner or issuance controller changed/)
  })
})
