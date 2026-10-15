import { intent, launchIntent, type SavedAttempt } from '@bananapus/nana-sdk-core/review'
import type { JBChainId } from '@bananapus/nana-sdk-core'
import type { Address, Hex, PublicClient } from 'viem'
import { projectIdFromReceipt } from '@/lib/launch'
import { strictRetirable } from '@/lib/write-holds'
import { isLaunchChainSuccess, loadLaunchSession, type LaunchChainStatus } from '@/lib/launch-session'

type Launch = { chainId: number; account: Address; salt: Hex; projectUri: string }

/** A direct launch's hold key on one chain: the SDK's launchIntent of the frozen launch (its salt and project metadata). */
export function launchNamespace({ chainId, account, salt, projectUri }: Launch): string {
  return launchIntent({ chainId, account, config: { salt: intent.hex(salt), projectUri } })
}

/** Whether a chain's journal says a launch request may already be out (a hash, a proposal, or a wallet that was open). */
export function launchMayBeOut(status: LaunchChainStatus | undefined): boolean {
  return !!status && !isLaunchChainSuccess(status) &&
    (!!status.txHash || !!status.safeProposalHash || !!status.unverifiedSend || !!status.held || status.phase === 'signing' || status.phase === 'uncertain')
}

/**
 * A chain's saved launch as the SDK's saved-attempt recovery reads it: only
 * what the journal saved, so it is recovered before any fee read or rebuild.
 * Its domain check is the launch's own receipt naming its project; the
 * journal's strict re-read is the final say before a check or exit retires it.
 * The journal is domain data only: the SDK decides whether it may be sent.
 */
export function launchAttemptOf({ client, status, pinnedCall, ...launch }: Launch & {
  client: Pick<PublicClient, 'getTransactionReceipt'>
  status?: LaunchChainStatus
  /** The pinned launch call, built with no fee read: a saved hash the hold doesn't know is adopted against it. */
  pinnedCall?: { to: Address; data: Hex; value: bigint }
}): SavedAttempt<number> {
  const { chainId, account, salt } = launch
  const call = status?.directSafeCall ?? pinnedCall
  const attempt: SavedAttempt<number> = {
    chainId,
    account,
    safe: !!status?.safeProposalHash || !!status?.directSafeCall,
    namespaces: [launchNamespace(launch)],
    ...(call ? { call: { to: call.to, data: call.data, value: call.value } } : {}),
    saved: {
      started: true,
      ...(status?.safeProposalHash ? { safeTxHash: status.safeProposalHash } : status?.txHash ? { hash: status.txHash } : {}),
    },
    async authenticate(hash) {
      if (!hash) return { result: 'unknown' }
      const receipt = await client.getTransactionReceipt({ hash }).catch(() => null)
      if (!receipt) return { result: 'unknown' }
      if (receipt.status !== 'success') return { result: 'not-this', reason: 'The launch reverted.' }
      const projectId = projectIdFromReceipt(receipt, chainId as JBChainId)
      return projectId ? { result: 'proven', value: projectId } : { result: 'unknown' }
    },
    // A strict, fresh read: storage that can't be read refuses (but under the warned exit). A success saved here or by another tab is kept.
    confirmRetirable: strictRetirable(() => attempt, () => {
      const session = loadLaunchSession({ strict: true })
      return !!session && session.salt === salt && !isLaunchChainSuccess(session.statuses[chainId])
    }),
  }
  return attempt
}
