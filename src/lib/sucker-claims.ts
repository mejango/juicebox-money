/**
 * Client-side V6 sucker claim builder (website/ parity: the discover.js
 * outbox-tree reconstruction). A claim (JBSucker.claim) needs the full leaf
 * — including the `metadata` word bendystraw doesn't index — and a 32-entry
 * merkle inclusion proof. Both are derivable with no service dependency:
 * every leaf is emitted by `InsertToOutboxTree`, so this module scans those
 * logs, rebuilds the depth-32 MerkleLib incremental tree, and verifies the
 * proof against the live destination inbox root before handing back the
 * `{ token, leaf, proof }` the SDK's `buildBridgeClaimTx` takes.
 *
 * Every claim is guarded three ways before it can reach a wallet: the
 * reconstructed tree must reproduce the on-chain emitted root, the built
 * proof must reproduce the destination inbox root, and useSafeTx simulates
 * the exact call. A bad proof fails loud here, never on-chain.
 */

import {
  encodeAbiParameters,
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'
import type { JBClaim, JBLeafProof } from '@bananapus/nana-sdk-core/v6'
import type { BridgeMovement } from '@/lib/suckers-queries'

// ------------------------------------------------------------ inline ABIs --

/**
 * The outbox-leaf event (IJBSucker.sol). The SDK's jbSuckerV6Abi carries only
 * prepare/toRemote/claim, so the event and tree views are inlined here.
 */
const INSERT_TO_OUTBOX_EVENT = {
  type: 'event',
  name: 'InsertToOutboxTree',
  inputs: [
    { name: 'beneficiary', type: 'bytes32', indexed: true },
    { name: 'token', type: 'address', indexed: true },
    { name: 'hashed', type: 'bytes32', indexed: false },
    { name: 'index', type: 'uint256', indexed: false },
    { name: 'root', type: 'bytes32', indexed: false },
    { name: 'projectTokenCount', type: 'uint256', indexed: false },
    { name: 'terminalTokenAmount', type: 'uint256', indexed: false },
    { name: 'metadata', type: 'bytes32', indexed: false },
    { name: 'caller', type: 'address', indexed: false },
  ],
} as const

const SUCKER_TREE_ABI = [
  {
    type: 'function',
    name: 'outboxOf',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [
      {
        name: 'outbox',
        type: 'tuple',
        components: [
          { name: 'nonce', type: 'uint64' },
          { name: 'numberOfClaimsSent', type: 'uint192' },
          { name: 'balance', type: 'uint256' },
          {
            name: 'tree',
            type: 'tuple',
            components: [
              { name: 'branch', type: 'bytes32[32]' },
              { name: 'count', type: 'uint256' },
            ],
          },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'inboxOf',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [
      {
        name: 'inbox',
        type: 'tuple',
        components: [
          { name: 'nonce', type: 'uint64' },
          { name: 'root', type: 'bytes32' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'executedLeafHashOf',
    stateMutability: 'view',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'index', type: 'uint256' },
    ],
    outputs: [{ type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'remoteTokenFor',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [
      {
        name: 'remoteToken',
        type: 'tuple',
        components: [
          { name: 'enabled', type: 'bool' },
          { name: 'emergencyHatch', type: 'bool' },
          { name: 'minGas', type: 'uint32' },
          { name: 'addr', type: 'bytes32' },
        ],
      },
    ],
  },
] as const

// --------------------------------------------------------- merkle toolkit --

const TREE_DEPTH = 32
const ZERO_BYTES32 = `0x${'0'.repeat(64)}` as Hex
/** MerkleLib's empty-tree root — the z[32] the hashing scheme must reproduce. */
const EMPTY_TREE_ROOT =
  '0x27ae5ba08d7291c96c8cbddcc148bf48a6d68c7974b94356f53754ef6171d757'

/** MerkleLib node hash: keccak of the ABI-encoded (not packed) bytes32 pair. */
function hashPair(a: Hex, b: Hex): Hex {
  return keccak256(
    encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [a, b]),
  )
}

let zCache: Hex[] | null = null

/** z[0..32]: the all-empty subtree hash per depth, self-checked at z[32]. */
function zeroHashes(): Hex[] {
  if (zCache) return zCache
  const z: Hex[] = [ZERO_BYTES32]
  for (let i = 0; i < TREE_DEPTH; i++) z.push(hashPair(z[i], z[i]))
  if (z[TREE_DEPTH] !== EMPTY_TREE_ROOT) {
    throw new Error('Merkle hashing self-check failed.')
  }
  zCache = z
  return z
}

/**
 * The 32-sibling inclusion path for `index` over a dense leaf-hash set,
 * zero-hash-filled where the tree has no sibling yet.
 */
function leafProof(leafHashes: Hex[], index: number): JBLeafProof {
  const z = zeroHashes()
  const proof: Hex[] = []
  let level = leafHashes
  let pos = index
  for (let depth = 0; depth < TREE_DEPTH; depth++) {
    const sibling = pos ^ 1
    proof.push(sibling < level.length ? level[sibling] : z[depth])
    const next: Hex[] = []
    for (let i = 0; i < level.length; i += 2) {
      next.push(hashPair(level[i], i + 1 < level.length ? level[i + 1] : z[depth]))
    }
    level = next
    pos = pos >> 1
  }
  return proof as unknown as JBLeafProof
}

/** MerkleLib.branchRoot: fold the proof up, index bits picking the side. */
function branchRoot(leaf: Hex, proof: JBLeafProof, index: number): Hex {
  let cur = leaf
  let pos = index
  for (let i = 0; i < TREE_DEPTH; i++) {
    cur = pos & 1 ? hashPair(proof[i], cur) : hashPair(cur, proof[i])
    pos = Math.floor(pos / 2)
  }
  return cur
}

// ---------------------------------------------------------- outbox leaves --

type OutboxLeaf = {
  hashed: Hex
  /** The outbox root emitted when this leaf was inserted. */
  root: Hex
  beneficiary: Hex
  projectTokenCount: bigint
  terminalTokenAmount: bigint
  metadata: Hex
}

/** Leaf history per `chainId:sucker:token` — append-only on-chain, so a
 * cached set only ever needs extending, never invalidating. */
const LEAF_CACHE = new Map<string, OutboxLeaf[]>()

const LOG_WINDOW = 45_000n
// Backstop against unbounded scanning on a provider that rejects wide
// getLogs; deep-history suckers fail loud rather than loop forever.
const MAX_WINDOWS = 200

/**
 * Every outbox leaf for a sucker+token, dense by index. Tries one wide
 * getLogs first (archive providers serve the small topic-filtered set), then
 * scans backward in bounded windows. Incomplete history throws — a short
 * set could only ever build a proof that fails the root checks anyway.
 */
async function outboxLeaves(
  client: PublicClient,
  chainId: number,
  sucker: Address,
  token: Address,
  count: number,
): Promise<OutboxLeaf[]> {
  const key = `${chainId}:${sucker}:${token}`.toLowerCase()
  const cached = LEAF_CACHE.get(key)
  if (cached && cached.length >= count) return cached

  const byIndex = new Map<number, OutboxLeaf>()
  const collect = (
    logs: { args: Record<string, unknown> }[],
  ) => {
    for (const log of logs) {
      const a = log.args
      byIndex.set(Number(a.index), {
        hashed: a.hashed as Hex,
        root: a.root as Hex,
        beneficiary: a.beneficiary as Hex,
        projectTokenCount: a.projectTokenCount as bigint,
        terminalTokenAmount: a.terminalTokenAmount as bigint,
        metadata: a.metadata as Hex,
      })
    }
  }

  const latest = await client.getBlockNumber()
  try {
    collect(
      await client.getLogs({
        address: sucker,
        event: INSERT_TO_OUTBOX_EVENT,
        args: { token },
        fromBlock: 0n,
        toBlock: latest,
        strict: true,
      }),
    )
  } catch {
    byIndex.clear()
    let cursor = latest
    for (let n = 0; n < MAX_WINDOWS && byIndex.size < count; n++) {
      const from = cursor > LOG_WINDOW ? cursor - LOG_WINDOW + 1n : 0n
      collect(
        await client.getLogs({
          address: sucker,
          event: INSERT_TO_OUTBOX_EVENT,
          args: { token },
          fromBlock: from,
          toBlock: cursor,
          strict: true,
        }),
      )
      if (from === 0n) break
      cursor = from - 1n
    }
  }

  const leaves: OutboxLeaf[] = []
  for (let i = 0; i < count; i++) {
    const leaf = byIndex.get(i)
    if (!leaf) {
      throw new Error(
        'The full bridge history could not be read from this RPC — try again shortly.',
      )
    }
    leaves.push(leaf)
  }
  LEAF_CACHE.set(key, leaves)
  return leaves
}

// ------------------------------------------------------------ buildClaim --

/**
 * Build the verified JBClaim for a claimable movement: scan the source
 * outbox, rebuild the tree, and prove the leaf into the destination inbox
 * root. Throws (with user-facing messages) whenever the claim can't be
 * proven — the caller never gets an unverified proof.
 */
export async function buildClaim(
  sourceClient: PublicClient,
  destClient: PublicClient,
  m: BridgeMovement,
): Promise<JBClaim> {
  const sucker = m.sourceSucker as Address
  const token = m.token as Address
  const destSucker = m.destSucker as Address

  const [outbox, remote] = await Promise.all([
    sourceClient.readContract({
      address: sucker,
      abi: SUCKER_TREE_ABI,
      functionName: 'outboxOf',
      args: [token],
    }),
    sourceClient.readContract({
      address: sucker,
      abi: SUCKER_TREE_ABI,
      functionName: 'remoteTokenFor',
      args: [token],
    }),
  ])
  const count = Number(outbox.tree.count)
  if (m.index >= count) {
    throw new Error('This move is not in the outbox tree yet.')
  }
  const remoteToken = `0x${remote.addr.slice(-40)}` as Address
  if (remote.addr === ZERO_BYTES32) {
    throw new Error("The bridged token's destination mapping is unavailable.")
  }

  const leaves = await outboxLeaves(sourceClient, m.sourceChainId, sucker, token, count)
  const leafHashes = leaves.map(l => l.hashed)

  // The reconstructed set must reproduce the root the contract emitted at
  // the last insertion, or nothing derived from it can be trusted.
  const last = leaves[count - 1]
  const lastProof = leafProof(leafHashes, count - 1)
  if (branchRoot(last.hashed, lastProof, count - 1) !== last.root.toLowerCase()) {
    throw new Error('The reconstructed bridge history does not match the on-chain root.')
  }

  const [inbox, executed] = await Promise.all([
    destClient.readContract({
      address: destSucker,
      abi: SUCKER_TREE_ABI,
      functionName: 'inboxOf',
      args: [remoteToken],
    }),
    destClient.readContract({
      address: destSucker,
      abi: SUCKER_TREE_ABI,
      functionName: 'executedLeafHashOf',
      args: [remoteToken, BigInt(m.index)],
    }),
  ])
  if (executed !== ZERO_BYTES32) {
    throw new Error('This move has already been claimed.')
  }

  // The destination knows the tree only up to the last root it received:
  // proofs must be built over exactly that slice.
  const inboxRoot = inbox.root.toLowerCase() as Hex
  let deliveredCount = 0
  for (let i = count - 1; i >= 0; i--) {
    if (leaves[i].root.toLowerCase() === inboxRoot) {
      deliveredCount = i + 1
      break
    }
  }
  if (m.index >= deliveredCount) {
    throw new Error('This move has not been delivered to the destination yet.')
  }

  const proof = leafProof(leafHashes.slice(0, deliveredCount), m.index)
  const leaf = leaves[m.index]
  if (branchRoot(leaf.hashed, proof, m.index) !== inboxRoot) {
    throw new Error(
      'The locally reconstructed bridge proof does not match the destination inbox.',
    )
  }

  return {
    token: remoteToken,
    leaf: {
      index: BigInt(m.index),
      beneficiary: leaf.beneficiary,
      projectTokenCount: leaf.projectTokenCount,
      terminalTokenAmount: leaf.terminalTokenAmount,
      metadata: leaf.metadata,
    },
    proof,
  }
}
