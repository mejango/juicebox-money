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
            bridgeToOutboxEvents: {
              items: data.outbox ?? [],
              totalCount: data.outbox?.length ?? 0,
            },
            bridgeToRemoteEvents: {
              items: data.remote ?? [],
              totalCount: data.remote?.length ?? 0,
            },
            bridgeClaimEvents: {
              items: data.claims ?? [],
              totalCount: data.claims?.length ?? 0,
            },
            inboxRootReceivedEvents: {
              items: data.inbox ?? [],
              totalCount: data.inbox?.length ?? 0,
            },
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

describe('bridge movement claim matching', () => {
  const ERC20 = '0xdddddddddddddddddddddddddddddddddddddddd'
  const REMOTE_ERC20 = '0xeeeeeeeeeeeeeeeeeeeeeeee000000000000dddd'

  /** The destination-side claim row for a leaf; `token` is the LOCAL token
   *  on the claiming chain. */
  function claimAt(index: number, token: string) {
    return {
      chainId: 10,
      sucker: DEST_SUCKER,
      peerChainId: 1,
      token,
      beneficiary: packed(BENEFICIARY),
      projectTokenCount: '1000',
      terminalTokenAmount: '10',
      index,
    }
  }

  it('selects the claim token so same-index leaves in other token trees are inspectable', async () => {
    stubBridgeEvents({ outbox: [] })

    await getBridgeMovements({ suckerGroupId: 'group-1' })

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit)?.body)) as {
      query: string
    }
    const claimsSection = body.query.split('bridgeClaimEvents')[1] ?? ''
    expect(claimsSection.split('inboxRootReceivedEvents')[0]).toContain('token')
  })

  it('never lets a native-tree claim mask the same-index leaf of an ERC-20 tree', async () => {
    // Two token trees on the same sucker pair, identical index, amounts, and
    // beneficiary. Only the native leaf was claimed.
    stubBridgeEvents({
      outbox: [outboxLeaf(0), { ...outboxLeaf(0), token: ERC20 }],
      claims: [claimAt(0, TOKEN)],
    })

    const movements = await getBridgeMovements({ suckerGroupId: 'group-1' })

    expect(movements).toHaveLength(1)
    expect(movements[0].token).toBe(ERC20)
    expect(movements[0].status).toBe('pending')
  })

  it('matches an ERC-20 claim across differing local addresses when the pair bridges one ERC-20', async () => {
    // The destination chain's local token address differs from the source
    // token (e.g. USDC), but the sucker bridges a single ERC-20 — the claim
    // is unambiguous.
    stubBridgeEvents({
      outbox: [outboxLeaf(0), { ...outboxLeaf(0), token: ERC20 }],
      claims: [claimAt(0, REMOTE_ERC20)],
    })

    const movements = await getBridgeMovements({ suckerGroupId: 'group-1' })

    expect(movements).toHaveLength(1)
    expect(movements[0].token).toBe(TOKEN)
  })

  it('matches ERC-20 claims by exact address when several ERC-20 trees exist', async () => {
    const OTHER_ERC20 = '0xffffffffffffffffffffffffffffffffffffffff'
    stubBridgeEvents({
      outbox: [
        { ...outboxLeaf(0), token: ERC20 },
        { ...outboxLeaf(0), token: OTHER_ERC20 },
      ],
      claims: [claimAt(0, ERC20)],
    })

    const movements = await getBridgeMovements({ suckerGroupId: 'group-1' })

    expect(movements).toHaveLength(1)
    expect(movements[0].token).toBe(OTHER_ERC20)
  })
})

describe('bridge movement endpoint routing', () => {
  it('routes suckerGroup-keyed reads to the testnet endpoint via the chainId hint', async () => {
    stubBridgeEvents({})

    await getBridgeMovements({ suckerGroupId: 'group-1', chainId: 84532 })

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://testnet.bendystraw.xyz/graphql',
    )
  })

  it('stays on the default endpoint without a hint', async () => {
    stubBridgeEvents({})

    await getBridgeMovements({ suckerGroupId: 'group-1' })

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://bendystraw.up.railway.app/graphql',
    )
  })
})
