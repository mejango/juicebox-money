import { beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeFunctionData, type Hex, type PublicClient, type TransactionReceipt } from 'viem'
import { buildLaunchRequest, createSimpleProjectStage, DEFAULT_STORE_FLAGS, requireFinalizedLaunchFailure, type LaunchPlan } from '@/lib/launch'

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
