// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeFunctionData, erc20Abi, TransactionNotFoundError, type Address, type Hex } from 'viem'
import { createBrowserWriteRecovery, createHeldWriteStorage, findReviewedSequence } from '@bananapus/nana-sdk-core/review'
// Use the installed serializer to construct legacy fixtures, not a copy of its storage format.
import { readReviewedSequence, saveReviewedSequence, type ReviewedSequenceRecord } from '../../node_modules/@bananapus/nana-sdk-core/dist/esm/review/sequence.js'
import { clearDefifaWriteRecovery, defifaSequenceCalls, defifaSequenceScope, defifaWriteNamespace, finishDefifaSequence, readDefifaWriteRecovery, runRecoverableDefifaWrite } from '@/lib/defifa-write-recovery'
import { writeHolds } from '@/lib/write-holds'
import { reviewedCall, type TxRequest } from '@/lib/reviewed-call'
import type { ReviewedRun } from '@/hooks/useReviewedAction'

const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address
const TOKEN = '0x2222222222222222222222222222222222222222' as Address
const TARGET = '0x3333333333333333333333333333333333333333' as Address
const HASH = `0x${'a'.repeat(64)}` as Hex
const scope = { chainId: 8453, projectId: 27, account: ACCOUNT, action: 'pay' as const }
const request: TxRequest = { chainId: 8453, address: TOKEN, abi: erc20Abi, functionName: 'approve', args: [TARGET, 7n] }

beforeEach(() => {
  localStorage.clear()
  const held = new Set<string>()
  vi.stubGlobal('navigator', { locks: { request: async (key: string, _: unknown, run: (lock: object | null) => Promise<unknown>) => {
    if (held.has(key)) return run(null)
    held.add(key)
    try { return await run({ name: key }) } finally { held.delete(key) }
  } } })
})
afterEach(() => localStorage.clear())

describe('Defifa writes held by the SDK hold of their namespace', () => {
  const call = { to: TOKEN, data: encodeFunctionData(request), value: 0n }
  /** The record an earlier visit saved: reserved and given its hash, nothing more. */
  async function saved(safe = false) {
    const journal = createBrowserWriteRecovery({ chainId: 8453, account: ACCOUNT, safe, namespace: 'defifa:pay:27', call }, { storage: createHeldWriteStorage() })
    await journal.withLock(async () => { journal.submitted(HASH, journal.reserve()) })
    return readDefifaWriteRecovery(scope)!
  }

  it('keeps a Safe proposal row saved before the write hold from being sent again without the explicit exit', async () => {
    await saved(true)
    const run = vi.fn()
    await expect(runRecoverableDefifaWrite({ scope, action: { account: ACCOUNT, calls: [reviewedCall(request)] }, run })).rejects.toThrow()
    expect(run).not.toHaveBeenCalled()
    // The hold of its namespace says what is held, with no exit while the proposal can still run.
    const client = { getChainId: async () => 8453, getTransactionReceipt: async () => null, getTransaction: async ({ hash }: { hash: Hex }) => { throw new TransactionNotFoundError({ hash }) } }
    const state = await writeHolds.open({ chainId: 8453, account: ACCOUNT, safe: true, namespace: defifaWriteNamespace(scope), call }).state(client as never)
    expect(state).toMatchObject({ status: 'pending-known-hash', exit: false })
  })

  it('refuses mismatched reviewed scope before reserving or exposing a wallet', async () => {
    const run = vi.fn()
    await expect(runRecoverableDefifaWrite({ scope, action: { account: ACCOUNT, calls: [reviewedCall({ ...request, chainId: 1 })] }, run })).rejects.toThrow('reviewed account and network')
    await expect(runRecoverableDefifaWrite({ scope, action: { account: TOKEN, calls: [reviewedCall(request)] }, run })).rejects.toThrow('reviewed account and network')
    await expect(runRecoverableDefifaWrite({ scope, action: { account: ACCOUNT, calls: [reviewedCall(request), reviewedCall({ ...request, chainId: 1 })] }, run })).rejects.toThrow('reviewed account and network')
    await expect(runRecoverableDefifaWrite({ scope, action: { account: ACCOUNT, calls: [] }, run })).rejects.toThrow('reviewed account and network')
    expect(run).not.toHaveBeenCalled()
    expect(readDefifaWriteRecovery(scope)).toBeNull()
  })

  it("sends under the hold of the action's namespace, one for approval and mint, another per project", async () => {
    const run = vi.fn(async (action: ReviewedRun) => {
      await action.beforeWallet?.(action.calls[0], 0)
      return { status: 'done' as const, hashes: [HASH], receipts: [] }
    })
    const action = (chainId: number): ReviewedRun => ({ account: ACCOUNT, calls: [reviewedCall({ ...request, chainId })] })
    await runRecoverableDefifaWrite({ scope, action: action(8453), run })
    await runRecoverableDefifaWrite({ scope: { ...scope, projectId: 46 }, action: action(8453), run })
    expect(run.mock.calls.map(([sent]) => sent.calls[0].intent)).toEqual(['defifa:pay:27', 'defifa:pay:46'])
  })

  it('holds an approval step by its own key, the action by the namespace, and saves them as one sequence', async () => {
    const onRecord = vi.fn()
    const run = vi.fn(async (action: ReviewedRun) => {
      // The approval step tells the card nothing: only the action's record is the recovery record.
      await action.beforeWallet?.(action.calls[0], 0)
      await action.onSubmitted?.(action.calls[0], 0, HASH, { safe: false, adopted: false })
      return { status: 'done' as const, hashes: [HASH, HASH], receipts: [] }
    })
    const approval = reviewedCall(request, { intent: 'approval-key' })
    await runRecoverableDefifaWrite({ scope, onRecord, action: { account: ACCOUNT, calls: [approval, reviewedCall(request, { dependsOnPrior: true })] }, run })
    const [sent] = run.mock.calls[0]
    expect(sent.calls.map(one => one.intent)).toEqual(['approval-key', 'defifa:pay:27'])
    expect(sent.scope).toBe('defifa:pay:27:chain-8453')
    expect(onRecord.mock.calls.every(([record]) => record === null)).toBe(true)
  })

  it('passes the onUnsent callback through, and tells the card nothing is held', async () => {
    const onUnsent = vi.fn()
    const onRecord = vi.fn()
    await runRecoverableDefifaWrite({
      scope, onRecord,
      action: { account: ACCOUNT, calls: [reviewedCall(request)], onUnsent },
      run: async action => {
        await action.beforeWallet?.(action.calls[0], 0)
        await action.onUnsent?.(action.calls[0], 0)
        return null
      },
    })
    expect(onUnsent).toHaveBeenCalledOnce()
    expect(onRecord).toHaveBeenLastCalledWith(null)
  })

  it('keeps a sent action pending after the hold settles it, until its effects are verified', async () => {
    let held: ReturnType<typeof createBrowserWriteRecovery> | undefined
    const result = await runRecoverableDefifaWrite({
      scope,
      action: { account: ACCOUNT, calls: [reviewedCall(request)] },
      run: async action => {
        // The hold reserves the write before the wallet, then settles it with its receipt.
        held = createBrowserWriteRecovery({ chainId: 8453, account: ACCOUNT, safe: false, namespace: 'defifa:pay:27', call }, { storage: createHeldWriteStorage() })
        await held.withLock(async () => { held!.reserve() })
        await action.beforeWallet?.(action.calls[0], 0)
        await action.onSubmitted?.(action.calls[0], 0, HASH, { safe: false, adopted: false })
        await held.withLock(async () => { held!.clear(held!.read()!) })
        return { status: 'done' as const, hashes: [HASH], receipts: [] }
      },
    })
    expect(result?.status).toBe('done')
    // A reload before the NFT check: the action is still pending, with its hash to re-check.
    const pending = readDefifaWriteRecovery(scope)
    expect(pending?.hash).toBe(HASH)
    await expect(runRecoverableDefifaWrite({ scope, action: { account: ACCOUNT, calls: [reviewedCall(request)] }, run: vi.fn() })).rejects.toThrow()
    // Verified: nothing is pending.
    await clearDefifaWriteRecovery(scope, pending!)
    expect(readDefifaWriteRecovery(scope)).toBeNull()
  })

  it('clears only the exact retained record, and nothing once the hold settled it', async () => {
    const original = await saved()
    await clearDefifaWriteRecovery(scope, { ...original, id: 'another-record' })
    expect(readDefifaWriteRecovery(scope)?.id).toBe(original.id)
    await clearDefifaWriteRecovery(scope, original)
    expect(readDefifaWriteRecovery(scope)).toBeNull()
    // Already gone (the hold settled it): nothing is written back.
    await clearDefifaWriteRecovery(scope, original)
    expect(readDefifaWriteRecovery(scope)).toBeNull()
  })
})

describe('Defifa sequence identity and legacy recovery', () => {
  const planned = (chainId: number) => [
    reviewedCall({ ...request, chainId }, { intent: 'defifa-approval' }),
    reviewedCall({ ...request, chainId, address: TARGET }, { intent: defifaWriteNamespace(scope), dependsOnPrior: true }),
  ]
  async function sequence(chainId: number, phase: 'approval' | 'approved' | 'mint' = 'approval', namespace = defifaWriteNamespace(scope)) {
    const calls = planned(chainId)
    const record: ReviewedSequenceRecord = { version: 1, id: crypto.randomUUID(), account: ACCOUNT, scope: namespace, modelId: HASH, calls, completed: phase === 'approval' ? [] : [HASH] }
    if (phase !== 'approved') {
      const step = phase === 'approval' ? 0 : 1
      const call = calls[step]
      const journal = createBrowserWriteRecovery({ chainId, account: ACCOUNT, safe: false, namespace: call.intent!, call }, { storage: createHeldWriteStorage() })
      await journal.withLock(async () => { const held = journal.reserve(); journal.submitted(HASH, held); record.sending = { step, reservation: held.id } })
    }
    await saveReviewedSequence(record, createHeldWriteStorage(), null)
    return record
  }

  it('keeps another chain’s pending legacy approval untouched while the same project/account starts its own checkout', async () => {
    const original = await sequence(10)
    const fresh = planned(scope.chainId)
    const selected = await defifaSequenceCalls(scope, fresh)
    expect(selected).toMatchObject({ calls: fresh, saved: false, scope: defifaSequenceScope(scope) })
    expect(findReviewedSequence(original.scope, ACCOUNT)).toEqual(original)
    const run = vi.fn(async (_action: ReviewedRun) => null)
    await runRecoverableDefifaWrite({ scope, action: { account: ACCOUNT, calls: selected.calls, scope: selected.scope }, run })
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ scope: defifaSequenceScope(scope), calls: fresh }))
    await finishDefifaSequence(scope)
    expect(findReviewedSequence(original.scope, ACCOUNT)).toEqual(original)
  })

  it('continues the exact same-chain legacy approval and mint under their original sequence key', async () => {
    const original = await sequence(scope.chainId)
    const selected = await defifaSequenceCalls(scope, planned(scope.chainId).map(call => ({ ...call, value: 5n })))
    expect(selected).toMatchObject({ calls: original.calls, saved: true, scope: original.scope, held: 0 })
    const run = vi.fn(async (_action: ReviewedRun) => null)
    await runRecoverableDefifaWrite({ scope, action: { account: ACCOUNT, calls: selected.calls, scope: selected.scope }, run })
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ scope: original.scope, calls: original.calls }))
    expect(findReviewedSequence(original.scope, ACCOUNT)).toEqual(original)
  })

  it('starts a retry under the qualified scope after a same-chain legacy approval completed and no mint was submitted', async () => {
    const original = await sequence(scope.chainId, 'approved')
    const selected = await defifaSequenceCalls(scope, planned(scope.chainId))
    expect(selected).toMatchObject({ saved: false, scope: defifaSequenceScope(scope) })
    expect(findReviewedSequence(original.scope, ACCOUNT)).toBeNull()
    const retry = await sequence(scope.chainId, 'approval', defifaSequenceScope(scope))
    expect(await defifaSequenceCalls(scope, planned(scope.chainId))).toMatchObject({ saved: true, calls: retry.calls, scope: retry.scope })
  })

  it('keeps an unverified same-chain legacy mint and its original write journal pending', async () => {
    const original = await sequence(scope.chainId, 'mint')
    const before = readDefifaWriteRecovery(scope)
    const selected = await defifaSequenceCalls(scope, planned(scope.chainId))
    expect(selected).toMatchObject({ saved: true, scope: original.scope, held: 1 })
    const run = vi.fn()
    await expect(runRecoverableDefifaWrite({ scope, action: { account: ACCOUNT, calls: selected.calls, scope: selected.scope }, run })).rejects.toThrow('NFT action')
    expect(run).not.toHaveBeenCalled()
    await finishDefifaSequence(scope)
    expect(findReviewedSequence(original.scope, ACCOUNT)).toEqual(original)
    expect(readDefifaWriteRecovery(scope)).toEqual(before)
  })

  it.each([false, true])('does not adopt or discard a mixed-chain record even when its first call matches (qualified %s)', async qualified => {
    const original = await sequence(scope.chainId, 'approved', qualified ? defifaSequenceScope(scope) : defifaWriteNamespace(scope))
    original.calls[1].chainId = 10
    const storage = createHeldWriteStorage()
    const current = findReviewedSequence(original.scope, ACCOUNT)!
    // Replace only this fixture’s snapshot through the SDK’s normal guarded writer.
    await saveReviewedSequence(original, storage, readReviewedSequence(current.scope, ACCOUNT, storage).raw)
    expect(await defifaSequenceCalls(scope, planned(scope.chainId))).toMatchObject({ saved: false, scope: defifaSequenceScope(scope) })
    await finishDefifaSequence(scope)
    expect(findReviewedSequence(original.scope, ACCOUNT)).toEqual(original)
  })
})
