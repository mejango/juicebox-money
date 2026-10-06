'use client'

import { useSyncExternalStore } from 'react'
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  isAddressEqual,
  TransactionNotFoundError,
  type AbiParameter,
  type Address,
  type Hex,
} from 'viem'
import type { Config } from 'wagmi'
import { getAccount, getPublicClient } from 'wagmi/actions'
import { multiSendCallsOf, readBoundedSafeNonce } from '@bananapus/nana-sdk-core/safe'
import {
  canonicalSafeTxHash,
  isSafeWalletPeer,
  listPendingSafeTransactions,
  readSafeTransaction,
  SAFE_EXEC_ABI,
  safeExecutionResult,
  safeTransactionMatchesCall,
  safeTransactionMessage,
  type SafeExecutionResult,
  type SafeQueuedTransaction,
  type SafeServiceOptions,
  waitForSafeExecutionHash as waitForExecution,
} from '@bananapus/nana-sdk-core/safe-service'
import {
  getWalletConnectPeerUrl,
  getWatchedConfig,
  subscribeWalletConnectPeer,
} from '@/lib/safe-wallet-peer'

export {
  SAFE_NONCE_GUIDANCE,
  SAFE_PREFIX,
  swapDeadline,
} from '@bananapus/nana-sdk-core/safe-service'

/**
 * Whether the connected wallet proposes to a Safe rather than sending: the
 * Safe app, or Safe{Wallet} over WalletConnect, which answers the same way.
 */
export function isSafeConnection(config: Config): boolean {
  try {
    const id = getAccount(config).connector?.id
    return (
      id === 'safe' ||
      (id === 'walletConnect' && isSafeWalletPeer(getWalletConnectPeerUrl()))
    )
  } catch {
    return false
  }
}

/** isSafeConnection for rendering: it renders again once the WalletConnect peer is known. */
export function useSafeConnection(config: Config): boolean {
  return useSyncExternalStore(
    subscribeWalletConnectPeer,
    () => isSafeConnection(config),
    () => false,
  )
}

/** What a Safe app flow says when it cannot confirm its proposal ran. */
export const SAFE_PROPOSAL_UNCONFIRMED =
  'Safe proposal submitted, but confirmation is unavailable. Check Safe before taking another action.'

/** What a Safe app flow says while its proposal waits for the Safe's other signers. */
export const SAFE_PROPOSAL_AWAITING =
  'Proposed to your Safe. Its other signers can approve it there.'

/** A call a Safe app proposal was reviewed to run. */
export type SafeAppCall = { to: Address; data: Hex; value?: bigint }

type SafeAppExecution = {
  /** Reads the execution's transaction, which only an execution returned at once needs. */
  client: { getTransaction(args: { hash: Hex }): Promise<{ to?: Address | null; input: Hex }> }
  receipt: Parameters<typeof safeExecutionResult>[0]
  safe: Address
  /** What the wallet returned: the safeTxHash, or the execution's own hash when Safe{Wallet} executed at once. */
  proposalHash: Hex
  /** What the proposal was reviewed to run: one call, or a batch in order. */
  calls: readonly SafeAppCall[]
}

/**
 * Whether `transaction` is `safe`'s execTransaction of exactly `calls`: the
 * one call as a CALL, or every call in order through MultiSendCallOnly.
 */
function runsCalls(
  transaction: { to?: Address | null; input: Hex },
  safe: Address,
  calls: readonly SafeAppCall[],
): boolean {
  if (!transaction.to || !isAddressEqual(transaction.to, safe)) return false
  let decoded: ReturnType<typeof decodeFunctionData<typeof SAFE_EXEC_ABI>>
  try {
    decoded = decodeFunctionData({ abi: SAFE_EXEC_ABI, data: transaction.input })
  } catch {
    return false
  }
  if (decoded.functionName !== 'execTransaction') return false
  const [to, value, data, operation] = decoded.args
  const ran =
    operation === 0
      ? [{ to, value, data }]
      : value === 0n
        ? multiSendCallsOf({ to, data, operation })
        : null
  return (
    !!ran &&
    ran.length === calls.length &&
    ran.every(
      (call, index) =>
        isAddressEqual(call.to, calls[index].to) &&
        call.value === (calls[index].value ?? 0n) &&
        call.data.toLowerCase() === calls[index].data.toLowerCase(),
    )
  )
}

/**
 * What the execution's receipt proves about the proposal a Safe app returned
 * ({@link safeExecutionResult}). When Safe{Wallet} executed it at once, the
 * reply is the execution's own hash and the SDK takes the Safe's one
 * execution event in that receipt whatever its safeTxHash, so the execution
 * must also be the Safe's execTransaction of exactly the reviewed calls, or
 * the result is unproven.
 */
export async function readSafeAppExecution({
  client,
  receipt,
  safe,
  proposalHash,
  calls,
}: SafeAppExecution): Promise<SafeExecutionResult> {
  const result = safeExecutionResult(receipt, safe, proposalHash)
  const atOnce =
    typeof receipt.transactionHash === 'string' &&
    receipt.transactionHash.toLowerCase() === proposalHash.toLowerCase()
  if (!atOnce || (result.status !== 'success' && result.status !== 'failed')) {
    return result
  }
  const transaction = await client.getTransaction({ hash: proposalHash }).catch(() => null)
  return transaction && runsCalls(transaction, safe, calls)
    ? result
    : {
        status: 'unproven',
        reason: `Transaction ${proposalHash} is not Safe ${safe}'s execution of the reviewed call.`,
      }
}

/**
 * Throws unless the execution proves the Safe ran the reviewed proposal and
 * its call succeeded ({@link readSafeAppExecution}): `failure` when the Safe
 * ran it and it failed, and SAFE_PROPOSAL_UNCONFIRMED when it does not show
 * this proposal ran.
 */
export async function requireSafeProposalSuccess(
  execution: SafeAppExecution,
  failure: string,
): Promise<void> {
  const { status } = await readSafeAppExecution(execution)
  if (status === 'unproven') throw new Error(SAFE_PROPOSAL_UNCONFIRMED)
  if (status !== 'success') throw new Error(failure)
}

/**
 * The calls this app stamps with a field at send time, by selector: the
 * stamp's argument, and whether the contract refuses the call once the chain
 * passes it. Universal Router's `execute` and PositionManager's
 * `modifyLiquidities` check a deadline; the expiration Permit2's `approve`
 * sets only bounds the allowance it grants.
 */
const STAMPED_CALLS: Record<string, { params: readonly AbiParameter[]; stamp: number; reverts: boolean }> = {
  // execute(bytes commands, bytes[] inputs, uint256 deadline)
  '0x3593564c': { params: [{ type: 'bytes' }, { type: 'bytes[]' }, { type: 'uint256' }], stamp: 2, reverts: true },
  // modifyLiquidities(bytes unlockData, uint256 deadline)
  '0xdd46508f': { params: [{ type: 'bytes' }, { type: 'uint256' }], stamp: 1, reverts: true },
  // approve(address token, address spender, uint160 amount, uint48 expiration)
  '0x87517c45': {
    params: [{ type: 'address' }, { type: 'address' }, { type: 'uint160' }, { type: 'uint48' }],
    stamp: 3,
    reverts: false,
  },
}

/** A stamped call's shape and arguments, when its data is exactly their ABI encoding. */
function stampedArgs(call: SafeAppCall) {
  const shape = STAMPED_CALLS[call.data.slice(0, 10).toLowerCase()]
  if (!shape) return null
  const encoded = `0x${call.data.slice(10)}` as Hex
  try {
    const args = decodeAbiParameters(shape.params, encoded) as readonly unknown[]
    // Any other encoding of the same arguments is held exactly as sent.
    return encodeAbiParameters(shape.params, args).toLowerCase() === encoded.toLowerCase()
      ? { shape, args }
      : null
  } catch {
    return null
  }
}

/**
 * The call a Safe proposal of `call` holds: `call` with the field it is
 * stamped with at send time zeroed, so the same action sent again with a later
 * stamp is the action the proposal already holds. Any other call is held
 * exactly as sent.
 */
export function heldCall(call: SafeAppCall): SafeAppCall {
  const stamped = stampedArgs(call)
  if (!stamped) return call
  const args = [...stamped.args]
  args[stamped.shape.stamp] = 0n
  return {
    ...call,
    data: `${call.data.slice(0, 10)}${encodeAbiParameters(stamped.shape.params, args).slice(2)}` as Hex,
  }
}

/** The deadline after which the contract refuses `call`, or null for a call without one. */
export function stampedDeadline(call: SafeAppCall): bigint | null {
  const stamped = stampedArgs(call)
  return stamped?.shape.reverts ? BigInt(stamped.args[stamped.shape.stamp] as bigint) : null
}

function sameCall(a: SafeAppCall, b: SafeAppCall): boolean {
  return (
    isAddressEqual(a.to, b.to) &&
    (a.value ?? 0n) === (b.value ?? 0n) &&
    a.data.toLowerCase() === b.data.toLowerCase()
  )
}

/** A Safe app proposal's one call, or null for any other Safe transaction. */
function proposedCall(tx: SafeQueuedTransaction): SafeAppCall | null {
  try {
    const { to, data, value } = safeTransactionMessage(tx)
    // A zero-refund CALL, as a Safe app proposes it.
    return safeTransactionMatchesCall(tx, { to, data, value }) ? { to, data, value } : null
  } catch {
    return null
  }
}

/** A chain client that reads the Safe's nonce and the latest block. */
type SafeQueueClient = Parameters<typeof readBoundedSafeNonce>[0] & {
  getBlock(): Promise<{ number: bigint | null; timestamp: bigint }>
}

/**
 * A pending proposal of the action `call` makes in `safe`'s queue (its
 * service record, its safeTxHash and the call it runs), read from Safe's
 * service at the Safe's onchain nonce, or null: a Safe app never proposes an
 * action that is already queued, whoever queued it, whatever its stamp
 * ({@link heldCall}). A queued call the contract refuses once its deadline
 * passed is passed over once the latest block is past that deadline: it can
 * no longer run. Throws when the nonce, the queue or the latest block can't
 * be read.
 */
export async function findPendingSafeAppProposal(
  client: SafeQueueClient,
  chainId: number,
  safe: Address,
  call: SafeAppCall,
  service?: SafeServiceOptions,
): Promise<{ tx: SafeQueuedTransaction; proposalHash: Hex; call: SafeAppCall } | null> {
  const nonce = await readBoundedSafeNonce(client, safe).catch(() => null)
  if (nonce === null || nonce > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Could not read the Safe nonce.')
  }
  const held = heldCall(call)
  const queued = (await listPendingSafeTransactions(chainId, safe, Number(nonce), service)).flatMap(tx => {
    const proposed = proposedCall(tx)
    return proposed && sameCall(heldCall(proposed), held)
      ? [{ tx, call: proposed, deadline: stampedDeadline(proposed) }]
      : []
  })
  if (!queued.length) return null
  const latest = queued.some(({ deadline }) => deadline !== null)
    ? (await client.getBlock()).timestamp
    : 0n
  const live = queued.find(({ deadline }) => deadline === null || deadline >= latest)
  return live
    ? { tx: live.tx, proposalHash: canonicalSafeTxHash(chainId, safe, live.tx), call: live.call }
    : null
}

/**
 * What one look at a proposal awaiting its signers finds:
 *
 * - `expired`: the latest block is past its deadline and the Safe's nonce in
 *   that block is not past the proposal's, so it never ran, and the contract
 *   refuses it in any later block;
 * - `passed`: the Safe's nonce is past the proposal's and Safe's service lists
 *   no execution of it: another transaction took its nonce, or the service has
 *   yet to list its own execution;
 * - `live`: it can still run, it ran, or the look could not tell.
 */
export type SafeProposalLook = 'expired' | 'passed' | 'live'

/**
 * One look at `safe`'s proposal `proposalHash`: the latest block, the Safe's
 * nonce in that block, and Safe's authenticated record of the proposal. A read
 * that fails makes the look live.
 */
export async function lookAtSafeProposal(
  client: SafeQueueClient,
  chainId: number,
  safe: Address,
  proposalHash: Hex,
  service?: SafeServiceOptions,
): Promise<SafeProposalLook> {
  try {
    const block = await client.getBlock()
    const nonce = await readBoundedSafeNonce(client, safe, { blockNumber: block.number ?? undefined })
    const record = await readSafeTransaction(chainId, safe, proposalHash, service)
    if (nonce === null || record.isExecuted) return 'live'
    if (nonce > safeTransactionMessage(record).nonce) return 'passed'
    const call = proposedCall(record)
    const deadline = call && stampedDeadline(call)
    return deadline !== null && block.timestamp > deadline ? 'expired' : 'live'
  } catch {
    return 'live'
  }
}

/** A watch looks at its proposal once a minute, so it reads the Safe's nonce at most that often. */
const SAFE_LOOK_MS = 60_000
/** How long looks in a row must find the Safe past a proposal before it counts as replaced. */
const SAFE_REPLACED_AFTER_MS = 10 * 60_000

/**
 * Watches a proposal awaiting its signers, one {@link lookAtSafeProposal} a
 * minute, until `signal` aborts. It ends `expired` at the first look that
 * finds it expired, and `replaced` once looks in a row have found it passed
 * for ten minutes: one such look proves nothing, since Safe's service may list
 * the proposal's own execution later. Any other look starts that count again.
 */
export async function watchSafeProposal(
  client: SafeQueueClient,
  chainId: number,
  safe: Address,
  proposalHash: Hex,
  signal: AbortSignal,
  service?: SafeServiceOptions,
): Promise<'expired' | 'replaced'> {
  let passedSince: number | null = null
  for (;;) {
    await abortable(SAFE_LOOK_MS, signal)
    const look = await lookAtSafeProposal(client, chainId, safe, proposalHash, service)
    if (look === 'expired') return look
    passedSince = look === 'passed' ? (passedSince ?? Date.now()) : null
    if (passedSince !== null && Date.now() - passedSince >= SAFE_REPLACED_AFTER_MS) return 'replaced'
  }
}

/** Looks at the chain for an execution returned at once, and the pause between them. */
const AT_ONCE_LOOKS = 5
const AT_ONCE_LOOK_MS = 2_000

/**
 * Whether the chain knows `hash` as a transaction: Safe{Wallet} replies with
 * the execution's own hash when the owner executes at once, and the node may
 * learn it a moment later. It looks up to 5 times, 2 seconds apart (8 seconds
 * at most), before the reply counts as a proposal.
 */
export async function executedAtOnce(
  client: { getTransaction(args: { hash: Hex }): Promise<unknown> },
  hash: Hex,
): Promise<boolean> {
  for (let look = 1; ; look += 1) {
    try {
      await client.getTransaction({ hash })
      return true
    } catch {
      if (look >= AT_ONCE_LOOKS) return false
    }
    await abortable(AT_ONCE_LOOK_MS)
  }
}

/**
 * The execution Safe's authenticated record names for `safeTxHash` when
 * `error` is its service's report that the proposal ran and failed, or null.
 * Only that execution's receipt decides the proposal, never the report alone.
 */
export async function reportedSafeExecution(
  error: unknown,
  chainId: number,
  safe: Address,
  safeTxHash: Hex,
  service?: SafeServiceOptions,
): Promise<Hex | null> {
  if (!(error instanceof Error) || !/executed the proposal.*failed/i.test(error.message)) return null
  const record = await readSafeTransaction(chainId, safe, safeTxHash, service).catch(() => null)
  const hash = (record as { transactionHash?: unknown } | null)?.transactionHash
  return typeof hash === 'string' && /^0x[0-9a-fA-F]{64}$/u.test(hash) ? (hash as Hex) : null
}

/** How often a look at the chain asks again when the node can't answer. */
const CHAIN_RETRY_MS = 5_000
/** How long one look asks a node that can't answer before the failure reaches the SDK. */
const CHAIN_RETRY_LIMIT_MS = 5 * 60_000

function abortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const aborted = () => {
      clearTimeout(timer)
      reject(new DOMException('Safe execution wait aborted', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', aborted)
      resolve()
    }, ms)
    signal?.addEventListener('abort', aborted, { once: true })
    if (signal?.aborted) aborted()
  })
}

/**
 * The chain as the SDK's wait reads it. The SDK takes any failed lookup as
 * "no such transaction" and, on a chain without a Safe service, gives the
 * proposal up after 12 of those in a row. Only viem's TransactionNotFoundError
 * says that here: any other failure says nothing about the transaction, so the
 * look asks again every 5 seconds, for up to 5 minutes, before it reaches the
 * SDK, and stops with the wait. (The SDK is learning to read a not-found this
 * way itself; once jbm takes that version this wrapper goes.)
 */
function notFoundOnly(
  client: { getTransaction: (args: { hash: Hex }) => Promise<unknown> },
  signal?: AbortSignal,
): { getTransaction: (args: { hash: Hex }) => Promise<unknown> } {
  return {
    async getTransaction(args) {
      const started = Date.now()
      for (;;) {
        try {
          return await client.getTransaction(args)
        } catch (error) {
          if (error instanceof TransactionNotFoundError || Date.now() - started >= CHAIN_RETRY_LIMIT_MS) {
            throw error
          }
          await abortable(CHAIN_RETRY_MS, signal)
        }
      }
    },
  }
}

/**
 * The SDK's wait, reading the chain as well: Safe{Wallet} over WalletConnect
 * replies with the execution's own hash when the owner executes at once. An
 * explicit `client` wins.
 */
export function waitForSafeExecutionHash(
  chainId: number,
  safeTxHash: Hex,
  options: NonNullable<Parameters<typeof waitForExecution>[2]> = {},
): Promise<Hex> {
  const config = getWatchedConfig()
  const client = options.client ?? (config && getPublicClient(config, { chainId }))
  return waitForExecution(chainId, safeTxHash, {
    ...options,
    client: client ? notFoundOnly(client, options.signal) : undefined,
  })
}
