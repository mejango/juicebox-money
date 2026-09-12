'use client'

import { getAccount } from '@wagmi/core'
import { isAddress, isAddressEqual, type Address, type Hex, type TransactionReceipt } from 'viem'
import { wagmiConfig } from '@/providers/Providers'
import { clientFor, runAuthorityCalls, type AuthorityCall } from '@/lib/authority'
import { readAuthorityIdentity } from '@/lib/cross-chain-authority'
import { canonicalSafeTxHash, receiptHasSafeExecutionSuccess, type SafeQueuedTx } from '@/lib/safe'
import { isSafeConnection, waitForSafeExecutionHash } from '@/lib/safe-connector'
import {
  loadRelayrPendingSession, relayrTargetSupportsForwarder,
  runRelayrCalls, withRelayrScopeLock,
  relayrErrorIsDefiniteNoSubmission,
  relayrDestinationHash, relayrRecordChain,
} from '@/lib/relayr'
import { requireTransactionReview } from '@/lib/transaction-review'
import { assertNoViewAs } from '@/lib/viewAs'
import { relayrPaymentChains, relayrSupportsChain } from '@/lib/relayr-chains'

export type ProjectBatchCall = AuthorityCall & {
  id: string
  projectId: number
  /** Calls near the per-transaction gas ceiling cannot fit a forwarding wrapper. */
  relayr?: false
  /** Immutable, serializable application preconditions and review details. */
  context?: unknown
}

type CallSubmission = {
  kind: 'direct' | 'safe-connector' | 'safe'
  hash?: Hex
  safeTx?: SafeQueuedTx
  fromBlock?: bigint
}

export type ProjectBatch = {
  version: 1
  id: string
  scope: string
  action: string
  account: Address
  title: string
  status: 'pending' | 'complete'
  calls: ProjectBatchCall[]
  completedIds: string[]
  rounds: string[][]
  submissions: Record<string, CallSubmission>
  relayrRounds: number[]
  relayrCallIds?: Record<string, string[]>
  /** Freeze chain eligibility; older journals retain their original mainnet-only routing. */
  relayrChainIds?: number[]
  abandoned?: boolean
}

const PREFIX = 'jb-project-batch:v1:'
const encode = (value: unknown) => JSON.stringify(value, (_key, item) =>
  typeof item === 'bigint' ? { $projectBatchBigInt: item.toString() } : item)
const decode = <T,>(value: string): T => JSON.parse(value, (_key, item) =>
  item && typeof item === 'object' && Object.keys(item).length === 1 &&
  typeof item.$projectBatchBigInt === 'string' ? BigInt(item.$projectBatchBigInt) : item) as T

export function projectBatchScope(action: string, chainId: number, projectId: number): string {
  return `${action}:${chainId}:${projectId}`
}

function aliases(batch: Pick<ProjectBatch, 'scope' | 'action' | 'calls'>): string[] {
  return [...new Set([batch.scope, ...batch.calls.map(call =>
    projectBatchScope(batch.action, call.chainId, call.projectId))])].sort()
}

function readBatch(scope: string): ProjectBatch | null {
  if (typeof window === 'undefined') return null
  const id = window.localStorage.getItem(`${PREFIX}alias:${scope}`)
  if (!id) return null
  const raw = window.localStorage.getItem(`${PREFIX}journal:${id}`)
  if (!raw) throw new Error('The saved project action is incomplete. Restore its recovery data before submitting again.')
  const batch = decode<ProjectBatch>(raw)
  if (batch.version !== 1 || batch.id !== id || !isAddress(batch.account ?? '') ||
      typeof batch.scope !== 'string' || typeof batch.action !== 'string' ||
      !['pending', 'complete'].includes(batch.status) || !Array.isArray(batch.calls) || !batch.calls.length ||
      batch.calls.some(call => !call || typeof call.id !== 'string' || !Number.isSafeInteger(call.chainId) ||
        !Number.isSafeInteger(call.projectId) || call.projectId <= 0 || !isAddress(call.authority ?? '') ||
        !isAddress(call.target ?? '') || !/^0x(?:[0-9a-f]{2})*$/iu.test(call.data ?? '')) ||
      new Set(batch.calls.map(call => call.id)).size !== batch.calls.length ||
      !Array.isArray(batch.completedIds) || batch.completedIds.some(id => !batch.calls.some(call => call.id === id)) ||
      !Array.isArray(batch.rounds) || encode(batch.rounds) !== encode(projectBatchRounds(batch.calls)) ||
      (batch.relayrChainIds !== undefined && (!Array.isArray(batch.relayrChainIds) ||
        new Set(batch.relayrChainIds).size !== batch.relayrChainIds.length ||
        batch.relayrChainIds.some(chainId => !relayrSupportsChain(chainId) ||
          !batch.calls.some(call => call.chainId === chainId)))) ||
      !batch.submissions || !Array.isArray(batch.relayrRounds) || !aliases(batch).includes(scope)) {
    throw new Error('The saved project action could not be verified. Keep the original action pending.')
  }
  return batch
}

/** Completed journals remain as tombstones; the next reviewed action can replace their aliases. */
export function loadProjectBatch(scope: string): ProjectBatch | null {
  const batch = readBatch(scope)
  return batch?.status === 'pending' && !batch.abandoned ? batch : null
}

function persist(batch: ProjectBatch, attach = false): void {
  const key = `${PREFIX}journal:${batch.id}`
  const raw = encode(batch)
  try {
    window.localStorage.setItem(key, raw)
    if (window.localStorage.getItem(key) !== raw) throw new Error('Storage verification failed')
    if (attach) for (const alias of aliases(batch)) {
      const aliasKey = `${PREFIX}alias:${alias}`
      window.localStorage.setItem(aliasKey, batch.id)
      if (window.localStorage.getItem(aliasKey) !== batch.id) throw new Error('Storage verification failed')
    }
  } catch {
    throw new Error('Could not save project transaction recovery. Keep this action open and restore browser storage before continuing.')
  }
}

function identity(calls: ProjectBatchCall[]): string {
  return encode(calls.map(({ reverifyAuthority: _verify, onSending: _sending,
    onSubmitted: _submitted, onSafePrepared: _safe, gas: _gas, ...call }) => call))
}

/** A later call on the same chain waits for the earlier call's canonical receipt. */
export function projectBatchRounds(calls: ProjectBatchCall[]): string[][] {
  const next = new Map<number, number>()
  const rounds: string[][] = []
  for (const call of calls) {
    const round = next.get(call.chainId) ?? 0
    ;(rounds[round] ??= []).push(call.id)
    next.set(call.chainId, round + 1)
  }
  return rounds
}

async function locked<T>(scopes: string[], run: () => Promise<T>, index = 0): Promise<T> {
  if (index === scopes.length) return run()
  return withRelayrScopeLock(`project-batch:${scopes[index]}`, () => locked(scopes, run, index + 1))
}

async function verifyReceipt(call: ProjectBatchCall, hash: Hex, safeHash?: Hex, acceptReverted = false): Promise<TransactionReceipt> {
  const client = clientFor(call.chainId)
  const [tx, receipt] = await Promise.all([
    client.getTransaction({ hash }), client.getTransactionReceipt({ hash }),
  ])
  if (tx.hash.toLowerCase() !== hash.toLowerCase() || tx.chainId !== call.chainId ||
      receipt.transactionHash.toLowerCase() !== hash.toLowerCase() ||
      tx.blockHash !== receipt.blockHash || (receipt.status !== 'success' && !(acceptReverted && !safeHash && receipt.status === 'reverted'))) {
    throw new Error('The original transaction has not proven successful. Keep its saved recovery record.')
  }
  if (safeHash) {
    if (!receiptHasSafeExecutionSuccess(receipt, call.authority, safeHash)) {
      throw new Error('This receipt does not prove execution of the exact saved Safe proposal.')
    }
  } else if (!tx.to || !isAddressEqual(tx.from, call.authority) ||
      !isAddressEqual(tx.to, call.target) || tx.input.toLowerCase() !== call.data.toLowerCase() ||
      tx.value !== (call.value ?? 0n)) {
    throw new Error('The receipt belongs to a different project transaction. Keep the original action pending.')
  }
  const block = await client.getBlock({ blockNumber: receipt.blockNumber })
  if (!block.hash || block.hash !== receipt.blockHash) {
    throw new Error('The original project receipt is no longer canonical. Check it again before continuing.')
  }
  return receipt
}

async function safeExecution(call: ProjectBatchCall, submission: CallSubmission): Promise<Hex | null> {
  if (!submission.hash || submission.fromBlock === undefined) return null
  const client = clientFor(call.chainId)
  const latest = await client.getBlockNumber()
  // Event provenance is the Safe contract itself; a service status cannot complete a call.
  for (let start = submission.fromBlock; start <= latest; start += 10_000n) {
    const end = start + 9_999n < latest ? start + 9_999n : latest
    const logs = await client.getLogs({ address: call.authority, fromBlock: start, toBlock: end })
    const log = logs.find(log => receiptHasSafeExecutionSuccess({ logs: [log] }, call.authority, submission.hash!))
    if (log?.transactionHash) return log.transactionHash
  }
  return null
}

export async function runProjectBatch({
  scope, action, account, calls, expectedBatchId, title = 'Review project actions', reverify, reconcileUnsubmitted, reconcileObsoleteSafe, acceptRevertedTransactions = false, verifyCompletion, onProgress,
}: {
  scope: string
  action: string
  account: Address
  calls?: ProjectBatchCall[]
  /** Bind an open recovery review to its original journal, even if another tab completes it. */
  expectedBatchId?: string
  title?: string
  reverify?: (call: ProjectBatchCall) => Promise<void>
  /** Permissionless actions may change elsewhere. Never applies to a submitted call. */
  reconcileUnsubmitted?: (call: ProjectBatchCall) => Promise<boolean>
  /** Retain the authenticated proposal while marking an irrevocably resolved payment obsolete. */
  reconcileObsoleteSafe?: (call: ProjectBatchCall, proposal: SafeQueuedTx) => Promise<boolean>
  /** Finish canonical, exact direct attempts that reverted; callers must display that outcome. */
  acceptRevertedTransactions?: boolean
  /** Application events may report a failed distribution despite a successful outer receipt. */
  verifyCompletion?: (call: ProjectBatchCall, receipt: TransactionReceipt) => Promise<void>
  onProgress?: (progress: { message: string; completed: number; total: number; round: number; rounds: number }) => void
}): Promise<ProjectBatch> {
  assertNoViewAs()
  if (typeof navigator === 'undefined' || !navigator.locks) {
    throw new Error('This browser cannot lock project transaction recovery across tabs. Use a browser with Web Locks support.')
  }
  const previous = loadProjectBatch(scope)
  const proposedCalls = calls ?? previous?.calls
  if (!proposedCalls?.length) throw new Error('Choose at least one project action.')
  if (new Set(proposedCalls.map(call => call.id)).size !== proposedCalls.length) {
    throw new Error('Each reviewed project call must have a unique identifier.')
  }
  const scopes = aliases({ scope, action, calls: proposedCalls })
  return locked(scopes, async () => {
    let batch = loadProjectBatch(scope)
    for (const alias of scopes) {
      const saved = loadProjectBatch(alias)
      if (!saved) continue
      if (batch && batch.id !== saved.id) throw new Error('Another selected project already has an unfinished action. Resume it first.')
      batch = saved
    }
    if (expectedBatchId && batch?.id !== expectedBatchId) {
      throw new Error('This saved action completed or changed in another tab. Reopen the project action to review its current status.')
    }
    if (batch && (batch.action !== action || !isAddressEqual(batch.account, account) ||
        (calls && identity(calls) !== identity(batch.calls)))) {
      throw new Error('An unfinished action has different reviewed settings or a different wallet. Resume its original saved calls first.')
    }
    const checkAccount = () => {
      assertNoViewAs()
      const live = getAccount(wagmiConfig).address
      if (!live || !isAddressEqual(live, account)) throw new Error('Connected wallet changed. Switch back to the wallet that reviewed this action.')
    }
    checkAccount()
    try {
    if (!batch) {
      const frozen = decode<ProjectBatchCall[]>(encode(proposedCalls))
      batch = { version: 1, id: crypto.randomUUID(), scope, action, account, title,
        status: 'pending', calls: frozen, completedIds: [], rounds: projectBatchRounds(frozen),
        submissions: {}, relayrRounds: [],
        relayrChainIds: [...new Set(frozen.map(call => call.chainId).filter(relayrSupportsChain))] }
      // Save the entire intent and every participant before any signature can escape.
      persist(batch, true)
      for (const call of batch.calls) await reverify?.(call)
      await requireTransactionReview({ title, description: 'Review each destination and its amounts. Later calls on the same chain wait for earlier calls to finish.',
        calls: batch.calls.map(call => ({ ...call, from: call.authority, to: call.target, value: call.value ?? 0n })) })
    }
    const journal = batch
    const complete = (ids: string[]) => {
      journal.completedIds = [...new Set([...journal.completedIds, ...ids])]
      if (journal.completedIds.length === journal.calls.length) journal.status = 'complete'
      persist(journal)
    }
    const report = (message: string, round: number) => onProgress?.({ message,
      completed: journal.completedIds.length, total: journal.calls.length, round: round + 1, rounds: journal.rounds.length })

    for (let round = 0; round < journal.rounds.length; round++) {
      let pending = journal.rounds[round].filter(id => !journal.completedIds.includes(id))
        .map(id => journal.calls.find(call => call.id === id)!)
      if (!pending.length) continue
      checkAccount()
      const relayrScope = `project-batch:${journal.id}:${round}`
      const boundRelayIds = journal.relayrCallIds?.[String(round)]
      let relayCalls = boundRelayIds ? pending.filter(call => boundRelayIds.includes(call.id)) : []
      const savedRelay = loadRelayrPendingSession(relayrScope)
      if (!boundRelayIds && (journal.relayrRounds.includes(round) || savedRelay)) relayCalls = pending
      if (!boundRelayIds && !journal.relayrRounds.includes(round) && !savedRelay && !isSafeConnection(wagmiConfig)) {
        const relayrChainIds = journal.relayrChainIds ?? [1, 10, 8453, 42161]
        const eligibility = await Promise.all(pending.map(async call => {
          if (call.relayr === false || !relayrChainIds.includes(call.chainId) || !relayrSupportsChain(call.chainId) || !isAddressEqual(call.authority, account) || journal.submissions[call.id]) return false
          const identity = await readAuthorityIdentity(clientFor(call.chainId), call.authority)
          return (identity?.kind === 'eoa' || identity?.kind === 'delegated-eoa') && await relayrTargetSupportsForwarder(call)
        }))
        const eligible = pending.filter((_call, index) => eligibility[index])
        const families = new Map<number, ProjectBatchCall[]>()
        for (const call of eligible) {
          const family = relayrPaymentChains([call.chainId])[0]
          if (family === undefined) continue
          const calls = families.get(family) ?? []
          calls.push(call)
          families.set(family, calls)
        }
        // A saved round owns one paid bundle. Never combine real and test funds;
        // other-family calls keep the existing separately reviewed direct path.
        relayCalls = [...families.values()].find(calls => calls.length > 1) ?? []
      }
      if (relayCalls.length) {
        if (!journal.relayrRounds.includes(round)) journal.relayrRounds.push(round)
        ;(journal.relayrCallIds ??= {})[String(round)] = relayCalls.map(call => call.id)
        persist(journal)
        report('Preparing cross-chain transactions…', round)
        await runRelayrCalls({ calls: relayCalls, account, pendingScope: relayrScope,
          reverify: async () => { checkAccount(); for (const call of relayCalls) await reverify?.(call) },
          onProgress: progress => report(progress.phase === 'executing'
            ? `Relayr reports ${progress.done}/${progress.total} destinations complete; verifying their transactions…`
            : `Round ${round + 1}/${journal.rounds.length}: ${progress.phase.replaceAll('-', ' ')}…`, round),
          onComplete: async records => {
            if (verifyCompletion) for (const call of relayCalls) {
              const matching = records.filter(record => relayrRecordChain(record) === call.chainId)
              const hash = matching.length === 1 ? relayrDestinationHash(matching[0]) : null
              if (!hash) throw new Error('The original bundle has not identified an exact receipt for every project action.')
              await verifyCompletion(call, await clientFor(call.chainId).getTransactionReceipt({ hash }))
            }
            complete(relayCalls.map(call => call.id))
          },
        })
        pending = pending.filter(call => !journal.completedIds.includes(call.id))
      }
      for (const call of pending) {
        checkAccount()
        const saved = journal.submissions[call.id]
        if (saved) {
          if (!saved.hash) throw new Error('A wallet submission may still be pending. Check the original wallet activity; do not submit this call again.')
          let execution: Hex | null = null
          if (saved.kind === 'direct') execution = saved.hash
          else if (saved.kind === 'safe') execution = await safeExecution(call, saved)
          else {
            execution = await safeExecution(call, saved)
            try { execution ??= await waitForSafeExecutionHash(call.chainId, saved.hash, { signal: AbortSignal.timeout(15_000) }) }
            catch { report('The saved Safe proposal is still pending. Execute it in Safe, then check this batch again.', round); return journal }
          }
          if (execution) {
            const receipt = await verifyReceipt(call, execution, saved.kind === 'direct' ? undefined : saved.hash, acceptRevertedTransactions)
            await verifyCompletion?.(call, receipt)
            complete([call.id])
            continue
          }
          const proposal = saved.safeTx
          if (saved.kind === 'safe' && proposal && reconcileObsoleteSafe &&
            isAddressEqual(proposal.to, call.target) && (proposal.data ?? '0x').toLowerCase() === call.data.toLowerCase() &&
            BigInt(proposal.value) === (call.value ?? 0n) && proposal.operation === 0 &&
            canonicalSafeTxHash(call.chainId, call.authority, proposal).toLowerCase() === saved.hash.toLowerCase() &&
            await reconcileObsoleteSafe(call, { ...proposal, safeTxHash: saved.hash })) {
            complete([call.id])
            continue
          }
          if (saved.kind !== 'safe') return journal
        }
        if (!saved && await reconcileUnsubmitted?.(call)) {
          complete([call.id])
          continue
        }
        await reverify?.(call)
        // Capture the scan floor before looking up an existing Safe proposal: it
        // can execute between that lookup and the prepared callback.
        const fromBlock = saved?.fromBlock ?? await clientFor(call.chainId).getBlockNumber()
        let result
        try {
          result = await runAuthorityCalls({ calls: [{ ...call,
          reverifyAuthority: async () => { checkAccount(); await reverify?.(call) },
          onSending: async kind => { journal.submissions[call.id] = { kind, fromBlock }; persist(journal) },
          onSubmitted: async (hash, kind) => { journal.submissions[call.id] = { kind, hash, fromBlock }; persist(journal) },
          onSafePrepared: async tx => {
            const hash = canonicalSafeTxHash(call.chainId, call.authority, tx)
            if (saved?.hash && hash.toLowerCase() !== saved.hash.toLowerCase()) {
              throw new Error('The Safe nonce changed. Keep checking the exact original proposal before creating another one.')
            }
            journal.submissions[call.id] = { kind: 'safe', hash, safeTx: tx,
              fromBlock }
            persist(journal)
          },
          }], onProgress: progress => report(progress.message, round) })
        } catch (error) {
          const submission = journal.submissions[call.id]
          const receipt = acceptRevertedTransactions && submission?.kind === 'direct' && submission.hash
            ? await verifyReceipt(call, submission.hash, undefined, true).catch(() => null)
            : null
          if (receipt?.status !== 'reverted') throw error
          await verifyCompletion?.(call, receipt)
          complete([call.id])
          continue
        }
        const submission = journal.submissions[call.id]
        const safeResult = result.safeResults[0]
        const execution = result.directResults[0] ?? (safeResult?.status === 'executed' ? safeResult.transactionHash : undefined)
        if (execution) {
          const receipt = await verifyReceipt(call, execution, submission?.kind !== 'direct' ? submission?.hash : undefined, acceptRevertedTransactions)
          await verifyCompletion?.(call, receipt)
          complete([call.id])
        } else {
          report('The saved Safe proposal is awaiting execution. Continue it in the multisig queue, then resume this batch.', round)
          return journal
        }
      }
    }
    return journal
    } catch (error) {
      if (batch) {
        if (relayrErrorIsDefiniteNoSubmission(error)) {
          let changed = false
          for (const [id, submission] of Object.entries(batch.submissions)) {
            if (!submission.hash) { delete batch.submissions[id]; changed = true }
          }
          if (changed) persist(batch)
        }
        // A cancelled review or failed preflight exposes no executable request.
        // Published signatures, unknown sends, and completed calls remain recoverable.
        const exposed = batch.completedIds.length > 0 || Object.keys(batch.submissions).length > 0 ||
          batch.rounds.some((_round, index) => loadRelayrPendingSession(`project-batch:${batch!.id}:${index}`))
        if (!exposed) { batch.abandoned = true; persist(batch) }
      }
      throw error
    }
  })
}
