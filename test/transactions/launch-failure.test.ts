import { beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeFunctionData, type Hex, type PublicClient, type TransactionReceipt } from 'viem'
import { buildHistoricalLaunchRequest, buildLaunchRequest, launchCallForRecovery, createSimpleProjectStage, DEFAULT_STORE_FLAGS, requireFinalizedLaunchFailure, type LaunchPlan } from '@/lib/launch'

const ACCOUNT = '0x1111111111111111111111111111111111111111' as const
const OTHER = '0x2222222222222222222222222222222222222222' as const
const HASH = `0x${'12'.repeat(32)}` as Hex
const BLOCK = `0x${'34'.repeat(32)}` as Hex
const OTHER_BLOCK = `0x${'56'.repeat(32)}` as Hex
const plan: LaunchPlan = {
  accounting: { tokens: ['eth'], custom: null }, issuanceBase: null, flavor: 'project', projectName: 'Test',
  operator: null, owner: ACCOUNT, ticker: '', stages: [createSimpleProjectStage()], afterMode: 'wait',
  approvalDeadline: 'none', approvalCustomAddress: null, allowAnyToken: true, chains: [8453], linkChains: false,
  bridge: 'ccip', store: { name: 'Test', symbol: 'TEST', currency: 'eth', ...DEFAULT_STORE_FLAGS, items: [] },
}
const direct = { account: ACCOUNT, chainId: 8453 as const, projectUri: 'ipfs://test', plan, salt: HASH }
const request = buildLaunchRequest({ ...direct, owner: ACCOUNT, creationFee: 123n })
const receipt = { status: 'reverted', transactionHash: HASH, blockHash: BLOCK, blockNumber: 120n } satisfies Pick<TransactionReceipt, 'status' | 'transactionHash' | 'blockNumber' | 'blockHash'>
const getTransaction = vi.fn()
const getBlock = vi.fn()
const client = { getTransaction, getBlock } as unknown as Pick<PublicClient, 'getTransaction' | 'getBlock'>
const transaction = {
  hash: HASH, chainId: 8453, blockHash: BLOCK, from: ACCOUNT, to: request.address,
  input: encodeFunctionData(request as Parameters<typeof encodeFunctionData>[0]), value: 123n,
}

beforeEach(() => {
  vi.resetAllMocks()
  getTransaction.mockResolvedValue(transaction)
  getBlock.mockImplementation(async ({ blockTag, blockNumber }) => ({
    hash: BLOCK, number: blockTag === 'finalized' ? 125n : blockNumber, timestamp: 123456n,
  }))
})

describe('finalized direct launch failure release', () => {
  it('releases an exact raw EOA launch only after authenticating its original call and finalized canonical receipt', async () => {
    await requireFinalizedLaunchFailure(client, receipt, HASH, direct)
    expect(getTransaction).toHaveBeenCalledWith({ hash: HASH })
    expect(getBlock.mock.calls).toEqual([[{ blockTag: 'finalized' }], [{ blockNumber: 120n }], [{ blockNumber: 125n }]])
  })

  it('authenticates historical custom-vote and reserved single-tier bytes only for finalized failure recovery', async () => {
    const oldPlan: LaunchPlan = { ...plan, store: { ...plan.store, items: [{
      price: 100n, supply: 1, votingUnits: 19, reserveFrequency: 2, reserveBeneficiary: ACCOUNT,
      encodedIpfsUri: HASH, category: 0, discountPercent: 0, splitPercent: 0, splits: [], perChainSupply: {},
      flags: { allowOwnerMint: false, transfersPausable: false, cantBeRemoved: false, allowCredits: true, ownerCanEditDiscount: true },
    }] } }
    const oldDirect = { ...direct, plan: oldPlan }
    const historical = buildHistoricalLaunchRequest({ ...oldDirect, owner: ACCOUNT, creationFee: 123n })
    getTransaction.mockResolvedValue({ ...transaction, to: historical.address, input: encodeFunctionData(historical as Parameters<typeof encodeFunctionData>[0]) })
    await expect(requireFinalizedLaunchFailure(client, receipt, HASH, oldDirect)).resolves.toBeUndefined()
    expect(() => buildLaunchRequest({ ...oldDirect, owner: ACCOUNT, creationFee: 123n })).toThrow('at least 2')
    const validPlan = { ...oldPlan, store: { ...oldPlan.store, items: [{ ...oldPlan.store.items[0], supply: 2 }] } }
    const args = { ...direct, plan: validPlan, owner: ACCOUNT, creationFee: 123n }
    expect(encodeFunctionData(buildLaunchRequest(args) as Parameters<typeof encodeFunctionData>[0])).not.toBe(encodeFunctionData(buildHistoricalLaunchRequest(args) as Parameters<typeof encodeFunctionData>[0]))
    for (const build of [buildLaunchRequest, buildHistoricalLaunchRequest]) {
      const candidate = build(args)
      const data = encodeFunctionData(candidate as Parameters<typeof encodeFunctionData>[0])
      expect(launchCallForRecovery(args, { from: ACCOUNT, chainId: 8453, to: candidate.address, input: data, value: 123n })).toEqual({ to: candidate.address, data, value: 123n })
      expect(() => launchCallForRecovery(args, { from: OTHER, chainId: 8453, to: candidate.address, input: data, value: 123n })).toThrow('saved plan')
      expect(() => launchCallForRecovery(args, { from: ACCOUNT, chainId: 8453, to: candidate.address, input: '0x1234', value: 123n })).toThrow('saved plan')
    }
  })

  it('requires finalized canonical inclusion after the caller proves Safe inner failure', async () => {
    await requireFinalizedLaunchFailure(client, { ...receipt, status: 'success' }, HASH)
    expect(getTransaction).not.toHaveBeenCalled()
    expect(getBlock).toHaveBeenCalledWith({ blockTag: 'finalized' })
  })

  it.each([
    { from: OTHER }, { to: ACCOUNT }, { input: '0x1234' }, { hash: OTHER_BLOCK }, { chainId: 1 }, { blockHash: OTHER_BLOCK },
  ])('holds a legacy erased-proposal receipt whose transaction is not the exact original raw launch: %j', patch => {
    getTransaction.mockResolvedValue({ ...transaction, ...patch })
    return expect(requireFinalizedLaunchFailure(client, receipt, HASH, direct)).rejects.toThrow('not yet verified and finalized')
  })

  it('never classifies a successful raw EOA transaction as a failed launch', async () => {
    await expect(requireFinalizedLaunchFailure(client, { ...receipt, status: 'success' }, HASH, direct)).rejects.toThrow('not yet verified and finalized')
  })

  it('holds a mismatched receipt hash before reading finality', async () => {
    await expect(requireFinalizedLaunchFailure(client, { ...receipt, transactionHash: OTHER_BLOCK }, HASH)).rejects.toThrow('not yet verified and finalized')
    expect(getBlock).not.toHaveBeenCalled()
  })

  it.each(['not-finalized', 'receipt-reorg', 'finality-reorg', 'unavailable'] as const)('retains failure retry hold when finality is %s', async kind => {
    getBlock.mockImplementation(async ({ blockTag, blockNumber }) => {
      if (kind === 'unavailable') throw new Error('Unsupported finalized tag')
      return {
        number: blockTag === 'finalized' ? (kind === 'not-finalized' ? 119n : 125n) : blockNumber,
        timestamp: 123456n,
        hash: (kind === 'receipt-reorg' && blockNumber === 120n) || (kind === 'finality-reorg' && blockNumber === 125n) ? OTHER_BLOCK : BLOCK,
      }
    })
    await expect(requireFinalizedLaunchFailure(client, { ...receipt, status: 'success' }, HASH)).rejects.toThrow('not yet verified and finalized')
  })
})
