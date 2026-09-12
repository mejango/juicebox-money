import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Address, Hex } from 'viem'

const mocks = vi.hoisted(() => ({
  account: '0x1111111111111111111111111111111111111111',
  relayr: vi.fn(), authority: vi.fn(), identity: vi.fn(), review: vi.fn(), safeSuccess: vi.fn(), waitSafe: vi.fn(), readSafe: vi.fn(),
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
  readSafeTransaction: mocks.readSafe,
}))
vi.mock('@/lib/safe-connector', () => ({ isSafeConnection: () => false, waitForSafeExecutionHash: mocks.waitSafe }))
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
  mocks.readSafe.mockResolvedValue({ safeTxHash: HASH, nonce: 3, to: TARGET, data: '0x1234', value: '3', operation: 0 })
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
    await options.onComplete(options.calls.map((item: ProjectBatchCall) => ({ chain: item.chainId, hash: HASH })),
      options.calls.map((item: ProjectBatchCall) => ({ chainId: item.chainId,
        receipt: { transactionHash: HASH, blockHash: BLOCK, blockNumber: 10n, status: 'success', logs: [] } })))
    mocks.pending.delete(options.pendingScope)
  })
})

describe('durable project batches', () => {
  it('adversarial: rechecks a completed receipt after interruption before finishing the batch', async () => {
    const calls = [call(1, 'first'), call(1, 'second')]
    mocks.authority.mockImplementationOnce(async ({ calls }) => {
      await calls[0].onSending('direct')
      await calls[0].onSubmitted(HASH, 'direct')
      return { directResults: [HASH], safeResults: [] }
    }).mockRejectedValueOnce(new Error('interrupted before second submission'))
    await expect(run(calls)).rejects.toThrow('interrupted before second submission')
    expect(loadProjectBatch(scope)?.completedIds).toEqual(['1:first'])
    // The first receipt's old block was replaced while the page was closed.
    mocks.client.getBlock.mockResolvedValue({ hash: HASH })
    const resumed = await run(undefined, { reconcileUnsubmitted: async () => true }).then(
      value => ({ value, error: null }), error => ({ value: null, error }),
    )
    expect(mocks.authority).toHaveBeenCalledTimes(2)
    expect(resumed.error, 'must not return complete using an orphaned first receipt').toBeTruthy()
    expect(loadProjectBatch(scope)?.status).toBe('pending')
  })

  it('adversarial: lets a resolved connector proposal reach obsolete-Safe reconciliation', async () => {
    mocks.authority.mockImplementationOnce(async ({ calls }) => {
      await calls[0].onSending('safe-connector')
      await calls[0].onSubmitted(HASH, 'safe-connector')
      throw new Error('connector response interrupted')
    })
    await expect(run([call()])).rejects.toThrow('connector response interrupted')
    mocks.waitSafe.mockRejectedValue(new Error('No execution for the obsolete proposal'))
    // No ExecutionSuccess: a keeper resolved the payment instead. Connector and
    // signer proposals must use the same authenticated policy, including final revalidation.
    const reconcileObsoleteSafe = vi.fn().mockResolvedValue(true)
    const result = await run(undefined, { reconcileObsoleteSafe })
    expect(mocks.authority).toHaveBeenCalledTimes(1)
    expect(reconcileObsoleteSafe).toHaveBeenCalledTimes(2)
    expect(mocks.readSafe).toHaveBeenCalledWith(1, ACCOUNT, HASH)
    expect(result.status).toBe('complete')
    expect(result.submissions['1:']).toMatchObject({ kind: 'safe', hash: HASH, safeTx: { nonce: 3 } })
  })

  it.each(['receipt missing', 'receipt re-mined', 'outcome changed'])('retains the exact original submission when completed evidence has %s', async condition => {
    mocks.authority.mockImplementationOnce(async ({ calls }) => {
      await calls[0].onSubmitted(HASH, 'direct')
      return { directResults: [HASH], safeResults: [] }
    }).mockRejectedValueOnce(new Error('second review interrupted'))
    await expect(run([call(1, 'first'), call(1, 'second')])).rejects.toThrow('second review interrupted')
    if (condition === 'receipt missing') mocks.client.getTransactionReceipt.mockRejectedValueOnce(new Error('receipt missing'))
    else mocks.client.getTransactionReceipt.mockResolvedValueOnce({ transactionHash: HASH,
      blockHash: condition === 'receipt re-mined' ? HASH : BLOCK,
      blockNumber: 10n, status: condition === 'outcome changed' ? 'reverted' : 'success', logs: [] })
    await expect(run()).rejects.toThrow()
    expect(loadProjectBatch(scope)).toMatchObject({ status: 'pending', completedIds: [],
      submissions: { '1:first': { kind: 'direct', hash: HASH } } })
    expect(mocks.authority).toHaveBeenCalledTimes(2)
    // Once the exact original receipt is canonical again, recovery verifies it
    // and only the unsigned second call receives a new wallet request.
    expect((await run()).status).toBe('complete')
    expect(mocks.authority.mock.calls.map(([options]) => options.calls[0].id)).toEqual(['1:first', '1:second', '1:second'])
  })

  it('rechecks earlier receipt blocks before declaring a freshly sent batch complete', async () => {
    mocks.client.getBlock.mockResolvedValueOnce({ hash: BLOCK }).mockResolvedValueOnce({ hash: BLOCK })
      .mockResolvedValueOnce({ hash: HASH })
    await expect(run([call(1, 'first'), call(1, 'second')])).rejects.toThrow('no longer canonical')
    expect(loadProjectBatch(scope)?.status).toBe('pending')
    expect(loadProjectBatch(scope)?.submissions['1:first'].hash).toBe(HASH)
    expect(mocks.authority).toHaveBeenCalledTimes(2)
  })

  it('does not checkpoint a reverted receipt fetched after Relayr authenticated an earlier fork', async () => {
    mocks.client.getTransactionReceipt.mockResolvedValue({ transactionHash: HASH,
      blockHash: BLOCK, blockNumber: 10n, status: 'reverted', logs: [] })
    await expect(run([call(), call(10)])).rejects.toThrow('no longer canonical')
    expect(loadProjectBatch(scope)?.status).toBe('pending')
    expect(mocks.relayr).toHaveBeenCalledTimes(1)
    await expect(run()).rejects.toThrow('no longer canonical')
    expect(mocks.relayr).toHaveBeenCalledTimes(1)
  })

  it('recovers re-mined completed Relayr hashes without publishing another bundle', async () => {
    mocks.authority.mockRejectedValueOnce(new Error('later review interrupted'))
    await expect(run([call(1, 'first'), call(10, 'peer'), call(1, 'later')])).rejects.toThrow('later review interrupted')
    mocks.client.getTransactionReceipt.mockResolvedValue({ transactionHash: HASH,
      blockHash: HASH, blockNumber: 11n, status: 'success', logs: [] })
    mocks.client.getBlock.mockResolvedValue({ hash: HASH })
    mocks.client.getTransaction.mockResolvedValueOnce({ hash: HASH, chainId: 1, blockHash: HASH })
      .mockResolvedValueOnce({ hash: HASH, chainId: 10, blockHash: HASH })
    const result = await run(undefined, { reconcileUnsubmitted: async () => true })
    expect(result.status).toBe('complete')
    expect(result.completionEvidence?.['1:first']).toMatchObject({ blockNumber: 11n, blockHash: HASH })
    expect(mocks.relayr).toHaveBeenCalledTimes(1)
    expect(mocks.authority).toHaveBeenCalledTimes(1)
  })

  it('rechecks keeper skips on resume without treating restored custody as completed', async () => {
    const reconcileUnsubmitted = vi.fn(async (item: ProjectBatchCall) => item.id === '1:first')
    mocks.authority.mockRejectedValueOnce(new Error('second review interrupted'))
    await expect(run([call(1, 'first'), call(1, 'second')], { reconcileUnsubmitted })).rejects.toThrow('second review interrupted')
    reconcileUnsubmitted.mockResolvedValue(false)
    await expect(run(undefined, { reconcileUnsubmitted })).rejects.toThrow('previously resolved payment changed')
    // No wallet request was exposed, so a fresh review can replace this draft.
    expect(loadProjectBatch(scope)).toBeNull()
    expect(mocks.authority).toHaveBeenCalledTimes(1)
  })

  it.each(['different call', 'different hash', 'unavailable'])('keeps a connector proposal pending when authentication yields %s', async condition => {
    mocks.authority.mockImplementationOnce(async ({ calls }) => {
      await calls[0].onSubmitted(HASH, 'safe-connector')
      return { directResults: [], safeResults: [] }
    })
    expect((await run([call()])).status).toBe('pending')
    mocks.waitSafe.mockRejectedValue(new Error('No execution'))
    if (condition === 'unavailable') mocks.readSafe.mockRejectedValue(new Error('Service unavailable'))
    else mocks.readSafe.mockResolvedValue({ safeTxHash: condition === 'different hash' ? BLOCK : HASH,
      nonce: 3, to: TARGET, data: condition === 'different call' ? '0xabcd' : '0x1234', value: '3', operation: 0 })
    const reconcileObsoleteSafe = vi.fn().mockResolvedValue(true)
    if (condition === 'unavailable') await expect(run(undefined, { reconcileObsoleteSafe })).rejects.toThrow('Service unavailable')
    else expect((await run(undefined, { reconcileObsoleteSafe })).status).toBe('pending')
    expect(reconcileObsoleteSafe).not.toHaveBeenCalled()
    expect(loadProjectBatch(scope)?.submissions['1:'].hash).toBe(HASH)
    expect(mocks.authority).toHaveBeenCalledTimes(1)
  })

  it('revokes connector obsolescence if custody reappears before final completion', async () => {
    mocks.authority.mockImplementationOnce(async ({ calls }) => {
      await calls[0].onSubmitted(HASH, 'safe-connector')
      return { directResults: [], safeResults: [] }
    })
    expect((await run([call()])).status).toBe('pending')
    const reconcileObsoleteSafe = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false)
    await expect(run(undefined, { reconcileObsoleteSafe })).rejects.toThrow('previously resolved payment changed')
    expect(loadProjectBatch(scope)).toMatchObject({ status: 'pending', completedIds: [],
      submissions: { '1:': { kind: 'safe', hash: HASH, safeTx: { nonce: 3 } } } })
    expect(mocks.authority).toHaveBeenCalledTimes(1)
  })

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

  it('keeps Relayr-opted-out cross-chain calls direct across durable rounds and receipt recovery', async () => {
    const calls = [call(1, 'a'), call(1, 'b'), call(10, 'a'), call(10, 'b')].map(item => ({ ...item, relayr: false as const }))
    mocks.client.getTransaction.mockImplementation(async () => {
      const submitted = mocks.authority.mock.calls.at(-1)![0].calls[0] as ProjectBatchCall
      return { hash: HASH, chainId: submitted.chainId, from: ACCOUNT, to: TARGET,
        input: submitted.data, value: 3n, blockHash: BLOCK }
    })
    mocks.client.getTransactionReceipt.mockRejectedValueOnce(new Error('receipt timeout'))
    await expect(run(calls)).rejects.toThrow('receipt timeout')
    expect(loadProjectBatch(scope)).toMatchObject({ rounds: [['1:a', '10:a'], ['1:b', '10:b']], completedIds: [] })
    expect(loadProjectBatch(scope)?.calls.every(item => item.relayr === false)).toBe(true)
    const completed = await run()
    expect(completed.status).toBe('complete')
    expect(completed.completedIds).toEqual(['1:a', '10:a', '1:b', '10:b'])
    expect(mocks.relayr).not.toHaveBeenCalled()
    expect(mocks.authority.mock.calls.map(([options]) => options.calls[0].id)).toEqual(['1:a', '10:a', '1:b', '10:b'])
    expect(loadProjectBatch(scope)).toBeNull()
    expect(loadProjectBatch(projectBatchScope(action, 10, 7))).toBeNull()
  })

  it('finishes an unsent later attempt that changed externally after the first receipt', async () => {
    const calls = [call(1, 'first'), call(1, 'changed')].map(item => ({ ...item, relayr: false as const }))
    let changedExternally = false
    const reconcileUnsubmitted = vi.fn(async (item: ProjectBatchCall) => item.id === '1:changed' && changedExternally)
    const verifyCompletion = vi.fn(async () => { changedExternally = true })
    const result = await run(calls, { reconcileUnsubmitted, verifyCompletion })
    expect(result.status).toBe('complete')
    expect(result.completedIds).toEqual(['1:first', '1:changed'])
    expect(mocks.authority).toHaveBeenCalledTimes(1)
    expect(verifyCompletion).toHaveBeenCalledTimes(1)
    expect(loadProjectBatch(scope)).toBeNull()
  })

  it('never reconciles an already submitted later attempt instead of verifying its original receipt', async () => {
    const calls = [call(1, 'first'), call(1, 'submitted')].map(item => ({ ...item, relayr: false as const }))
    mocks.client.getTransactionReceipt.mockResolvedValueOnce({ transactionHash: HASH,
      blockHash: BLOCK, blockNumber: 10n, status: 'success', logs: [] }).mockRejectedValueOnce(new Error('receipt timeout'))
    await expect(run(calls)).rejects.toThrow('receipt timeout')
    expect(loadProjectBatch(scope)?.completedIds).toEqual(['1:first'])
    expect(loadProjectBatch(scope)?.submissions['1:submitted'].hash).toBe(HASH)
    const reconcileUnsubmitted = vi.fn().mockResolvedValue(true)
    const verifyCompletion = vi.fn()
    const result = await run(undefined, { reconcileUnsubmitted, verifyCompletion })
    expect(result.status).toBe('complete')
    expect(reconcileUnsubmitted).not.toHaveBeenCalled()
    expect(verifyCompletion.mock.calls.map(([item]) => item.id)).toEqual(['1:first', '1:submitted'])
    expect(mocks.authority).toHaveBeenCalledTimes(2)
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

  it('finishes an opted-in canonical reverted attempt without replaying it', async () => {
    const verifyCompletion = vi.fn()
    mocks.authority.mockImplementationOnce(async ({ calls }: { calls: ProjectBatchCall[] }) => {
      await calls[0].onSending?.('direct')
      await calls[0].onSubmitted?.(HASH, 'direct')
      throw new Error('Transaction reverted')
    })
    const nextHash = `0x${'ef'.repeat(32)}` as Hex
    mocks.authority.mockImplementationOnce(async ({ calls }) => {
      await calls[0].onSending('direct')
      await calls[0].onSubmitted(nextHash, 'direct')
      return { directResults: [nextHash], safeResults: [] }
    })
    mocks.client.getTransactionReceipt.mockImplementation(async ({ hash }) => ({ transactionHash: hash,
      blockHash: BLOCK, blockNumber: 10n, status: hash === HASH ? 'reverted' : 'success', logs: [] }))
    mocks.client.getTransaction.mockImplementation(async ({ hash }) => ({ hash, chainId: 1,
      from: ACCOUNT, to: TARGET, input: '0x1234', value: 3n, blockHash: BLOCK }))
    const result = await run([call(1, 'failed'), call(1, 'next')], { acceptRevertedTransactions: true, verifyCompletion })
    expect(result.status).toBe('complete')
    expect(verifyCompletion.mock.calls[0][1].status).toBe('reverted')
    expect(verifyCompletion.mock.calls[1][1].status).toBe('success')
    expect(mocks.authority).toHaveBeenCalledTimes(2)
    expect(loadProjectBatch(scope)).toBeNull()
  })

  it('recovers a saved canonical revert only when explicitly opted in', async () => {
    mocks.client.getTransactionReceipt.mockRejectedValueOnce(new Error('receipt timeout'))
    await expect(run([call()])).rejects.toThrow('receipt timeout')
    mocks.client.getTransactionReceipt.mockResolvedValue({ transactionHash: HASH,
      blockHash: BLOCK, blockNumber: 10n, status: 'reverted', logs: [] })
    await expect(run()).rejects.toThrow('not proven successful')
    const verifyCompletion = vi.fn()
    expect((await run(undefined, { acceptRevertedTransactions: true, verifyCompletion })).status).toBe('complete')
    expect(verifyCompletion.mock.calls[0][1].status).toBe('reverted')
    expect(mocks.authority).toHaveBeenCalledTimes(1)
  })

  it.each(['identity', 'canonical block', 'unknown receipt'])('keeps reverted recovery when %s is unproven', async failure => {
    mocks.client.getTransactionReceipt.mockRejectedValueOnce(new Error('receipt timeout'))
    await expect(run([call()])).rejects.toThrow('receipt timeout')
    mocks.client.getTransactionReceipt.mockResolvedValue({ transactionHash: HASH,
      blockHash: BLOCK, blockNumber: 10n, status: 'reverted', logs: [] })
    if (failure === 'identity') mocks.client.getTransaction.mockResolvedValue({ hash: HASH, chainId: 1, from: TARGET, to: TARGET, input: '0x1234', value: 3n, blockHash: BLOCK })
    if (failure === 'canonical block') mocks.client.getBlock.mockResolvedValue({ hash: HASH })
    if (failure === 'unknown receipt') mocks.client.getTransactionReceipt.mockRejectedValue(new Error('receipt timeout'))
    const verifyCompletion = vi.fn()
    await expect(run(undefined, { acceptRevertedTransactions: true, verifyCompletion })).rejects.toThrow()
    expect(verifyCompletion).not.toHaveBeenCalled()
    expect(loadProjectBatch(scope)?.status).toBe('pending')
    expect(mocks.authority).toHaveBeenCalledTimes(1)
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
    expect((await run()).status).toBe('pending')
    expect(loadProjectBatch(scope)?.submissions[call().id].hash).toBe(HASH)
    expect(mocks.authority).toHaveBeenCalledTimes(1)
  })

  it('marks a proven obsolete Safe proposal without claiming execution or discarding its nonce/hash', async () => {
    const safeTx = { safeTxHash: HASH, nonce: 3, to: TARGET, data: '0x1234', value: '3', operation: 0 }
    mocks.authority.mockImplementationOnce(async ({ calls }) => {
      await calls[0].onSafePrepared(safeTx)
      return { directResults: [], safeResults: [{ status: 'queued', safeTxHash: HASH }], relayrGroups: 0, relayrResults: [] }
    })
    expect((await run([call()])).status).toBe('pending')
    const reconcileObsoleteSafe = vi.fn().mockResolvedValue(true)
    const verifyCompletion = vi.fn()
    const result = await run(undefined, { reconcileObsoleteSafe, verifyCompletion })
    expect(result.status).toBe('complete')
    expect(result.submissions['1:']).toMatchObject({ hash: HASH, safeTx: { nonce: 3, safeTxHash: HASH } })
    expect(reconcileObsoleteSafe).toHaveBeenCalledTimes(2)
    expect(verifyCompletion).not.toHaveBeenCalled()
    expect(mocks.authority).toHaveBeenCalledTimes(1)
  })

  it.each(['still pending', 'different proposal', 'different hash'])('keeps a Safe proposal when %s', async condition => {
    const safeTx = { safeTxHash: HASH, nonce: 3, to: TARGET, data: condition === 'different proposal' ? '0xabcd' : '0x1234', value: '3', operation: 0 }
    mocks.authority.mockImplementationOnce(async ({ calls }) => {
      await calls[0].onSafePrepared(safeTx)
      return { directResults: [], safeResults: [{ status: 'queued', safeTxHash: HASH }], relayrGroups: 0, relayrResults: [] }
    })
    expect((await run([call()])).status).toBe('pending')
    if (condition === 'different hash') {
      const saved = loadProjectBatch(scope)!
      const key = `jb-project-batch:v1:journal:${saved.id}`
      const journal = JSON.parse(window.localStorage.getItem(key)!)
      journal.submissions['1:'].safeTx.safeTxHash = BLOCK
      window.localStorage.setItem(key, JSON.stringify(journal))
    }
    const reconcileObsoleteSafe = vi.fn().mockResolvedValue(condition !== 'still pending')
    const reverify = vi.fn().mockRejectedValue(new Error('payment changed'))
    expect((await run(undefined, { reconcileObsoleteSafe, reverify })).status).toBe('pending')
    expect(reverify).not.toHaveBeenCalled()
    expect(loadProjectBatch(scope)?.status).toBe('pending')
    expect(reconcileObsoleteSafe).toHaveBeenCalledTimes(condition === 'still pending' ? 1 : 0)
    expect(mocks.authority).toHaveBeenCalledTimes(1)
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

  it.each(['signer', 'connector', 'legacy connector'])('uses the same pending and executed recovery for %s proposals', async transport => {
    const proposal = { safeTxHash: HASH, nonce: 3, to: TARGET, data: '0x1234', value: '3', operation: 0 }
    mocks.authority.mockImplementationOnce(async ({ calls }) => {
      if (transport === 'signer') await calls[0].onSafePrepared(proposal)
      else await calls[0].onSubmitted(HASH, 'safe-connector')
      return { directResults: [], safeResults: [] }
    })
    const initial = await run([call()])
    const key = `jb-project-batch:v1:journal:${initial.id}`
    if (transport === 'legacy connector') {
      const raw = JSON.parse(window.localStorage.getItem(key)!)
      raw.submissions['1:'].kind = 'safe-connector'
      window.localStorage.setItem(key, JSON.stringify(raw))
    }
    const reverify = vi.fn().mockRejectedValue(new Error('Recovery must not prepare another call'))
    mocks.waitSafe.mockRejectedValue(new Error('Execution pending'))
    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await run(undefined, { reverify })).status).toBe('pending')
    }
    expect(loadProjectBatch(scope)?.submissions['1:']).toMatchObject({ kind: 'safe', hash: HASH, fromBlock: 10n })
    expect(JSON.parse(window.localStorage.getItem(key)!).submissions['1:'].kind).toBe('safe')
    mocks.waitSafe.mockResolvedValue(HASH)
    mocks.safeSuccess.mockReturnValue(true)
    expect((await run(undefined, { reverify })).status).toBe('complete')
    expect(mocks.waitSafe).toHaveBeenLastCalledWith(1, HASH, { signal: expect.any(AbortSignal) })
    expect(reverify).not.toHaveBeenCalled()
    expect(mocks.authority).toHaveBeenCalledTimes(1)
  })

  it('migrates an interrupted legacy connector marker without clearing its unknown submission', async () => {
    mocks.authority.mockImplementationOnce(async ({ calls }) => {
      await calls[0].onSending('safe-connector')
      throw new Error('Wallet response lost')
    })
    await expect(run([call()])).rejects.toThrow('Wallet response lost')
    const saved = loadProjectBatch(scope)!
    const key = `jb-project-batch:v1:journal:${saved.id}`
    const raw = JSON.parse(window.localStorage.getItem(key)!)
    raw.submissions['1:'].kind = 'safe-connector'
    window.localStorage.setItem(key, JSON.stringify(raw))
    await expect(run()).rejects.toThrow('wallet submission may still be pending')
    expect(loadProjectBatch(scope)?.submissions['1:']).toEqual({ kind: 'safe', fromBlock: 10n })
    expect(mocks.authority).toHaveBeenCalledTimes(1)
    expect(mocks.waitSafe).not.toHaveBeenCalled()
    expect(mocks.readSafe).not.toHaveBeenCalled()
  })

  it.each([true, false])('authenticates a service execution candidate after log lookup fails: %s', async authentic => {
    mocks.authority.mockImplementationOnce(async ({ calls }) => {
      await calls[0].onSafePrepared({ safeTxHash: HASH, nonce: 3, to: TARGET, data: '0x1234', value: '3', operation: 0 })
      return { directResults: [], safeResults: [] }
    })
    expect((await run([call()])).status).toBe('pending')
    mocks.client.getLogs.mockRejectedValue(new Error('Log lookup unavailable'))
    mocks.waitSafe.mockResolvedValue(HASH)
    mocks.safeSuccess.mockReturnValue(authentic)
    if (authentic) expect((await run()).status).toBe('complete')
    else {
      await expect(run()).rejects.toThrow('exact saved Safe proposal')
      expect(loadProjectBatch(scope)?.submissions['1:'].hash).toBe(HASH)
    }
    expect(mocks.authority).toHaveBeenCalledTimes(1)
  })

  it('preserves legacy connector completion evidence and migrates it without replay', async () => {
    mocks.safeSuccess.mockReturnValue(true)
    mocks.authority.mockImplementationOnce(async ({ calls }) => {
      await calls[0].onSubmitted(HASH, 'safe-connector')
      return { directResults: [HASH], safeResults: [] }
    }).mockRejectedValueOnce(new Error('Later review closed'))
    await expect(run([call(1, 'first'), call(1, 'next')])).rejects.toThrow('Later review closed')
    const saved = loadProjectBatch(scope)!
    const key = `jb-project-batch:v1:journal:${saved.id}`
    const raw = JSON.parse(window.localStorage.getItem(key)!)
    raw.submissions['1:first'].kind = 'safe-connector'
    window.localStorage.setItem(key, JSON.stringify(raw))
    expect(loadProjectBatch(scope)?.completionEvidence).toEqual(saved.completionEvidence)
    const result = await run(undefined, { reconcileUnsubmitted: async () => true })
    expect(result.status).toBe('complete')
    expect(result.submissions['1:first']).toMatchObject({ kind: 'safe', hash: HASH, fromBlock: 10n })
    expect(mocks.authority).toHaveBeenCalledTimes(2)
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
