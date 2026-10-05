import { beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeFunctionData, toEventSelector, zeroAddress, type Address, type Hex } from 'viem'
import {
  SAFE_EXEC_ABI,
  safeProposalFor,
  safeTransactionHash,
} from '@bananapus/nana-sdk-core/safe-service'

const mocks = vi.hoisted(() => ({
  account: '0x1111111111111111111111111111111111111111',
  safe: false,
  relayr: vi.fn(), authority: vi.fn(), identity: vi.fn(), review: vi.fn(), waitForExecution: vi.fn(),
  readRecord: vi.fn(),
  client: { getTransaction: vi.fn(), getTransactionReceipt: vi.fn(), getBlock: vi.fn(),
    getBlockNumber: vi.fn(), getLogs: vi.fn() },
  pending: new Map<string, unknown>(),
}))
vi.mock('@wagmi/core', () => ({ getAccount: () => ({ address: mocks.account }) }))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/lib/authority', () => ({ clientFor: () => mocks.client, runAuthorityCalls: mocks.authority }))
vi.mock('@bananapus/nana-sdk-core/safe', async importOriginal => ({
  ...(await importOriginal<typeof import('@bananapus/nana-sdk-core/safe')>()),
  readAuthorityIdentity: mocks.identity,
}))
vi.mock('@/lib/safe-connector', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/safe-connector')>()),
  isSafeConnection: () => mocks.safe,
  SAFE_NONCE_GUIDANCE: 'Choose the Safe nonce.',
  waitForSafeExecutionHash: mocks.waitForExecution,
}))
vi.mock('@bananapus/nana-sdk-core/safe-service', async importOriginal => ({
  ...(await importOriginal<typeof import('@bananapus/nana-sdk-core/safe-service')>()),
  readSafeTransaction: mocks.readRecord,
}))
vi.mock('@/lib/transaction-review', () => ({ requireTransactionReview: mocks.review }))
vi.mock('@/lib/viewAs', () => ({ assertNoViewAs: () => {} }))
vi.mock('@/lib/relayr', () => ({
  loadRelayrPendingSession: (scope: string) => mocks.pending.get(scope) ?? null,
  relayrTargetSupportsForwarder: async () => true,
  runRelayrCalls: mocks.relayr,
  withRelayrScopeLock: async (_scope: string, run: () => Promise<unknown>) => run(),
  relayrDestinationHash: (record: { hash: string }) => record.hash,
  relayrRecordChain: (record: { chain: number }) => record.chain,
}))

import { loadProjectBatch, projectBatchRounds, projectBatchScope, runProjectBatch,
  type ProjectBatchCall } from '@/lib/project-batch'

const ACCOUNT = mocks.account as Address
const TARGET = '0x2222222222222222222222222222222222222222' as Address
const HASH = `0x${'ab'.repeat(32)}` as Hex
const BLOCK = `0x${'cd'.repeat(32)}` as Hex
const SUCCESS_TOPIC = toEventSelector('ExecutionSuccess(bytes32,uint256)')
/** The Safe's ExecutionSuccess for `safeTxHash`, in the transaction `transactionHash`. */
const executionSuccess = (safeTxHash: Hex, transactionHash: Hex) => ({
  address: ACCOUNT, topics: [SUCCESS_TOPIC, safeTxHash], data: `0x${'00'.repeat(32)}`, transactionHash,
})
/** The Safe's execTransaction of one call, as an owner sends it. */
const execTransaction = (data: Hex = '0x1234') => encodeFunctionData({
  abi: SAFE_EXEC_ABI, functionName: 'execTransaction',
  args: [TARGET, 3n, data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, '0x'],
})
/** The queued proposal of call() at `nonce`, with its real hash. */
const proposal = (nonce = 3, data: Hex = '0x1234') => {
  const tx = safeProposalFor({ to: TARGET, data, value: 3n }, nonce)
  return { ...tx, safeTxHash: safeTransactionHash(1, ACCOUNT, tx) }
}
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
  mocks.safe = false
  const storage = new Map<string, string>()
  vi.stubGlobal('window', { localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  } })
  vi.stubGlobal('navigator', { locks: {} })
  mocks.identity.mockResolvedValue({ kind: 'eoa' })
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
    expect(verifyCompletion).toHaveBeenCalledTimes(1)
    expect(verifyCompletion.mock.calls[0][0].id).toBe('1:submitted')
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
    mocks.client.getTransactionReceipt.mockResolvedValueOnce({ transactionHash: HASH,
      blockHash: BLOCK, blockNumber: 10n, status: 'reverted', logs: [] })
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

  it('wallet-action:resume-a-reviewed-project-batch resumes an already paid round without rebuilding or revalidating stale source state', async () => {
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

  it('wallet-action:distribute-payouts wallet-action:distribute-reserved-tokens keeps successful receipts pending when application events report a failed distribution', async () => {
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
    const safeTx = proposal(3)
    mocks.authority.mockImplementation(async ({ calls }) => {
      await calls[0].onSafePrepared(safeTx)
      return { directResults: [], safeResults: [{ status: 'queued', safeTxHash: safeTx.safeTxHash }], relayrGroups: 0, relayrResults: [] }
    })
    const first = await run([call()])
    expect(first.status).toBe('pending')
    expect(first.completedIds).toEqual([])
    mocks.authority.mockImplementationOnce(async ({ calls }) => {
      await calls[0].onSafePrepared(proposal(4))
    })
    await expect(run()).rejects.toThrow('Safe nonce changed')
    expect(loadProjectBatch(scope)?.submissions[call().id].hash).toBe(safeTx.safeTxHash)
  })

  it('marks a proven obsolete Safe proposal without claiming execution or discarding its nonce/hash', async () => {
    const safeTx = proposal(3)
    mocks.authority.mockImplementationOnce(async ({ calls }) => {
      await calls[0].onSafePrepared(safeTx)
      return { directResults: [], safeResults: [{ status: 'queued', safeTxHash: safeTx.safeTxHash }], relayrGroups: 0, relayrResults: [] }
    })
    expect((await run([call()])).status).toBe('pending')
    const reconcileObsoleteSafe = vi.fn().mockResolvedValue(true)
    const verifyCompletion = vi.fn()
    const result = await run(undefined, { reconcileObsoleteSafe, verifyCompletion })
    expect(result.status).toBe('complete')
    expect(result.submissions['1:']).toMatchObject({
      hash: safeTx.safeTxHash,
      safeTx: { nonce: 3, safeTxHash: safeTx.safeTxHash },
    })
    expect(reconcileObsoleteSafe).toHaveBeenCalledTimes(1)
    expect(verifyCompletion).not.toHaveBeenCalled()
    expect(mocks.authority).toHaveBeenCalledTimes(1)
  })

  it.each(['still pending', 'different proposal', 'different hash'])('keeps a Safe proposal when %s', async condition => {
    const safeTx = proposal(3, condition === 'different proposal' ? '0xabcd' : '0x1234')
    mocks.authority.mockImplementationOnce(async ({ calls }) => {
      await calls[0].onSafePrepared(safeTx)
      return { directResults: [], safeResults: [{ status: 'queued', safeTxHash: safeTx.safeTxHash }], relayrGroups: 0, relayrResults: [] }
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
    // A saved proposal whose fields no longer hash to its hash is refused outright.
    await expect(run(undefined, { reconcileObsoleteSafe, reverify: vi.fn().mockRejectedValue(new Error('payment changed')) })).rejects.toThrow(
      condition === 'different hash' ? /does not match its fields/ : /payment changed/,
    )
    expect(loadProjectBatch(scope)?.status).toBe('pending')
    expect(reconcileObsoleteSafe).toHaveBeenCalledTimes(condition === 'still pending' ? 1 : 0)
    expect(mocks.authority).toHaveBeenCalledTimes(1)
  })

  /** A Safe app call whose wallet returned `returned`, then lost track of it before its receipt. */
  async function interruptedConnectorCall(returned: Hex) {
    mocks.authority.mockImplementationOnce(async ({ calls }) => {
      await calls[0].onSending('safe-connector')
      await calls[0].onSubmitted(returned, 'safe-connector')
      throw new Error('Safe service unavailable')
    })
    await expect(run([call()])).rejects.toThrow('Safe service unavailable')
    expect(loadProjectBatch(scope)?.submissions[call().id].fromBlock).toBe(10n)
  }
  /** The chain's view of the execution `hash`: an owner's execTransaction to the Safe. */
  function executedBy(hash: Hex, input: Hex, logs: unknown[], chainId = 1) {
    mocks.client.getTransaction.mockResolvedValue({ hash, chainId, from: TARGET, to: ACCOUNT,
      input, value: 0n, blockHash: BLOCK })
    mocks.client.getTransactionReceipt.mockResolvedValue({ transactionHash: hash,
      blockHash: BLOCK, blockNumber: 10n, status: 'success', logs })
  }
  const SAFE_TX = `0x${'ef'.repeat(32)}` as Hex
  const FAILED = 'The saved Safe proposal failed onchain. Review it again.'
  /** The Safe's ExecutionFailure for `safeTxHash`, in the transaction `transactionHash`. */
  const executionFailure = (safeTxHash: Hex, transactionHash: Hex) => ({
    ...executionSuccess(safeTxHash, transactionHash),
    topics: [toEventSelector('ExecutionFailure(bytes32,uint256)'), safeTxHash],
  })

  it('finds a connector execution from canonical Safe logs without a hosted service', async () => {
    // The Safe app returned its proposal's safeTxHash; an owner executed it later.
    await interruptedConnectorCall(SAFE_TX)
    const success = executionSuccess(SAFE_TX, HASH)
    mocks.client.getBlockNumber.mockResolvedValueOnce(11n)
    mocks.client.getLogs.mockResolvedValueOnce([success])
    executedBy(HASH, execTransaction(), [success])
    expect((await run()).status).toBe('complete')
    expect(mocks.client.getLogs).toHaveBeenCalledWith({ address: ACCOUNT, fromBlock: 10n, toBlock: 11n })
    expect(mocks.waitForExecution).not.toHaveBeenCalled()
    expect(mocks.authority).toHaveBeenCalledTimes(1)
  })

  it('scans for a later execution in windows the RPC accepts, and resumes a long scan where it stopped', async () => {
    await interruptedConnectorCall(SAFE_TX)
    // JB Center's RPC refuses an eth_getLogs range over 500 blocks.
    mocks.client.getLogs.mockImplementation(async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      if (toBlock - fromBlock + 1n > 500n) throw new Error('Block range exceeds the 500 block limit (-32005)')
      return toBlock >= 60_000n && fromBlock <= 60_000n ? [executionSuccess(SAFE_TX, HASH)] : []
    })
    mocks.client.getBlockNumber.mockResolvedValue(60_100n)
    mocks.waitForExecution.mockRejectedValue(new DOMException('Safe execution wait aborted', 'AbortError'))
    executedBy(HASH, execTransaction(), [executionSuccess(SAFE_TX, HASH)])

    // One look scans at most 100 windows (50,000 blocks) from where the last stopped.
    expect((await run()).status).toBe('pending')
    expect(mocks.client.getLogs).toHaveBeenCalledTimes(100)
    expect(mocks.client.getLogs.mock.calls.every(([range]) => range.toBlock - range.fromBlock < 500n)).toBe(true)
    expect(loadProjectBatch(scope)?.submissions[call().id]).toMatchObject({ scannedTo: 50_009n })

    expect((await run()).status).toBe('complete')
    expect(mocks.client.getLogs.mock.calls[100][0]).toMatchObject({ fromBlock: 50_010n, toBlock: 50_509n })
    expect(mocks.authority).toHaveBeenCalledTimes(1)
  })

  it('recovers an execution Safe{Wallet} returned at once only when it ran the saved call', async () => {
    // Safe{Wallet} executed at once and returned the execution's own hash; the
    // Safe's ExecutionSuccess names its safeTxHash, which the app never saw.
    await interruptedConnectorCall(HASH)
    const success = executionSuccess(SAFE_TX, HASH)
    mocks.client.getLogs.mockResolvedValue([success])
    mocks.waitForExecution.mockResolvedValue(HASH)
    executedBy(HASH, execTransaction(), [success])
    expect((await run()).status).toBe('complete')
    expect(mocks.waitForExecution).toHaveBeenCalledWith(1, HASH, expect.anything())
    expect(mocks.authority).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['ran another call', () => executedBy(HASH, execTransaction('0xdead'), [executionSuccess(SAFE_TX, HASH)]),
      'Safe proposal submitted, but confirmation is unavailable. Check Safe before taking another action.'],
    ['cannot be read as an execution', () => executedBy(HASH, '0xdeadbeef', [executionSuccess(SAFE_TX, HASH)]),
      'Safe proposal submitted, but confirmation is unavailable. Check Safe before taking another action.'],
    ['ran the call, and it failed', () => executedBy(HASH, execTransaction(), [executionFailure(SAFE_TX, HASH)]),
      FAILED],
    ['reverted', () => {
      executedBy(HASH, execTransaction(), [])
      mocks.client.getTransactionReceipt.mockResolvedValue({ transactionHash: HASH,
        blockHash: BLOCK, blockNumber: 10n, status: 'reverted', logs: [] })
    }, FAILED],
  ] as const)('releases a saved call whose execution %s, so it never holds the batch', async (_, executed, line) => {
    await interruptedConnectorCall(HASH)
    mocks.waitForExecution.mockResolvedValue(HASH)
    executed()
    await expect(run()).rejects.toThrow(line)
    // The call is no longer held as submitted: with nothing else in flight,
    // no saved batch holds it, in this tab or after a reload.
    expect(loadProjectBatch(scope)).toBeNull()

    // Once Safe has been checked, the same call can be reviewed and sent again.
    mocks.client.getTransaction.mockResolvedValue({ hash: HASH, chainId: 1, from: ACCOUNT,
      to: TARGET, input: '0x1234', value: 3n, blockHash: BLOCK })
    mocks.client.getTransactionReceipt.mockResolvedValue({ transactionHash: HASH,
      blockHash: BLOCK, blockNumber: 10n, status: 'success', logs: [] })
    expect((await run([call()])).status).toBe('complete')
    expect(mocks.authority).toHaveBeenCalledTimes(2)
  })

  it('finds a proposal executed later whose call failed, and releases it', async () => {
    await interruptedConnectorCall(SAFE_TX)
    const failure = executionFailure(SAFE_TX, HASH)
    mocks.client.getBlockNumber.mockResolvedValueOnce(11n)
    mocks.client.getLogs.mockResolvedValueOnce([failure])
    // The service would report it failed; the chain already shows it.
    mocks.waitForExecution.mockRejectedValue(new DOMException('Safe execution wait aborted', 'AbortError'))
    executedBy(HASH, execTransaction(), [failure])
    await expect(run()).rejects.toThrow(FAILED)
    expect(loadProjectBatch(scope)).toBeNull()
  })

  it("releases a proposal Safe's service reports executed and failed, once its own receipt shows the failure", async () => {
    await interruptedConnectorCall(SAFE_TX)
    mocks.waitForExecution.mockRejectedValue(
      new Error('Safe executed the proposal, but the onchain transaction failed.'),
    )
    mocks.readRecord.mockResolvedValue({ safeTxHash: SAFE_TX, isExecuted: true, transactionHash: HASH })
    executedBy(HASH, execTransaction(), [executionFailure(SAFE_TX, HASH)])
    await expect(run()).rejects.toThrow(FAILED)
    expect(mocks.readRecord).toHaveBeenCalledWith(1, ACCOUNT, SAFE_TX, expect.anything())
    expect(loadProjectBatch(scope)).toBeNull()
  })

  it.each([
    ['names no transaction', () => mocks.readRecord.mockResolvedValue({ safeTxHash: SAFE_TX, isExecuted: true })],
    ['cannot be read', () => mocks.readRecord.mockRejectedValue(new Error('Safe service unavailable'))],
    ['names a receipt that is not canonical', () => {
      mocks.readRecord.mockResolvedValue({ safeTxHash: SAFE_TX, isExecuted: true, transactionHash: HASH })
      executedBy(HASH, execTransaction(), [executionFailure(SAFE_TX, HASH)])
      mocks.client.getBlock.mockResolvedValue({ hash: `0x${'99'.repeat(32)}` })
    }],
  ] as const)("keeps a proposal the service reports failed while its record %s", async (_, setup) => {
    await interruptedConnectorCall(SAFE_TX)
    mocks.waitForExecution.mockRejectedValue(
      new Error('Safe executed the proposal, but the onchain transaction failed.'),
    )
    setup()
    await run().catch(() => undefined)
    expect(loadProjectBatch(scope)?.submissions[call().id]).toMatchObject({ kind: 'safe-connector', hash: SAFE_TX })
  })

  it('keeps a saved Safe call while the receipt that would release it is not canonical', async () => {
    await interruptedConnectorCall(HASH)
    mocks.waitForExecution.mockResolvedValue(HASH)
    executedBy(HASH, execTransaction('0xdead'), [executionSuccess(SAFE_TX, HASH)])
    mocks.client.getBlock.mockResolvedValue({ hash: `0x${'99'.repeat(32)}` })
    await expect(run()).rejects.toThrow('The original project receipt is no longer canonical. Check it again before continuing.')
    expect(loadProjectBatch(scope)?.submissions[call().id]).toMatchObject({ kind: 'safe-connector', hash: HASH })
  })

  it('keeps the rest of a batch when it releases one saved Safe call', async () => {
    const calls = [call(1, 'a'), call(10, 'b')].map(item => ({ ...item, relayr: false as const }))
    mocks.authority.mockImplementationOnce(async ({ calls: [first] }) => {
      await first.onSending('direct')
      await first.onSubmitted(HASH, 'direct')
      return { directResults: [HASH], safeResults: [], relayrGroups: 0, relayrResults: [] }
    }).mockImplementationOnce(async ({ calls: [second] }) => {
      await second.onSending('safe-connector')
      await second.onSubmitted(SAFE_TX, 'safe-connector')
      throw new Error('Safe service unavailable')
    })
    await expect(run(calls)).rejects.toThrow('Safe service unavailable')
    expect(loadProjectBatch(scope)?.completedIds).toEqual(['1:a'])

    // The Safe app's proposal turns out to have run another call.
    mocks.waitForExecution.mockResolvedValue(SAFE_TX)
    executedBy(SAFE_TX, execTransaction('0xdead'), [executionSuccess(SAFE_TX, SAFE_TX)], 10)
    await expect(run()).rejects.toThrow(
      'Safe proposal submitted, but confirmation is unavailable. Check Safe before taking another action.',
    )
    expect(loadProjectBatch(scope)).toMatchObject({ status: 'pending', completedIds: ['1:a'] })
    expect(loadProjectBatch(scope)?.submissions['10:b']).toBeUndefined()
    expect(loadProjectBatch(scope)?.submissions['1:a']).toBeDefined()
  })

  it('lets the batch review cover each send, but reviews a resumed batch’s sends again', async () => {
    const send = mocks.authority.getMockImplementation()!
    mocks.authority.mockImplementationOnce(send).mockImplementationOnce(async ({ calls }) => {
      await calls[0].onSending('direct')
      throw Object.assign(new Error('User rejected'), { code: 4001 })
    })
    const calls = [call(1, 'first'), call(1, 'second')].map(item => ({ ...item, relayr: false as const, gas: 500_000n }))
    await expect(run(calls)).rejects.toThrow('User rejected')
    expect(mocks.review).toHaveBeenCalledTimes(1)
    // The builder's gas cap is not the gas limit the wallet is sent.
    expect(mocks.review.mock.calls[0][0].calls).toEqual(calls.map(() => expect.not.objectContaining({ gas: expect.anything() })))
    expect((await run()).status).toBe('complete')
    expect(mocks.review).toHaveBeenCalledTimes(1)
    expect(mocks.authority.mock.calls.map(([options]) => [options.calls[0].id, options.reviewedInParent]))
      .toEqual([['1:first', true], ['1:second', true], ['1:second', false]])
  })

  it('shows a Safe batch with Safe gas 0 and the Safe nonce guidance', async () => {
    mocks.safe = true
    expect((await run([call()], { title: 'Distribute' })).status).toBe('complete')
    expect(mocks.review).toHaveBeenCalledExactlyOnceWith({
      title: 'Distribute',
      description: 'Review each destination and its amounts. Later calls on the same chain wait for earlier calls to finish. Choose the Safe nonce.',
      confirmLabel: 'Agree & continue to Safe',
      calls: [expect.objectContaining({ chainId: 1, from: ACCOUNT, to: TARGET, data: '0x1234', value: 3n, safeTxGas: 0n })],
    })
    expect(mocks.authority.mock.calls[0][0].reviewedInParent).toBe(true)
  })

  it('reviews a send again when the connection changed after the batch review', async () => {
    mocks.review.mockImplementationOnce(async () => { mocks.safe = true })
    await run([call()])
    expect(mocks.review.mock.calls[0][0].calls[0]).not.toHaveProperty('safeTxGas')
    expect(mocks.authority.mock.calls[0][0].reviewedInParent).toBe(false)
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
