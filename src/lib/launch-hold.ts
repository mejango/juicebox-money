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
