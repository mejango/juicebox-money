import {
  createWriteHold,
  WriteHeldError,
  WriteHoldBusyError,
  type WriteHoldClient,
  type WriteHoldGate,
  type WriteHoldHandle,
  type WriteHoldSettled,
  type WriteHoldState,
} from '@bananapus/nana-sdk-core/review'
import { keccak256, stringToHex, type Address, type Hex, type TransactionReceipt } from 'viem'
import { heldCall, type SafeAppCall } from '@/lib/safe-connector'
import { showHeldWrite } from '@/lib/held-writes-registry'

/**
 * The app's one SDK write hold: every wallet write is held through it
 * (storage or this tab's memory, one lock per exact call, the states, the
 * exits and the release rules).
 */
export const writeHolds = createWriteHold()

/** A hold that cleared with no settlement this flow can claim (an exit elsewhere): neutral, never a result. */
export const WRITE_RELEASED_LINE = 'This transaction is no longer held here. Check your wallet before sending it again.'

/**
 * Whether `next` only repeats `shown` without its exit (a replay, or a saved
 * state read before the chain was asked): the exit `shown` already offers stays.
 */
export function repeatsWithoutExit(shown: WriteHoldState | null | undefined, next: WriteHoldState): boolean {
  return !!shown && shown.status !== 'clear' && next.status !== 'clear' && shown.exit && !next.exit &&
    (shown.status as string) === next.status && JSON.stringify(shown.record) === JSON.stringify(next.record)
}

/** A review's description, with the hold's line when this browser can't remember pending writes. */
export function reviewDescription(...parts: (string | null | undefined)[]): string | undefined {
  return [...parts, writeHolds.reviewLine()].filter(Boolean).join('\n\n') || undefined
}

/**
 * Whether `next` belongs to the reservation `observed` shows: a state of another
 * reservation (another tab's newer attempt), or one naming none while one is
 * observed, is never this observer's.
 */
export function sameReservation(observed: WriteHoldState | null | undefined, next: WriteHoldState): boolean {
  const mine = observed?.reservation
  return mine === undefined || next.reservation === mine
}

/** The hash a settlement names, lowercased, or null (an expiry names none). */
export function settledHashOf(settled?: WriteHoldSettled): string | null {
  return settled && 'hash' in settled ? settled.hash.toLowerCase() : null
}

/** What a hold that ended on its own says: its result when the hold saw it, otherwise that it went through. Never a send. */
export function settledLine(settled?: WriteHoldSettled): string {
  if (settled?.result === 'failed') return 'Your earlier transaction failed onchain.'
  if (settled?.result === 'expired') return 'Your earlier Safe proposal expired before it ran.'
  return 'Your earlier transaction went through.'
}

export {
  forgetHeldWrite,
  heldWritesSnapshot,
  showHeldWrite,
  subscribeHeldWrites,
  type ShownHeldWrite,
} from '@/lib/held-writes-registry'

/**
 * Hand one wallet write to the SDK's write hold, the one rule every module
 * that opens a wallet outside useSafeTx follows: it refuses a held call
 * (WriteHeldError), holds the call from just before the wallet opens, and a
 * write that may have reached the wallet stays held, shown app-wide with its
 * exit, whatever the send throws.
 */
export async function sendUnderHold(
  chainId: number,
  hold: WriteHoldHandle,
  client: WriteHoldClient,
  send: (gate: WriteHoldGate) => Promise<Hex>,
): Promise<Hex> {
  let reached = false
  try {
    return await hold.send(client, gate => send({
      ...gate,
      beforeSend: async actualCall => {
        await gate.beforeSend(actualCall)
        reached = true
      },
    }))
  } catch (error) {
    if (error instanceof WriteHeldError) showHeldWrite(chainId, hold, error.state)
    else if (reached && !(error instanceof WriteHoldBusyError)) {
      const now = await hold.state(client).catch(() => null)
      if (now && now.status !== 'clear') showHeldWrite(chainId, hold, now)
    }
    throw error
  }
}

/**
 * After a held write's receipt (or Safe execution receipt): the hold verifies
 * it. Anything but this hash's settlement keeps it held and shown, and throws
 * the hold's line, so no caller reports success from the receipt alone.
 */
export async function settleUnderHold(
  chainId: number,
  hold: WriteHoldHandle,
  client: WriteHoldClient,
  receipt: TransactionReceipt,
  proof?: Parameters<WriteHoldHandle['onReceipt']>[2],
): Promise<void> {
  const state = await hold.onReceipt(receipt, client, proof).catch(() => hold.peek())
  if (state.status === 'clear') {
    if (settledHashOf(state.settled) === receipt.transactionHash.toLowerCase()) return
    throw new Error(WRITE_RELEASED_LINE)
  }
  showHeldWrite(chainId, hold, state)
  throw new Error(state.line)
}

/** A Safe proposal's key: its chain, Safe and exact call with any field stamped at send time blanked. */
export function safeProposalKey(chainId: number, safe: Address, call: SafeAppCall): string {
  const held = heldCall(call)
  return `${chainId}:${safe.toLowerCase()}:${held.to.toLowerCase()}:${held.value ?? 0n}:${held.data.toLowerCase()}`
}

/** A Safe write is held by that key, so a re-stamped proposal of the same call is the same hold. */
export function safeHoldNamespace(key: string): string {
  return `safe:${keccak256(stringToHex(key)).slice(2)}`
}

/** The hold over a Safe app write of `call`, shared by every module that proposes it. */
export function safeWriteHold(chainId: number, safe: Address, call: SafeAppCall): WriteHoldHandle {
  return writeHolds.open({ chainId, account: safe, safe: true, namespace: safeHoldNamespace(safeProposalKey(chainId, safe, call)), call })
}
