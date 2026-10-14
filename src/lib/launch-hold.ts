import { intent, launchIntent, type WriteHeldState, type WriteHoldClient, type WriteHoldHandle } from '@bananapus/nana-sdk-core/review'
import type { Address, Hex } from 'viem'
import type { LaunchChainStatus } from '@/lib/launch-session'
import { settledHashOf, writeHolds } from '@/lib/write-holds'

/**
 * A direct launch's write hold on one chain: keyed by the SDK's launchIntent of
 * the frozen launch (its salt and project metadata), held from right before the
 * wallet opens (the SDK's atomic reservation) until proven. The launch journal
 * stays the launch's domain record.
 */
export function launchHold({ chainId, account, safe, salt, projectUri, call }: {
  chainId: number
  account: Address
  safe: boolean
  salt: Hex
  projectUri: string
  call: { to: Address; data: Hex; value: bigint }
}): WriteHoldHandle {
  return writeHolds.open({
    chainId, account, safe, call,
    namespace: launchIntent({ chainId, account, config: { salt: intent.hex(salt), projectUri } }),
  })
}

/**
 * What a resumed chain may do before its wallet opens, when its journal says a
 * request may already be out:
 * - `held`: the hold still holds it; show its state, with the SDK's warned exit when due;
 * - `settled`: the hold proved it ran; follow that transaction, never send again;
 * - `unverified`: an earlier release left it with no hold of its own; the user checks their wallet first;
 * - `send`: nothing is out (the user took the exit), so it may send.
 */
export async function launchResumeGate(
  hold: WriteHoldHandle,
  client: WriteHoldClient,
  status: Pick<LaunchChainStatus, 'phase' | 'unverifiedSend' | 'held' | 'txHash'> | undefined,
): Promise<{ kind: 'send' } | { kind: 'unverified' } | { kind: 'settled'; hash: Hex } | { kind: 'held'; state: WriteHeldState }> {
  const mayBeOut = !!status && (status.unverifiedSend || status.phase === 'signing' || (status.phase === 'uncertain' && !status.txHash))
  if (!mayBeOut) return { kind: 'send' }
  const state = await hold.state(client).catch(() => hold.peek())
  if (state.status !== 'clear') return { kind: 'held', state }
  const settled = settledHashOf(state.settled)
  if (settled && state.settled?.result === 'success') return { kind: 'settled', hash: settled as Hex }
  return status.held ? { kind: 'send' } : { kind: 'unverified' }
}

/**
 * A chain's saved launch submission (its hash, or Safe proposal), recovered
 * through its hold before anything is sent or discarded (the shared recovery rule):
 * - `held`: the hold still holds it; show its state, with the SDK's warned exit when due;
 * - `settled`: the hold proved it ran; follow that transaction (the domain checks);
 * - `failed`: the hold proved it failed; the launch may be sent again;
 * - `check`: it can't be checked here; the user checks it, and only that retires it.
 * A record with no hold (the last release's, or cleared storage) is adopted by the hold
 * first. A Safe proposal with no follower here gets one look for its execution, else
 * its unproven end goes to the hold. Nothing here throws.
 */
export async function recoverSavedLaunch(
  hold: WriteHoldHandle,
  client: WriteHoldClient,
  saved: { hash?: Hex; safeTxHash?: Hex },
  lookForExecution?: (safeTxHash: Hex) => Promise<Hex | null>,
): Promise<{ kind: 'held'; state: WriteHeldState } | { kind: 'settled'; hash: Hex } | { kind: 'failed' } | { kind: 'check'; reason: string }> {
  try {
    let state = await hold.state(client)
    if (state.status === 'clear' && !state.settled) {
      state = await hold.adopt(state, saved.safeTxHash ? { safe: { safeTxHash: saved.safeTxHash } } : { hash: saved.hash }, client)
    }
    if (saved.safeTxHash && state.status !== 'clear') {
      const execution = await lookForExecution?.(saved.safeTxHash).catch(() => null)
      state = execution
        ? await hold.onExecuted(client, execution)
        : await hold.onUnproven(client, saved.safeTxHash)
    }
    if (state.status !== 'clear') return { kind: 'held', state }
    const settled = state.settled
    if (settled && 'hash' in settled && settled.result === 'success') return { kind: 'settled', hash: settled.hash }
    if (settled?.result === 'failed') return { kind: 'failed' }
    return { kind: 'check', reason: 'This launch could not be checked here.' }
  } catch (error) {
    return { kind: 'check', reason: error instanceof Error ? error.message : String(error) }
  }
}
