import { describe, expect, it, vi } from 'vitest'
import { getBridgeMovements } from '@/lib/suckers-queries'

const SOURCE_SUCKER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const DEST_SUCKER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const TOKEN = '0x000000000000000000000000000000000000eeee'
const BENEFICIARY = '0xcccccccccccccccccccccccccccccccccccccccc'

/** Left-pad an address to the bytes32 form bendystraw stores. */
function packed(address: string): string {
  return `0x${'0'.repeat(24)}${address.slice(2)}`
}

/** Roots are opaque 32-byte identifiers; each leaf's outbox row stores the
 *  tree root AFTER that leaf was inserted. */
function rootAt(index: number): string {
  return `0x${String(index + 1).repeat(2).padStart(64, '0')}`
}

function outboxLeaf(index: number) {
  return {
    chainId: 1,
    timestamp: 1_700_000_000 + index,
    txHash: `0x${String(index + 1).padStart(64, 'f')}`,
    sucker: SOURCE_SUCKER,
    peer: packed(DEST_SUCKER),
    peerChainId: 10,
    token: TOKEN,
    beneficiary: packed(BENEFICIARY),
    projectTokenCount: '1000',
    terminalTokenAmount: '10',
    index,
    root: rootAt(index),
  }
}

/** A toRemote ships the whole outbox — one send at `index` covers every
 *  leaf at or below it. */
function remoteSend(index: number) {
  return {
    chainId: 1,
    sucker: SOURCE_SUCKER,
    peerChainId: 10,
    token: TOKEN,
    index,
    root: rootAt(index),
  }
}

/** The destination inbox holding the root produced at outbox `index`. */
function inboxAt(index: number) {
  return {
    chainId: 10,
    sucker: DEST_SUCKER,
    peerChainId: 1,
    root: rootAt(index),
  }
}

function stubBridgeEvents(data: {
  outbox?: unknown[]
  remote?: unknown[]
  claims?: unknown[]
  inbox?: unknown[]
}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: {
            bridgeToOutboxEvents: { items: data.outbox ?? [] },
            bridgeToRemoteEvents: { items: data.remote ?? [] },
            bridgeClaimEvents: { items: data.claims ?? [] },
            inboxRootReceivedEvents: { items: data.inbox ?? [] },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ),
  )
}

function statusByIndex(
  movements: Awaited<ReturnType<typeof getBridgeMovements>>,
): Record<number, string> {
  return Object.fromEntries(movements.map(m => [m.index, m.status]))
}

describe('bridge movement delivery detection', () => {
  it('marks every leaf of a batch claimable when the inbox holds the latest root', async () => {
    // One toRemote ships leaves 0-2 but only leaf 2's root ever reaches the
    // inbox — the earlier leaves are inside that tree and just as claimable.
    stubBridgeEvents({
      outbox: [outboxLeaf(0), outboxLeaf(1), outboxLeaf(2)],
      remote: [remoteSend(2)],
      inbox: [inboxAt(2)],
    })

    const movements = await getBridgeMovements({ suckerGroupId: 'group-1' })

    expect(movements).toHaveLength(3)
    expect(statusByIndex(movements)).toEqual({
      0: 'claimable',
      1: 'claimable',
      2: 'claimable',
    })
  })

  it('keeps leaves above the delivered root index in transit', async () => {
    // The inbox holds the root produced at leaf 1: leaves 0-1 are delivered,
    // leaf 2 was shipped later and is still bridging.
    stubBridgeEvents({
      outbox: [outboxLeaf(0), outboxLeaf(1), outboxLeaf(2)],
      remote: [remoteSend(2)],
      inbox: [inboxAt(1)],
    })

    const movements = await getBridgeMovements({ suckerGroupId: 'group-1' })

    expect(statusByIndex(movements)).toEqual({
      0: 'claimable',
      1: 'claimable',
      2: 'sent',
    })
  })

  it('never treats a root received on a different sucker pair as delivery', async () => {
    stubBridgeEvents({
      outbox: [outboxLeaf(0)],
      remote: [remoteSend(0)],
      inbox: [{ ...inboxAt(0), sucker: SOURCE_SUCKER }],
    })

    const movements = await getBridgeMovements({ suckerGroupId: 'group-1' })

    expect(statusByIndex(movements)).toEqual({ 0: 'sent' })
  })
})
