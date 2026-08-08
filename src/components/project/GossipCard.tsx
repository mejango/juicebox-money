'use client'

import {
  JBCoreContracts,
  JBSuckerContracts,
  jbContractAddress,
  jbControllerAbi,
  jbDirectoryAbi,
  jbSuckerRegistryAbi,
  jbTerminalStoreAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import {
  CCIP_SUCKER_TRANSPORT_VALUES,
  NATIVE_SUCKER_TRANSPORT_VALUES,
  assertSuckerTransportValue,
  buildSyncAccountingDataTx,
  classifySuckerTransport,
  findSuckerTransportValue,
  getAccountingContexts,
  getV6SuckerPairs,
  relativeSuckerDrift,
  suckerAccountingContextKey,
  suckerBytes32ToAddress,
  suckerTimestampSeconds,
} from '@bananapus/nana-sdk-core/v6'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  encodeFunctionData,
  type Abi,
  type Address,
  type PublicClient,
} from 'viem'
import { useConfig } from 'wagmi'
import { getPublicClient } from 'wagmi/actions'
import { ChainIcon } from '@/components/ChainIcon'
import { GossipTablesSkeleton } from '@/components/LoadingSkeletons'
import { useSafeTx } from '@/hooks/useSafeTx'
import { useWallet } from '@/hooks/useWallet'
import { formatTokenAmount } from '@/lib/format'
import { isKnownController } from '@/lib/manage'
import { chainName } from '@/lib/urn'
import { PERSIST } from '@/lib/query-persist'
import { explorerTxUrl } from '@/lib/chainDisplay'

// ------------------------------------------------------------ inline ABIs --

type Infra = 'CCIP' | 'native' | 'unknown'

async function classifyInfra(
  client: PublicClient,
  sucker: Address,
): Promise<Infra> {
  const transport = await classifySuckerTransport(client, sucker)
  return transport === 'ccip' ? 'CCIP' : transport
}

const CCIP_LADDER = CCIP_SUCKER_TRANSPORT_VALUES
const SYNC_NATIVE_LADDER = NATIVE_SUCKER_TRANSPORT_VALUES
const FUNDED_BALANCE = 10n ** 21n

/**
 * The msg.value `syncAccountingData` needs, discovered by simulating an
 * increasing value ladder (the first that doesn't revert wins). Never returns
 * 0 for a CCIP sucker — 0 native there triggers LINK-fee mode, which pulls
 * unapproved LINK. Returns null when the infra can't be verified or nothing
 * simulates clean; the caller must NOT fall back to 0. (website/ parity:
 * findSyncValue; jbm parity: SettlementSection.)
 */
async function findSyncValue(
  client: PublicClient,
  chainId: JBChainId,
  sucker: Address,
  infra: Infra,
  account: Address,
): Promise<bigint | null> {
  if (infra === 'unknown') return null
  const request = buildSyncAccountingDataTx({ chainId, sucker })
  const data = encodeFunctionData({
    abi: request.abi,
    functionName: request.functionName,
    args: request.args,
  })
  const ladder = infra === 'CCIP' ? CCIP_LADDER : SYNC_NATIVE_LADDER
  const value = await findSuckerTransportValue(
    ladder,
    candidate =>
      client.call({
        account,
        to: sucker,
        data,
        value: candidate,
        stateOverride: [{ address: account, balance: FUNDED_BALANCE }],
      }),
  )
  if (value !== null) {
    assertSuckerTransportValue(infra === 'CCIP' ? 'ccip' : infra, value)
  }
  return value
}

// ------------------------------------------------------- staleness helpers --

const U128_MAX = (1n << 128n) - 1n

/** Relative drift of two bigints, 0..1. 0/0 → 0. (website/ parity: rel.) */
function rel(a: bigint, b: bigint): number {
  return relativeSuckerDrift(a, b)
}

type Staleness = {
  level: 'synced' | 'slight' | 'danger' | 'unknown'
  label: string
  pct: number
}

/** Drift below the keeper's 5% sync threshold stays green — it's the % that
 *  matters, not the word. (website/ parity: stalenessFromPct.) */
function stalenessFromPct(worst: number): Staleness {
  if (worst === 0) return { level: 'synced', label: 'In sync', pct: 0 }
  const label = `${Math.round(worst * 10_000) / 100}% stale`
  if (worst <= 0.05) return { level: 'slight', label, pct: worst }
  return { level: 'danger', label, pct: worst }
}

type GossipContext = { token: Address; decimals: number; balance: bigint }

/** Fold per-context balances into a key→amount map with u128 saturation, both
 *  per source context and on the running sum. (website/ parity:
 *  gossipContextBalances.) */
function foldBalances(rows: GossipContext[], chainId: number): Record<string, bigint> {
  const out: Record<string, bigint> = {}
  for (const row of rows) {
    const key = suckerAccountingContextKey(
      row.token,
      chainId as JBChainId,
      row.decimals,
    )
    let amount = row.balance
    if (amount > U128_MAX) amount = U128_MAX
    const sum = (out[key] ?? 0n) + amount
    out[key] = sum > U128_MAX ? U128_MAX : sum
  }
  return out
}

const customKeys = (map: Record<string, bigint>) =>
  Object.keys(map)
    .filter(k => !k.startsWith('native@') && !k.startsWith('usdc@'))
    .sort()

type LiveChain = { supply: bigint | null; balances: GossipContext[]; verified: boolean }

/**
 * Freshness of what one chain knows about a peer vs the peer's ACTUAL current
 * values. Worst relative drift of supply and any accounting-context balance.
 *
 * SIMPLIFICATION (documented): the website localizes a peer's custom tokens
 * through the viewing sucker's `remoteTokenFor` mapping before comparing. Here
 * we skip that mapping read — if the snapshot and live custom-token key sets
 * differ, we fail closed to 'Unverified' rather than invent drift (a custom
 * mapping could make the row legitimately in-sync). Native and USDC always
 * compare directly. (website/ parity: gossipAccountingStaleness, minus the
 * remoteTokenFor localization.)
 */
function gossipStaleness(
  snapSupply: bigint,
  snapBalances: GossipContext[],
  viewChainId: number,
  live: LiveChain,
  liveChainId: number,
): Staleness {
  if (!live.verified || live.supply == null) {
    return { level: 'unknown', label: 'Unverified', pct: 0 }
  }
  const snap = foldBalances(snapBalances, viewChainId)
  const liveMap = foldBalances(live.balances, liveChainId)
  const snapCustom = customKeys(snap)
  const liveCustom = customKeys(liveMap)
  if (
    snapCustom.length !== liveCustom.length ||
    !snapCustom.every((key, index) => key === liveCustom[index])
  ) {
    return { level: 'unknown', label: 'Unverified', pct: 0 }
  }
  let worst = rel(snapSupply, live.supply)
  const keys = new Set([...Object.keys(snap), ...Object.keys(liveMap)])
  for (const key of keys) {
    const p = rel(snap[key] ?? 0n, liveMap[key] ?? 0n)
    if (p > worst) worst = p
  }
  return stalenessFromPct(worst)
}

/** 0→never, <60s→just now, <1h→Nm ago, <1d→Nh ago, else Nd ago. */
function snapshotAge(ts: number): string {
  if (!ts) return 'never'
  const s = Math.floor(Date.now() / 1000) - ts
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

// ----------------------------------------------------------- in-flight LS --

/**
 * In-flight sync markers, keyed "projectId:viewChain:peerChain" → unix seconds
 * a push was sent. Persisted so a reload keeps showing "Syncing…" while the
 * push rides the bridge (minutes). Pruned of entries older than 1h.
 *
 * SIMPLIFICATION (documented): the website ALSO merges bendystraw
 * accountingSyncEvents so a push ANY user triggered shows "Syncing…". We use
 * localStorage only — a first-pass, this-device/user view of in-flight syncs.
 */
const GOSSIP_SYNC_LS = 'jb-gossip-sync-at'

function loadSyncMarks(): Record<string, number> {
  if (typeof window === 'undefined') return {}
  let m: Record<string, number>
  try {
    m = (JSON.parse(localStorage.getItem(GOSSIP_SYNC_LS) || '{}') || {}) as Record<
      string,
      number
    >
  } catch {
    m = {}
  }
  const now = Math.floor(Date.now() / 1000)
  let changed = false
  for (const k of Object.keys(m)) {
    if (!(now - m[k] < 3600)) {
      delete m[k]
      changed = true
    }
  }
  if (changed) saveSyncMarks(m)
  return m
}

function saveSyncMarks(m: Record<string, number>) {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(GOSSIP_SYNC_LS, JSON.stringify(m))
  } catch {
    /* storage unavailable */
  }
}

// ------------------------------------------------------------- data model --

type PeerRow = {
  peerChainId: number
  supply: bigint
  balances: GossipContext[]
  snapshot: number
  /** The peer's local sucker that bridges to the viewing chain — the one whose
   *  syncAccountingData re-pushes the peer's accounting to us. */
  syncSucker: Address | null
}
type Block = { chainId: number; projectId: number; peers: PeerRow[] }
type GossipData = { blocks: Block[]; live: Record<number, LiveChain> }

function unpackTs(raw: bigint): number {
  return suckerTimestampSeconds(raw)
}

// ---------------------------------------------------------------- reads --

async function readLiveChain(
  client: PublicClient,
  chainId: number,
  projectId: number,
): Promise<LiveChain> {
  const directory = jbContractAddress['6'][JBCoreContracts.JBDirectory][
    chainId as JBChainId
  ] as Address | undefined
  const terminal = jbContractAddress['6'][JBCoreContracts.JBMultiTerminal][
    chainId as JBChainId
  ] as Address | undefined
  const store = jbContractAddress['6'][JBCoreContracts.JBTerminalStore][
    chainId as JBChainId
  ] as Address | undefined
  if (!directory || !terminal || !store) {
    return { supply: null, balances: [], verified: false }
  }

  const controller = (await client
    .readContract({
      abi: jbDirectoryAbi,
      address: directory,
      functionName: 'controllerOf',
      args: [BigInt(projectId)],
    })
    .catch(() => undefined)) as Address | undefined
  if (!controller || !isKnownController(chainId as JBChainId, controller)) {
    // A custom controller can't be trusted to speak the supply getter — fail
    // closed so the row reads Unverified rather than inventing drift.
    return { supply: null, balances: [], verified: false }
  }
  const supply = (await client
    .readContract({
      abi: jbControllerAbi,
      address: controller,
      functionName: 'totalTokenSupplyWithReservedTokensOf',
      args: [BigInt(projectId)],
    })
    .catch(() => null)) as bigint | null
  if (supply == null) return { supply: null, balances: [], verified: false }

  let contexts
  try {
    contexts = await getAccountingContexts(client, {
      chainId: chainId as JBChainId,
      projectId: BigInt(projectId),
    })
  } catch {
    return { supply: null, balances: [], verified: false }
  }

  let readFailed = false
  const balances = await Promise.all(
    contexts.map(async (ctx): Promise<GossipContext> => {
      const balance = (await client
        .readContract({
          abi: jbTerminalStoreAbi,
          address: store,
          functionName: 'balanceOf',
          args: [terminal, BigInt(projectId), ctx.token],
        })
        .catch(() => {
          readFailed = true
          return 0n
        })) as bigint
      return { token: ctx.token, decimals: ctx.decimals, balance }
    }),
  )
  if (readFailed) return { supply, balances: [], verified: false }
  return { supply, balances, verified: true }
}

// ------------------------------------------------------------- root card --

/**
 * The cross-chain gossip view (website/ parity: renderGossipSection): per
 * chain, what it currently knows about each peer's supply and balances, how
 * fresh that snapshot is vs the peer's ACTUAL current values, and a Sync that
 * re-pushes a peer's accounting here. Every freshness check fails closed to
 * 'Unverified' on any unreadable or ambiguous state rather than inventing
 * drift, and the Sync send never bypasses useSafeTx.
 */
export function GossipCard({
  projectId,
  chains,
}: {
  chainId: JBChainId
  projectId: number
  chains: [number, number][]
}) {
  const config = useConfig()

  // In-flight markers live in card state (seeded from localStorage) so a Sync
  // submit re-renders every row's pending status.
  const [syncMarks, setSyncMarks] = useState<Record<string, number>>({})
  useEffect(() => setSyncMarks(loadSyncMarks()), [])

  const markSyncSent = useCallback((key: string) => {
    setSyncMarks(prev => {
      const next = { ...prev, [key]: Math.floor(Date.now() / 1000) }
      saveSyncMarks(next)
      return next
    })
  }, [])
  const clearSyncMark = useCallback((key: string) => {
    setSyncMarks(prev => {
      if (!(key in prev)) return prev
      const next = { ...prev }
      delete next[key]
      saveSyncMarks(next)
      return next
    })
  }, [])

  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: ['gossip', chains],
    meta: PERSIST,
    staleTime: 30_000,
    retry: 1,
    enabled: chains.length >= 2,
    queryFn: async (): Promise<GossipData> => {
      // Per-chain sucker pairs (each row's syncSucker/viewSucker come from here).
      const pairsByChain: Record<number, { local: Address; remoteChainId: number }[]> =
        {}
      await Promise.all(
        chains.map(async ([cid, pid]) => {
          const client = getPublicClient(config, {
            chainId: cid as JBChainId,
          }) as PublicClient | undefined
          if (!client) {
            pairsByChain[cid] = []
            return
          }
          const pairs = await getV6SuckerPairs(client, {
            chainId: cid as JBChainId,
            projectId: BigInt(pid),
          }).catch(() => [])
          pairsByChain[cid] = pairs.map(p => ({
            local: p.local,
            remoteChainId: Number(p.remoteChainId),
          }))
        }),
      )

      // Each chain's ACTUAL current values — the baseline every snapshot is
      // compared against.
      const live: Record<number, LiveChain> = {}
      await Promise.all(
        chains.map(async ([cid, pid]) => {
          const client = getPublicClient(config, {
            chainId: cid as JBChainId,
          }) as PublicClient | undefined
          live[cid] = client
            ? await readLiveChain(client, cid, pid).catch(() => ({
                supply: null,
                balances: [],
                verified: false,
              }))
            : { supply: null, balances: [], verified: false }
        }),
      )

      // Per viewing chain A: the registry's aggregated view of what A knows
      // about every peer. Reading the registry (not individual suckers) folds
      // direct + transitively-gossiped records.
      const blocks = await Promise.all(
        chains.map(async ([cid, pid]): Promise<Block> => {
          const client = getPublicClient(config, {
            chainId: cid as JBChainId,
          }) as PublicClient | undefined
          const registry = jbContractAddress['6'][
            JBSuckerContracts.JBSuckerRegistry
          ][cid as JBChainId] as Address | undefined

          const byPeer: Record<
            number,
            { supply: bigint; balances: GossipContext[]; snapshot: number }
          > = {}
          if (client && registry) {
            const accounts = (await client
              .readContract({
                address: registry,
                abi: jbSuckerRegistryAbi,
                functionName: 'peerChainAccountsOf',
                args: [BigInt(pid), BigInt(cid)],
              })
              .catch(() => [])) as readonly {
              chainId: bigint
              totalSupply: bigint
              contexts: readonly {
                token: `0x${string}`
                decimals: number
                surplus: bigint
                balance: bigint
              }[]
              timestamp: bigint
            }[]
            for (const a of accounts) {
              const peer = Number(a.chainId)
              byPeer[peer] = {
                supply: a.totalSupply,
                snapshot: unpackTs(a.timestamp),
                balances: a.contexts.map(c => ({
                  token: suckerBytes32ToAddress(c.token),
                  decimals: Number(c.decimals),
                  balance: c.balance,
                })),
              }
            }
          }

          // One row per peer chain the project spans (unknown peers = snapshot 0).
          const peers: PeerRow[] = chains
            .filter(([other]) => other !== cid)
            .map(([other]): PeerRow => {
              const rec = byPeer[other] ?? {
                supply: 0n,
                balances: [] as GossipContext[],
                snapshot: 0,
              }
              const syncSucker =
                (pairsByChain[other] ?? []).find(q => q.remoteChainId === cid)
                  ?.local ?? null
              return {
                peerChainId: other,
                supply: rec.supply,
                balances: rec.balances,
                snapshot: rec.snapshot,
                syncSucker,
              }
            })

          return { chainId: cid, projectId: pid, peers }
        }),
      )

      return { blocks, live }
    },
  })

  // Which chains each chain already knows with a real snapshot — a sync from a
  // peer re-gossips everything IT knows, so one sync can cover those too.
  const knownByChain = useMemo(() => {
    const m: Record<number, number[]> = {}
    for (const b of data?.blocks ?? []) {
      m[b.chainId] = b.peers.filter(p => p.snapshot).map(p => p.peerChainId)
    }
    return m
  }, [data])

  if (chains.length < 2) return null

  return (
    <div className="card p-5">
      <div>
        <span className="field-label">Sync accounting</span>
        <p className="mt-2 text-sm leading-relaxed text-smoke-700">
          Each chain&apos;s cash out and loan availability depends on knowing the
          project&apos;s composition on the other chains.
        </p>
      </div>
      {isLoading ? (
        <GossipTablesSkeleton groups={chains.length} />
      ) : isError || !data ? (
        <p className="mt-3 text-sm text-smoke-700">
          Couldn&apos;t verify cross-chain gossip state right now.
        </p>
      ) : !data.blocks.some(b => b.peers.length) ? (
        <p className="mt-3 text-sm leading-relaxed text-smoke-700">
          No linked chains to sync from.
        </p>
      ) : (
        <div
          className={`space-y-6${isFetching ? ' revalidating' : ''}`}
          aria-busy={isFetching || undefined}
        >
          {data.blocks
            .filter(b => b.peers.length)
            .map(block => (
              <GossipBlock
                key={block.chainId}
                block={block}
                live={data.live}
                knownByChain={knownByChain}
                projectId={projectId}
                syncMarks={syncMarks}
                onSyncSent={markSyncSent}
                onSyncCleared={clearSyncMark}
                onSynced={() => refetch()}
              />
            ))}
        </div>
      )}
    </div>
  )
}

// -------------------------------------------------------------- per-block --

function GossipBlock({
  block,
  live,
  knownByChain,
  projectId,
  syncMarks,
  onSyncSent,
  onSyncCleared,
  onSynced,
}: {
  block: Block
  live: Record<number, LiveChain>
  knownByChain: Record<number, number[]>
  projectId: number
  syncMarks: Record<string, number>
  onSyncSent: (key: string) => void
  onSyncCleared: (key: string) => void
  onSynced: () => void
}) {
  const A = block.chainId

  // Per-peer staleness + transitive-dedup coverage (website/ parity:
  // extrasByPeer / coveredByOther). A stale, syncable peer's sync re-gossips
  // its extras, so those extras are "covered by other". Coverage is computed
  // from staleness only (not in-flight state).
  const view = useMemo(() => {
    const extrasByPeer: Record<number, number[]> = {}
    const coveredByOther: Record<number, boolean> = {}
    const staleByPeer: Record<number, Staleness> = {}

    for (const p of block.peers) {
      const extras = (knownByChain[p.peerChainId] ?? []).filter(
        cid => cid !== A && cid !== p.peerChainId,
      )
      extrasByPeer[p.peerChainId] = extras
      const st = gossipStaleness(
        p.supply,
        p.balances,
        A,
        live[p.peerChainId] ?? { supply: null, balances: [], verified: false },
        p.peerChainId,
      )
      staleByPeer[p.peerChainId] = st
      if (p.syncSucker && st.level !== 'synced' && st.level !== 'unknown') {
        for (const cid of extras) coveredByOther[cid] = true
      }
    }
    return { extrasByPeer, coveredByOther, staleByPeer }
  }, [block, live, knownByChain, A])

  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-sm font-medium text-ink">
        <ChainIcon chainId={A} size={16} />
        {chainName(A)} knows
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[680px] table-fixed text-sm">
          {/* Shared column geometry so every "X knows" block lines up. */}
          <colgroup>
            <col className="w-[150px]" />
            <col className="w-[110px]" />
            <col className="w-[84px]" />
            <col />
            <col className="w-[92px]" />
            <col className="w-[92px]" />
          </colgroup>
          <thead>
            <tr className="text-left text-xs text-smoke-500">
              <th className="pb-1.5 font-normal">Chain</th>
              <th className="pb-1.5 font-normal">Status</th>
              <th className="pb-1.5 font-normal" />
              <th className="pb-1.5 text-right font-normal">Supply</th>
              <th className="pb-1.5 text-right font-normal">Balance</th>
              <th className="pb-1.5 text-right font-normal">Snapshot</th>
            </tr>
          </thead>
          <tbody className="text-ink">
            {block.peers.map(peer => {
              const extras = view.extrasByPeer[peer.peerChainId] ?? []
              const redundant =
                !!view.coveredByOther[peer.peerChainId] && extras.length === 0
              return (
                <GossipRow
                  key={peer.peerChainId}
                  viewChainId={A}
                  peer={peer}
                  staleness={view.staleByPeer[peer.peerChainId]}
                  extras={extras}
                  redundant={redundant}
                  projectId={projectId}
                  syncMarks={syncMarks}
                  onSyncSent={onSyncSent}
                  onSyncCleared={onSyncCleared}
                  onSynced={onSynced}
                />
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- per-row --

const STATUS_COLOR: Record<Staleness['level'], string> = {
  synced: 'text-emerald-600',
  slight: 'text-amber-600',
  danger: 'text-red-600',
  unknown: 'text-smoke-500',
}

function GossipRow({
  viewChainId,
  peer,
  staleness,
  extras,
  redundant,
  projectId,
  syncMarks,
  onSyncSent,
  onSyncCleared,
  onSynced,
}: {
  viewChainId: number
  peer: PeerRow
  staleness: Staleness
  extras: number[]
  redundant: boolean
  projectId: number
  syncMarks: Record<string, number>
  onSyncSent: (key: string) => void
  onSyncCleared: (key: string) => void
  onSynced: () => void
}) {
  const config = useConfig()
  const { isConnected, address, openSignIn } = useWallet()
  const tx = useSafeTx(peer.peerChainId)
  const [checking, setChecking] = useState(false)
  const [flowError, setFlowError] = useState<string | null>(null)

  const key = `${projectId}:${viewChainId}:${peer.peerChainId}`

  // In-flight: a push was sent and the fresher snapshot hasn't landed yet. A
  // snapshot at/after the send time means it has caught up (no longer pending).
  const syncedAt = syncMarks[key]
  const caughtUp = !!(syncedAt && peer.snapshot && peer.snapshot >= syncedAt)
  const nowS = Math.floor(Date.now() / 1000)
  const pending = !!syncedAt && !caughtUp && nowS - syncedAt < 1800

  // Clear a marker once the accepted snapshot catches up.
  useEffect(() => {
    if (caughtUp) onSyncCleared(key)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caughtUp])

  const busy = checking || tx.busy

  const txUrl = tx.hash ? explorerTxUrl(peer.peerChainId, tx.hash) : null

  // Sync only when there's drift to reconcile (or a push is mid-flight) and the
  // row isn't already covered by another syncable peer's sync.
  const showSync =
    !!peer.syncSucker &&
    (pending ||
      (staleness.level !== 'synced' &&
        staleness.level !== 'unknown' &&
        !redundant))

  // Mark in-flight the moment the tx enters the mempool; clear on failure;
  // re-mark and refetch once it lands.
  useEffect(() => {
    if (tx.phase === 'pending') onSyncSent(key)
    else if (tx.phase === 'error') onSyncCleared(key)
    else if (tx.phase === 'success') {
      onSyncSent(key)
      onSynced()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tx.phase])

  const sync = async () => {
    if (busy || !peer.syncSucker) return
    if (!isConnected || !address) {
      openSignIn()
      return
    }
    setFlowError(null)
    setChecking(true)
    try {
      const client = getPublicClient(config, {
        chainId: peer.peerChainId as JBChainId,
      }) as PublicClient | undefined
      if (!client) throw new Error(`Unsupported chain ${peer.peerChainId}.`)
      const infra = await classifyInfra(client, peer.syncSucker)
      const targetChainId = peer.peerChainId as JBChainId
      const value = await findSyncValue(
        client,
        targetChainId,
        peer.syncSucker,
        infra,
        address,
      )
      if (value === null) {
        throw new Error(
          'The bridge fee could not be determined yet — try again shortly.',
        )
      }
      const request = buildSyncAccountingDataTx({
        chainId: targetChainId,
        sucker: peer.syncSucker,
        value,
      })
      await tx.send({ ...request, abi: request.abi as unknown as Abi })
    } catch (e) {
      setFlowError(e instanceof Error ? e.message : 'Could not sync.')
    } finally {
      setChecking(false)
    }
  }

  const balanceStr = peer.balances.length
    ? peer.balances
        .map(b => formatTokenAmount(b.balance, b.decimals))
        .join(' | ')
    : '0'

  const syncLabel = checking
    ? 'Reading fee…'
    : tx.phase === 'simulating'
      ? 'Double-checking…'
      : tx.phase === 'signing'
        ? 'Confirm…'
        : tx.phase === 'pending'
          ? 'Syncing…'
          : pending
            ? 'Sent'
            : 'Sync'

  return (
    <tr className="border-t border-smoke-100 align-top">
      <td className="py-1.5 pr-3">
        <span className="flex items-center gap-2">
          <ChainIcon chainId={peer.peerChainId} size={16} />
          {chainName(peer.peerChainId)}
        </span>
      </td>
      <td className="py-1.5 pr-3">
        {pending ? (
          <span className="text-amber-600" title="A snapshot was pushed and is arriving over the bridge (a few minutes).">
            Syncing…
          </span>
        ) : (
          <span className={`whitespace-nowrap ${STATUS_COLOR[staleness.level]}`}>
            {staleness.label}
          </span>
        )}
      </td>
      <td className="py-1.5 pr-3">
        {showSync ? (
          <div className="flex flex-col items-start gap-0.5">
            <button
              onClick={sync}
              disabled={busy || pending}
              className="text-xs font-medium text-bluebs-600 hover:text-bluebs-700 disabled:opacity-50"
              title={
                pending
                  ? 'Sync in flight — arrives in a few minutes'
                  : `Run syncAccountingData on ${chainName(peer.peerChainId)} so it re-pushes its accounting here`
              }
            >
              {syncLabel}
            </button>
            {!pending && extras.length ? (
              <span
                className="text-[11px] leading-tight text-smoke-500"
                title={`Syncing ${chainName(peer.peerChainId)} re-gossips everything it knows, so this one transaction also updates ${chainName(viewChainId)} about ${extras.map(chainName).join(', ')}.`}
              >
                also syncs {extras.map(chainName).join(', ')}
              </span>
            ) : null}
            {tx.phase === 'pending' && txUrl ? (
              <a
                href={txUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] text-smoke-500 underline underline-offset-2"
              >
                view transaction
              </a>
            ) : null}
            {flowError || tx.error ? (
              <span className="text-[11px] leading-tight text-red-600">
                {flowError ?? tx.error}
              </span>
            ) : null}
          </div>
        ) : null}
      </td>
      <td className="whitespace-nowrap py-1.5 text-right tabular-nums">
        {formatTokenAmount(peer.supply)}
      </td>
      <td className="whitespace-nowrap py-1.5 text-right tabular-nums">
        {balanceStr}
      </td>
      <td className="whitespace-nowrap py-1.5 text-right text-smoke-700">
        {snapshotAge(peer.snapshot)}
      </td>
    </tr>
  )
}
