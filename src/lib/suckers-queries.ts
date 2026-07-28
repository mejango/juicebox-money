/**
 * Bendystraw sucker/bridge queries: the "Queued movements" data for the
 * Settlement section. Every movement is reconstructed from four indexed
 * bridge events — the outbox leaf (a queued move), the toRemote send, the
 * destination inbox root, and the claim — and folded into one status per
 * leaf. Typed by hand, auditable end to end (bendystraw.ts convention).
 *
 * IMPORTANT: bendystraw does NOT index merkle inclusion proofs, and the
 * outbox event does not carry the leaf's `metadata` word. A claim
 * (JBSucker.claim) needs both the full leaf AND a 32-entry proof, so this
 * data can surface a movement's STATUS but can never build a claim. The SDK
 * reconstructs and verifies that claim payload on-chain at claim time.
 */

import { bendystraw, getProject } from '@/lib/bendystraw'
import { suckerBytes32ToAddress } from '@bananapus/nana-sdk-core/v6'

/** A bytes32-packed EVM address (left-padded) unpacked to its 20-byte form. */
function unpackAddress(bytes32: string): string {
  return suckerBytes32ToAddress(bytes32 as `0x${string}`).toLowerCase()
}

type OutboxRow = {
  chainId: number
  timestamp: number
  txHash: string
  sucker: string
  peer: string
  peerChainId: number
  token: string
  beneficiary: string
  projectTokenCount: string
  terminalTokenAmount: string
  index: number
  root: string
}

type RemoteRow = {
  chainId: number
  sucker: string
  peerChainId: number
  token: string
  index: number
  root: string
}

type ClaimRow = {
  chainId: number
  sucker: string
  peerChainId: number
  beneficiary: string
  projectTokenCount: string
  terminalTokenAmount: string
  index: number
}

type InboxRow = {
  chainId: number
  sucker: string
  peerChainId: number
  root: string
}

/** A single queued cross-chain movement, folded to one status. */
export type BridgeMovement = {
  /** Stable row key. */
  id: string
  sourceChainId: number
  destChainId: number
  /** The sucker the move was queued on (source chain). */
  sourceSucker: string
  /** The destination sucker (unpacked from the outbox `peer`). */
  destSucker: string
  /** The terminal token bridged on the source chain. */
  token: string
  /** The leaf index in the source outbox tree. */
  index: number
  /** The recipient on the destination chain (unpacked). */
  beneficiary: string
  /** Project tokens bridged, 18-dec fixed point. */
  projectTokenCount: string
  /** Backing terminal tokens bridged. */
  terminalTokenAmount: string
  timestamp: number
  txHash: string
  /**
   * pending  — queued in the outbox, not yet shipped (toRemote available).
   * sent     — shipped over the bridge, not yet delivered to the destination.
   * claimable — the destination inbox has received this move's root.
   * (claimed movements are dropped — they live in the activity feed.)
   */
  status: 'pending' | 'sent' | 'claimable'
}

const BRIDGE_EVENTS_QUERY = `
  query($suckerGroupId: String!) {
    bridgeToOutboxEvents(
      where: { suckerGroupId: $suckerGroupId, version: 6 }
      orderBy: "timestamp"
      orderDirection: "desc"
      limit: 500
    ) {
      items {
        chainId timestamp txHash sucker peer peerChainId token beneficiary
        projectTokenCount terminalTokenAmount index root
      }
    }
    bridgeToRemoteEvents(
      where: { suckerGroupId: $suckerGroupId, version: 6 }
      limit: 500
    ) {
      items { chainId sucker peerChainId token index root }
    }
    bridgeClaimEvents(
      where: { suckerGroupId: $suckerGroupId, version: 6 }
      limit: 500
    ) {
      items {
        chainId sucker peerChainId beneficiary projectTokenCount
        terminalTokenAmount index
      }
    }
    inboxRootReceivedEvents(
      where: { suckerGroupId: $suckerGroupId, version: 6 }
      limit: 500
    ) {
      items { chainId sucker peerChainId root }
    }
  }
`

/**
 * Queued cross-chain movements for a project's sucker group, newest first,
 * with claimed movements dropped. Resolves the sucker group from the given
 * chain + project when one isn't supplied. Returns [] when the project has
 * no sucker group (nothing to bridge).
 */
export async function getBridgeMovements(args: {
  suckerGroupId?: string
  chainId?: number
  projectId?: number
}): Promise<BridgeMovement[]> {
  let suckerGroupId = args.suckerGroupId
  if (!suckerGroupId && args.chainId && args.projectId) {
    const project = await getProject(args.chainId, args.projectId)
    suckerGroupId = project?.suckerGroupId ?? undefined
  }
  if (!suckerGroupId) return []

  const data = await bendystraw<{
    bridgeToOutboxEvents: { items: OutboxRow[] }
    bridgeToRemoteEvents: { items: RemoteRow[] }
    bridgeClaimEvents: { items: ClaimRow[] }
    inboxRootReceivedEvents: { items: InboxRow[] }
  }>(BRIDGE_EVENTS_QUERY, { suckerGroupId }, { revalidate: 20 })

  const outbox = data.bridgeToOutboxEvents.items
  const remote = data.bridgeToRemoteEvents.items
  const claims = data.bridgeClaimEvents.items
  const inbox = data.inboxRootReceivedEvents.items

  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

  const movements: BridgeMovement[] = []
  for (const o of outbox) {
    const destSucker = unpackAddress(o.peer)
    const beneficiary = unpackAddress(o.beneficiary)

    // Claimed on the destination: same leaf identity landed there. Drop it —
    // the move is finished and shows in the activity feed.
    const claimed = claims.some(
      c =>
        c.chainId === o.peerChainId &&
        eq(c.sucker, destSucker) &&
        c.index === o.index &&
        c.projectTokenCount === o.projectTokenCount &&
        c.terminalTokenAmount === o.terminalTokenAmount &&
        eq(unpackAddress(c.beneficiary), beneficiary),
    )
    if (claimed) continue

    // Delivered: the destination inbox received a tree root that INCLUDES
    // this leaf. Each outbox leaf stores the root as of its own insertion
    // and a toRemote ships only the LATEST root, so resolve the received
    // root back to the outbox leaf that produced it and compare indexes —
    // any root minted at or after this leaf's index covers it.
    const delivered = inbox.some(
      i =>
        i.chainId === o.peerChainId &&
        eq(i.sucker, destSucker) &&
        outbox.some(
          sibling =>
            sibling.chainId === o.chainId &&
            eq(sibling.sucker, o.sucker) &&
            eq(sibling.token, o.token) &&
            eq(sibling.root, i.root) &&
            sibling.index >= o.index,
        ),
    )

    // Shipped: a toRemote on the source carried this leaf. Exact root match
    // covers the last leaf of a batch; the index test covers earlier leaves
    // a single toRemote also shipped (toRemote sends the whole outbox).
    const shipped = remote.some(
      r =>
        r.chainId === o.chainId &&
        eq(r.sucker, o.sucker) &&
        eq(r.token, o.token) &&
        (eq(r.root, o.root) || r.index >= o.index),
    )

    const status: BridgeMovement['status'] = delivered
      ? 'claimable'
      : shipped
        ? 'sent'
        : 'pending'

    movements.push({
      id: `${o.chainId}:${o.sucker.toLowerCase()}:${o.token.toLowerCase()}:${o.index}`,
      sourceChainId: o.chainId,
      destChainId: o.peerChainId,
      sourceSucker: o.sucker.toLowerCase(),
      destSucker,
      token: o.token.toLowerCase(),
      index: o.index,
      beneficiary,
      projectTokenCount: o.projectTokenCount,
      terminalTokenAmount: o.terminalTokenAmount,
      timestamp: o.timestamp,
      txHash: o.txHash,
      status,
    })
  }

  return movements.sort((a, b) => b.timestamp - a.timestamp)
}
