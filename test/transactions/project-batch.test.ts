import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Address, Hex } from 'viem'

const mocks = vi.hoisted(() => ({
  account: '0x1111111111111111111111111111111111111111',
  relayr: vi.fn(), authority: vi.fn(), identity: vi.fn(), review: vi.fn(), safeSuccess: vi.fn(),
  client: { getTransaction: vi.fn(), getTransactionReceipt: vi.fn(), getBlock: vi.fn(),
    getBlockNumber: vi.fn(), getLogs: vi.fn() },
  pending: new Map<string, unknown>(),
}))
vi.mock('@wagmi/core', () => ({ getAccount: () => ({ address: mocks.account }) }))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/lib/authority', () => ({ clientFor: () => mocks.client, runAuthorityCalls: mocks.authority }))
vi.mock('@/lib/cross-chain-authority', () => ({ readAuthorityIdentity: mocks.identity }))
vi.mock('@/lib/safe', () => ({
  canonicalSafeTxHash: (_chain: number, _safe: string, tx: { safeTxHash: string }) => tx.safeTxHash,
  receiptHasSafeExecutionSuccess: mocks.safeSuccess,
}))
vi.mock('@/lib/safe-connector', () => ({ isSafeConnection: () => false, waitForSafeExecutionHash: vi.fn() }))
vi.mock('@/lib/transaction-review', () => ({ requireTransactionReview: mocks.review }))
vi.mock('@/lib/viewAs', () => ({ assertNoViewAs: () => {} }))
vi.mock('@/lib/relayr', () => ({
  loadRelayrPendingSession: (scope: string) => mocks.pending.get(scope) ?? null,
  relayrTargetSupportsForwarder: async () => true,
  runRelayrCalls: mocks.relayr,
  withRelayrScopeLock: async (_scope: string, run: () => Promise<unknown>) => run(),
  relayrErrorIsDefiniteNoSubmission: (error: { code?: number }) => error?.code === 4001,
  relayrDestinationHash: (record: { hash: string }) => record.hash,
  relayrRecordChain: (record: { chain: number }) => record.chain,
}))

import { loadProjectBatch, projectBatchRounds, projectBatchScope, runProjectBatch,
  type ProjectBatchCall } from '@/lib/project-batch'

const ACCOUNT = mocks.account as Address
const TARGET = '0x2222222222222222222222222222222222222222' as Address
const HASH = `0x${'ab'.repeat(32)}` as Hex
const BLOCK = `0x${'cd'.repeat(32)}` as Hex
const action = 'test-distribute'
const scope = projectBatchScope(action, 1, 7)
const call = (chainId = 1, suffix = ''): ProjectBatchCall => ({
  id: `${chainId}:${suffix}`, projectId: 7, chainId: chainId as 1, authority: ACCOUNT,
  target: TARGET, data: '0x1234', value: 3n, context: { amount: 6n, recipient: TARGET },
})
const run = (calls?: ProjectBatchCall[], extra = {}) => runProjectBatch({ scope, action, account: ACCOUNT, calls, ...extra })

beforeEach(() => {
  vi.resetAllMocks()
  mocks.pending.clear()
  mocks.account = ACCOUNT
  const storage = new Map<string, string>()
  vi.stubGlobal('window', { localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  } })
  vi.stubGlobal('navigator', { locks: {} })
  mocks.identity.mockResolvedValue({ kind: 'eoa' })
  mocks.safeSuccess.mockReturnValue(false)
  mocks.client.getBlock.mockResolvedValue({ hash: BLOCK })
  mocks.client.getBlockNumber.mockResolvedValue(10n)
  mocks.client.getLogs.mockResolvedValue([])
  mocks.client.getTransaction.mockResolvedValue({ hash: HASH, chainId: 1, from: ACCOUNT,
    to: TARGET, input: '0x1234', value: 3n, blockHash: BLOCK })
  mocks.client.getTransactionReceipt.mockResolvedValue({ transactionHash: HASH,
    blockHash: BLOCK, blockNumber: 10n, status: 'success', logs: [] })
  mocks.authority.mockImplementation(async ({ calls }: { calls: ProjectBatchCall[] }) => {
    await calls[0].reverifyAuthority?.()
    await calls[0].onSending?.('direct')
    await calls[0].onSubmitted?.(HASH, 'direct')
    return { directResults: [HASH], safeResults: [], relayrGroups: 0, relayrResults: [] }
  })
  mocks.relayr.mockImplementation(async options => {
    const saved = mocks.pending.get(options.pendingScope) as { paid?: boolean } | undefined
    if (!saved?.paid) await options.reverify()
    mocks.pending.set(options.pendingScope, { paid: true })
    await options.onComplete(options.calls.map((item: ProjectBatchCall) => ({ chain: item.chainId, hash: HASH })))
    mocks.pending.delete(options.pendingScope)
  })
})

describe('durable project batches', () => {
  it('keeps every allocation and orders repeated chain calls in later rounds', async () => {
    const calls = [call(1, 'a'), call(1, 'b'), call(10, 'a'), call(10, 'b')]
    expect(projectBatchRounds(calls)).toEqual([['1:a', '10:a'], ['1:b', '10:b']])
    const batch = await run(calls)
    expect(batch.status).toBe('complete')
    expect(batch.completedIds).toHaveLength(4)
    expect(mocks.relayr).toHaveBeenCalledTimes(2)
    expect(loadProjectBatch(scope)).toBeNull()
    expect(loadProjectBatch(projectBatchScope(action, 10, 7))).toBeNull()
    expect(batch.calls[0].context).toEqual(calls[0].context)
  })

  it('relays fresh calls across all four Sepolia chains in one saved bundle', async () => {
    const chains = [11155111, 11155420, 84532, 421614]
    const completed = await run(chains.map(chain => call(chain)))
    expect(completed.status).toBe('complete')
    expect(completed.relayrChainIds).toEqual(chains)
    expect(mocks.relayr).toHaveBeenCalledTimes(1)
    expect(mocks.relayr.mock.calls[0][0].calls.map((item: ProjectBatchCall) => item.chainId)).toEqual(chains)
    expect(mocks.authority).not.toHaveBeenCalled()
  })

  it('never combines mainnet and testnet calls into the same paid round', async () => {
    mocks.client.getTransaction.mockImplementation(async () => {
      const submitted = mocks.authority.mock.calls.at(-1)![0].calls[0] as ProjectBatchCall
      return { hash: HASH, chainId: submitted.chainId, from: ACCOUNT, to: TARGET,
        input: submitted.data, value: 3n, blockHash: BLOCK }
    })
    const completed = await run([call(), call(11155111), call(10), call(84532)])
    expect(completed.status).toBe('complete')
    expect(mocks.relayr).toHaveBeenCalledTimes(1)
    expect(mocks.relayr.mock.calls[0][0].calls.map((item: ProjectBatchCall) => item.chainId)).toEqual([1, 10])
    expect(mocks.authority.mock.calls.map(([options]) => options.calls[0].chainId)).toEqual([11155111, 84532])
  })

  it('preserves legacy direct testnet recovery after Relayr support is enabled', async () => {
    mocks.identity.mockResolvedValue({ kind: 'contract' })
    mocks.client.getTransaction.mockImplementation(async () => {
      const submitted = mocks.authority.mock.calls.at(-1)![0].calls[0] as ProjectBatchCall
      return { hash: HASH, chainId: submitted.chainId, from: ACCOUNT, to: TARGET,
        input: submitted.data, value: 3n, blockHash: BLOCK }
    })
    mocks.client.getTransactionReceipt.mockRejectedValueOnce(new Error('receipt timeout'))
    await expect(run([call(11155111), call(11155420), call(84532)])).rejects.toThrow('receipt timeout')
    const saved = loadProjectBatch(scope)!
    const key = `jb-project-batch:v1:journal:${saved.id}`
    const legacy = JSON.parse(window.localStorage.getItem(key)!)
    delete legacy.relayrChainIds
    window.localStorage.setItem(key, JSON.stringify(legacy))
    mocks.identity.mockResolvedValue({ kind: 'eoa' })

    const completed = await run()
    expect(completed.status).toBe('complete')
    expect(mocks.relayr).not.toHaveBeenCalled()
    expect(mocks.authority).toHaveBeenCalledTimes(3)
    expect(completed.completedIds).toHaveLength(3)
  })

  it('resumes an already paid round without rebuilding or revalidating stale source state', async () => {
    const defaultRelay = mocks.relayr.getMockImplementation()!
    mocks.relayr.mockImplementationOnce(async options => {
      mocks.pending.set(options.pendingScope, { paid: true })
      throw new Error('destination RPC timeout')
    })
    await expect(run([call(), call(10)])).rejects.toThrow('timeout')
    const reverify = vi.fn().mockRejectedValue(new Error('credits now zero'))
    mocks.relayr.mockImplementation(defaultRelay)
    const result = await run(undefined, { reverify })
    expect(result.status).toBe('complete')
    expect(reverify).not.toHaveBeenCalled()
  })

  it('blocks another peer route from replacing a pending reviewed call set', async () => {
    mocks.relayr.mockImplementationOnce(async options => {
      mocks.pending.set(options.pendingScope, { paid: true })
      throw new Error('pending')
    })
    await expect(run([call(), call(10)])).rejects.toThrow('pending')
    await expect(runProjectBatch({ scope: projectBatchScope(action, 10, 7), action,
      account: ACCOUNT, calls: [call(10), { ...call(8453), data: '0xffff' }] })).rejects.toThrow('different reviewed settings')
    expect(mocks.relayr).toHaveBeenCalledTimes(1)
  })

  it('rejects a stale recovery review after another tab completed its journal', async () => {
    const completed = await run([call()])
    await expect(run([call()], { expectedBatchId: completed.id })).rejects.toThrow('completed or changed')
    expect(mocks.authority).toHaveBeenCalledTimes(1)
  })

  it('relays the eligible mainnet subset and stages a testnet call separately', async () => {
    const testnet = { ...call(11155111), data: '0xabcd' as Hex }
    mocks.client.getTransaction.mockResolvedValueOnce({ hash: HASH, chainId: 11155111,
      from: ACCOUNT, to: TARGET, input: '0xabcd', value: 3n, blockHash: BLOCK })
    const completed = await run([call(), testnet, call(10)])
    expect(completed.status).toBe('complete')
    expect(mocks.relayr.mock.calls[0][0].calls.map((item: ProjectBatchCall) => item.chainId)).toEqual([1, 10])
    expect(mocks.authority.mock.calls[0][0].calls[0].chainId).toBe(11155111)
    expect(completed.completedIds).toHaveLength(3)
  })

  it('journals a direct hash before a receipt timeout and never sends it twice', async () => {
    mocks.client.getTransactionReceipt.mockRejectedValueOnce(new Error('RPC unavailable'))
    await expect(run([call()])).rejects.toThrow('RPC unavailable')
    expect(loadProjectBatch(scope)?.submissions[call().id].hash).toBe(HASH)
    expect((await run()).status).toBe('complete')
    expect(mocks.authority).toHaveBeenCalledTimes(1)
  })

  it('blocks unknown wallet submissions across reload instead of retrying them', async () => {
    mocks.authority.mockImplementationOnce(async ({ calls }) => {
      await calls[0].onSending('direct')
      throw new Error('transport lost after send')
    })
    await expect(run([call()])).rejects.toThrow('transport lost')
    await expect(run()).rejects.toThrow('may still be pending')
    expect(mocks.authority).toHaveBeenCalledTimes(1)
  })

  it('allows another review after a definite wallet rejection with no exposed submission', async () => {
    mocks.authority.mockImplementationOnce(async ({ calls }) => {
      await calls[0].onSending('direct')
      throw Object.assign(new Error('User rejected'), { code: 4001 })
    })
    await expect(run([call()])).rejects.toThrow('User rejected')
    expect(loadProjectBatch(scope)).toBeNull()
    expect((await run([call()])).status).toBe('complete')
  })

  it('allows fresh inputs after a failed preflight before any wallet action', async () => {
    await expect(run([call()], { reverify: async () => { throw new Error('amount changed') } })).rejects.toThrow('amount changed')
    expect(loadProjectBatch(scope)).toBeNull()
    expect(mocks.authority).not.toHaveBeenCalled()
    expect((await run([call()])).status).toBe('complete')
  })

  it('durably clears a rejected later call while retaining an earlier completion', async () => {
    const send = mocks.authority.getMockImplementation()!
    mocks.authority.mockImplementationOnce(send).mockImplementationOnce(async ({ calls }) => {
      await calls[0].onSending('direct')
      throw Object.assign(new Error('User rejected'), { code: 4001 })
    })
    await expect(run([call(1, 'first'), call(1, 'second')])).rejects.toThrow('User rejected')
    const saved = loadProjectBatch(scope)!
    expect(saved.completedIds).toEqual(['1:first'])
    expect(saved.submissions['1:second']).toBeUndefined()
    expect((await run()).status).toBe('complete')
    expect(mocks.authority).toHaveBeenCalledTimes(3)
  })

  it('requires exact calldata, sender, and a canonical destination receipt', async () => {
    mocks.client.getTransaction.mockResolvedValueOnce({ hash: HASH, chainId: 1,
      from: ACCOUNT, to: TARGET, input: '0xffff', value: 3n, blockHash: BLOCK })
    await expect(run([call()])).rejects.toThrow('different project transaction')
    expect(loadProjectBatch(scope)?.completedIds).toEqual([])
    mocks.client.getBlock.mockResolvedValueOnce({ hash: HASH })
    await expect(run()).rejects.toThrow('no longer canonical')
    expect(mocks.authority).toHaveBeenCalledTimes(1)
  })

  it('keeps successful receipts pending when application events report a failed distribution', async () => {
    const verifyCompletion = vi.fn().mockRejectedValue(new Error('split hook failed'))
    await expect(run([call()], { verifyCompletion })).rejects.toThrow('split hook failed')
    await expect(run(undefined, { verifyCompletion })).rejects.toThrow('split hook failed')
    expect(mocks.authority).toHaveBeenCalledTimes(1)
    expect(loadProjectBatch(scope)?.completedIds).toEqual([])
  })

  it('persists application completion before clearing a paid Relayr recovery journal', async () => {
    const verifyCompletion = vi.fn().mockRejectedValue(new Error('distribution reverted'))
    await expect(run([call(), call(10)], { verifyCompletion })).rejects.toThrow('distribution reverted')
    expect(mocks.pending.size).toBe(1)
    expect(loadProjectBatch(scope)?.completedIds).toEqual([])
    verifyCompletion.mockResolvedValue(undefined)
    expect((await run(undefined, { verifyCompletion })).status).toBe('complete')
    expect(mocks.pending.size).toBe(0)
  })

  it('retains a Safe proposal and refuses to advance to a replacement nonce', async () => {
    const safeTx = { safeTxHash: HASH, nonce: 3, to: TARGET, data: '0x1234', value: '3' }
    mocks.authority.mockImplementation(async ({ calls }) => {
      await calls[0].onSafePrepared(safeTx)
      return { directResults: [], safeResults: [{ status: 'queued', safeTxHash: HASH }], relayrGroups: 0, relayrResults: [] }
    })
    const first = await run([call()])
    expect(first.status).toBe('pending')
    expect(first.completedIds).toEqual([])
    mocks.authority.mockImplementationOnce(async ({ calls }) => {
      await calls[0].onSafePrepared({ ...safeTx, safeTxHash: BLOCK, nonce: 4 })
    })
    await expect(run()).rejects.toThrow('Safe nonce changed')
    expect(loadProjectBatch(scope)?.submissions[call().id].hash).toBe(HASH)
  })

  it('finds a connector execution from canonical Safe logs without a hosted service', async () => {
    mocks.authority.mockImplementationOnce(async ({ calls }) => {
      await calls[0].onSending('safe-connector')
      await calls[0].onSubmitted(HASH, 'safe-connector')
      throw new Error('Safe service unavailable')
    })
    await expect(run([call()])).rejects.toThrow('Safe service unavailable')
    expect(loadProjectBatch(scope)?.submissions[call().id].fromBlock).toBe(10n)
    mocks.client.getBlockNumber.mockResolvedValueOnce(11n)
    mocks.client.getLogs.mockResolvedValueOnce([{ transactionHash: HASH }])
    mocks.safeSuccess.mockReturnValue(true)
    expect((await run()).status).toBe('complete')
    expect(mocks.client.getLogs).toHaveBeenCalledWith({ address: ACCOUNT, fromBlock: 10n, toBlock: 11n })
    expect(mocks.authority).toHaveBeenCalledTimes(1)
  })

  it('fails before wallet review when browser locking or durable storage is unavailable', async () => {
    vi.stubGlobal('navigator', {})
    await expect(run([call()])).rejects.toThrow('Web Locks')
    vi.stubGlobal('navigator', { locks: {} })
    window.localStorage.setItem = () => { throw new Error('quota') }
    await expect(run([call()])).rejects.toThrow('recovery')
    expect(mocks.authority).not.toHaveBeenCalled()
    expect(mocks.review).not.toHaveBeenCalled()
  })
})
