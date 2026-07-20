'use client'

import {
  JB_CHAINS,
  JBCoreContracts,
  JBSuckerContracts,
  NATIVE_TOKEN,
  jbContractAddress,
  jbControllerAbi,
  jbDirectoryAbi,
  jbSuckerRegistryAbi,
  jbTerminalStoreAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import {
  buildToRemoteTx,
  getAccountingContexts,
  getV6SuckerPairs,
  jbSuckerV6Abi,
} from '@bananapus/nana-sdk-core/v6'
import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import {
  encodeFunctionData,
  erc20Abi,
  zeroAddress,
  type Abi,
  type Address,
  type PublicClient,
} from 'viem'
import { getPublicClient } from 'wagmi/actions'
import { useConfig } from 'wagmi'
import { ChainIcon } from '@/components/ChainIcon'
import { GossipCard } from '@/components/project/GossipCard'
import { useSafeTx } from '@/hooks/useSafeTx'
import { useWallet } from '@/hooks/useWallet'
import type { BridgeMovement } from '@/lib/suckers-queries'
import { formatTokenAmount, timeAgo, truncateAddress } from '@/lib/format'
import { isKnownController } from '@/lib/manage'
import { chainName } from '@/lib/urn'

// ------------------------------------------------------------ inline ABIs --

/** Sucker views the SDK ABI doesn't carry: identity + token mapping + sync. */
export const SUCKER_EXTRA_ABI = [
  {
    type: 'function',
    name: 'projectId',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
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
  {
    type: 'function',
    name: 'syncAccountingData',
    stateMutability: 'payable',
    inputs: [],
    outputs: [],
  },
] as const

const CCIP_ROUTER_ABI = [
  {
    type: 'function',
    name: 'CCIP_ROUTER',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
] as const

const NATIVE_PROBE_ABI = (name: 'OPMESSENGER' | 'ARBINBOX') =>
  [
    {
      type: 'function',
      name,
      stateMutability: 'view',
      inputs: [],
      outputs: [{ type: 'address' }],
    },
  ] as const

export type Infra = 'CCIP' | 'native' | 'unknown'

/**
 * Classify a sucker's bridge. CCIP suckers expose CCIP_ROUTER; native
 * (OP-stack / Arbitrum) suckers don't implement it at all (that read
 * reverts), so probe their bridge-specific getters. Only when nothing
 * answers is the infra genuinely unknown — and fee-sensitive actions stay
 * blocked for it. (website/ parity: classifySuckerInfra.)
 */
export async function classifyInfra(
  client: PublicClient,
  sucker: Address,
): Promise<Infra> {
  try {
    const router = (await client.readContract({
      address: sucker,
      abi: CCIP_ROUTER_ABI,
      functionName: 'CCIP_ROUTER',
    })) as Address
    return router && router.toLowerCase() !== zeroAddress ? 'CCIP' : 'native'
  } catch {
    for (const name of ['OPMESSENGER', 'ARBINBOX'] as const) {
      try {
        await client.readContract({
          address: sucker,
          abi: NATIVE_PROBE_ABI(name),
          functionName: name,
        })
        return 'native'
      } catch {
        /* try the next probe */
      }
    }
    return 'unknown'
  }
}

const CCIP_LADDER = [
  1_000_000_000_000_000n,
  5_000_000_000_000_000n,
  20_000_000_000_000_000n,
  50_000_000_000_000_000n,
  200_000_000_000_000_000n,
  500_000_000_000_000_000n,
]
const SYNC_NATIVE_LADDER = [
  0n,
  1_000_000_000_000_000n,
  10_000_000_000_000_000n,
  50_000_000_000_000_000n,
]
const FUNDED_BALANCE = 10n ** 21n

/**
 * The exact msg.value a `toRemote` needs. Native bridges take only the
 * registry fee; CCIP needs a messaging budget on top, discovered by
 * simulating increasing values (the first that doesn't revert wins). Returns
 * null when the infra can't be verified or the queue won't send — the caller
 * must NOT fall back to 0 (0 native on a CCIP sucker triggers LINK-fee mode).
 * (website/ parity: findToRemoteValue.)
 */
export async function findToRemoteValue(
  client: PublicClient,
  chainId: JBChainId,
  sucker: Address,
  token: Address,
  infra: Infra,
  account: Address,
): Promise<bigint | null> {
  if (infra === 'unknown') return null
  const registry = jbContractAddress['6'][JBSuckerContracts.JBSuckerRegistry][
    chainId
  ] as Address | undefined
  if (!registry) return null
  let fee: bigint
  try {
    fee = (await client.readContract({
      address: registry,
      abi: jbSuckerRegistryAbi,
      functionName: 'toRemoteFee',
    })) as bigint
  } catch {
    return null
  }
  if (infra === 'native') return fee
  const data = encodeFunctionData({
    abi: jbSuckerV6Abi,
    functionName: 'toRemote',
    args: [token],
  })
  for (const extra of CCIP_LADDER) {
    const value = fee + extra
    try {
      await client.call({
        account,
        to: sucker,
        data,
        value,
        stateOverride: [{ address: account, balance: FUNDED_BALANCE }],
      })
      return value
    } catch {
      /* insufficient budget — try a larger one */
    }
  }
  return null
}

/**
 * The msg.value a `syncAccountingData` needs, discovered the same way.
 * (website/ parity: findSyncValue.) Never returns 0 for a CCIP sucker.
 */
async function findSyncValue(
  client: PublicClient,
  sucker: Address,
  infra: Infra,
  account: Address,
): Promise<bigint | null> {
  if (infra === 'unknown') return null
  const data = encodeFunctionData({
    abi: SUCKER_EXTRA_ABI,
    functionName: 'syncAccountingData',
    args: [],
  })
  const ladder = infra === 'CCIP' ? CCIP_LADDER : SYNC_NATIVE_LADDER
  for (const value of ladder) {
    try {
      await client.call({
        account,
        to: sucker,
        data,
        value,
        stateOverride: [{ address: account, balance: FUNDED_BALANCE }],
      })
      return value
    } catch {
      /* try a larger budget */
    }
  }
  return null
}

export function unpackAddress(bytes32: string): Address {
  return `0x${bytes32.slice(-40)}` as Address
}

// -------------------------------------------------------------- root card --

/**
 * The Settlement subtab (website/ parity: renderStagesSection settlement +
 * renderBridgeTransactions): how the project's supply and funds are spread
 * across chains, the bridges that link its deployments, the "move between
 * chains" flow, the queue of in-flight movements, and per-peer accounting
 * sync. Every fund-moving step fails closed on any unverified mapping,
 * unknown bridge infra, or missing proof, and never bypasses useSafeTx.
 */
export function SettlementSection({
  chainId,
  projectId,
  chains,
  isRevnet,
}: {
  chainId: JBChainId
  projectId: number
  chains: [number, number][]
  isRevnet: boolean
}) {
  return (
    <div className="space-y-5" data-flavor={isRevnet ? 'revnet' : 'custom'}>
      <CompositionCard chains={chains} />
      <GossipCard chainId={chainId} projectId={projectId} chains={chains} />
      <BridgesCard chains={chains} />
      <QueuedMovementsCard chainId={chainId} projectId={projectId} />
    </div>
  )
}

// ----------------------------------------------------------- composition --

type TokenBalance = { token: Address; symbol: string; decimals: number; balance: bigint }
type ChainComposition = {
  chainId: number
  projectId: number
  supply: bigint | null
  balances: TokenBalance[]
  supported: boolean
}

function CompositionCard({ chains }: { chains: [number, number][] }) {
  const config = useConfig()

  const { data, isLoading, isError } = useQuery({
    queryKey: ['settlement-composition', chains],
    staleTime: 30_000,
    retry: 1,
    queryFn: async (): Promise<ChainComposition[]> => {
      return Promise.all(
        chains.map(async ([cid, pid]): Promise<ChainComposition> => {
          const client = getPublicClient(config, {
            chainId: cid as JBChainId,
          }) as PublicClient | undefined
          if (!client) {
            return { chainId: cid, projectId: pid, supply: null, balances: [], supported: false }
          }
          const directory = jbContractAddress['6'][JBCoreContracts.JBDirectory][
            cid as JBChainId
          ] as Address | undefined
          const terminal = jbContractAddress['6'][JBCoreContracts.JBMultiTerminal][
            cid as JBChainId
          ] as Address | undefined
          const store = jbContractAddress['6'][JBCoreContracts.JBTerminalStore][
            cid as JBChainId
          ] as Address | undefined
          if (!directory || !terminal || !store) {
            return { chainId: cid, projectId: pid, supply: null, balances: [], supported: false }
          }

          // Supply comes from the project's own controller — read, never
          // assumed. A custom controller may not speak this getter, so its
          // supply reads as unknown rather than a wrong number.
          const controller = (await client
            .readContract({
              abi: jbDirectoryAbi,
              address: directory,
              functionName: 'controllerOf',
              args: [BigInt(pid)],
            })
            .catch(() => undefined)) as Address | undefined
          const supply =
            controller && isKnownController(cid as JBChainId, controller)
              ? ((await client
                  .readContract({
                    abi: jbControllerAbi,
                    address: controller,
                    functionName: 'totalTokenSupplyWithReservedTokensOf',
                    args: [BigInt(pid)],
                  })
                  .catch(() => null)) as bigint | null)
              : null

          const contexts = await getAccountingContexts(client, {
            chainId: cid as JBChainId,
            projectId: BigInt(pid),
          }).catch(() => [])

          const balances = await Promise.all(
            contexts.map(async (ctx): Promise<TokenBalance> => {
              const balance = (await client
                .readContract({
                  abi: jbTerminalStoreAbi,
                  address: store,
                  functionName: 'balanceOf',
                  args: [terminal, BigInt(pid), ctx.token],
                })
                .catch(() => 0n)) as bigint
              const isNative =
                ctx.token.toLowerCase() === NATIVE_TOKEN.toLowerCase()
              const symbol = isNative
                ? (JB_CHAINS[cid as JBChainId]?.nativeTokenSymbol ?? 'ETH')
                : await client
                    .readContract({
                      abi: erc20Abi,
                      address: ctx.token,
                      functionName: 'symbol',
                    })
                    .catch(() => truncateAddress(ctx.token))
              return { token: ctx.token, symbol, decimals: ctx.decimals, balance }
            }),
          )

          return { chainId: cid, projectId: pid, supply, balances, supported: true }
        }),
      )
    },
  })

  const totalSupply = useMemo(
    () => (data ?? []).reduce((sum, c) => sum + (c.supply ?? 0n), 0n),
    [data],
  )
  const supplyComplete = !!data && data.every(c => c.supply !== null)

  return (
    <div className="card p-5">
      <span className="field-label">Composition across chains</span>
      <p className="mt-2 text-sm leading-relaxed text-smoke-700">
        Where this project&apos;s token supply and funds live. Each chain is a
        separate deployment linked by bridges.
      </p>
      {isLoading ? (
        <p className="mt-3 text-sm text-smoke-500">Loading…</p>
      ) : isError || !data ? (
        <p className="mt-3 text-sm text-smoke-700">
          Couldn&apos;t read the cross-chain composition right now.
        </p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-smoke-500">
                <th className="pb-1.5 font-normal">Chain</th>
                <th className="pb-1.5 text-right font-normal">Supply</th>
                <th className="pb-1.5 text-right font-normal">Share</th>
                <th className="pb-1.5 text-right font-normal">Funds</th>
              </tr>
            </thead>
            <tbody className="text-ink">
              {data.map(c => (
                <tr key={`${c.chainId}:${c.projectId}`} className="border-t border-smoke-100">
                  <td className="py-1.5 pr-3">
                    <span className="flex items-center gap-2">
                      <ChainIcon chainId={c.chainId} size={16} />
                      {chainName(c.chainId)}
                    </span>
                  </td>
                  <td className="py-1.5 text-right">
                    {c.supply !== null ? formatTokenAmount(c.supply) : '—'}
                  </td>
                  <td className="py-1.5 text-right text-smoke-700">
                    {c.supply !== null && supplyComplete && totalSupply > 0n
                      ? `${(Number((c.supply * 10_000n) / totalSupply) / 100).toFixed(1)}%`
                      : '—'}
                  </td>
                  <td className="py-1.5 text-right">
                    {!c.supported ? (
                      <span className="text-smoke-500">Unsupported chain</span>
                    ) : c.balances.length === 0 ? (
                      <span className="text-smoke-500">None</span>
                    ) : (
                      c.balances.map(b => (
                        <div key={b.token}>
                          {formatTokenAmount(b.balance, b.decimals)} {b.symbol}
                        </div>
                      ))
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!supplyComplete ? (
            <p className="mt-2 text-xs text-smoke-700">
              Some chains use a custom controller, so shares can&apos;t be
              computed across all of them.
            </p>
          ) : null}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- bridges --

type BridgeEdge = { a: number; b: number; infra: Infra }

function BridgesCard({ chains }: { chains: [number, number][] }) {
  const config = useConfig()

  const { data, isLoading, isError } = useQuery({
    queryKey: ['settlement-bridges', chains],
    staleTime: 60_000,
    retry: 1,
    queryFn: async (): Promise<BridgeEdge[]> => {
      const raw: { a: number; b: number; local: Address }[] = []
      await Promise.all(
        chains.map(async ([cid, pid]) => {
          const client = getPublicClient(config, {
            chainId: cid as JBChainId,
          }) as PublicClient | undefined
          if (!client) return
          const pairs = await getV6SuckerPairs(client, {
            chainId: cid as JBChainId,
            projectId: BigInt(pid),
          }).catch(() => [])
          for (const p of pairs) {
            raw.push({ a: cid, b: Number(p.remoteChainId), local: p.local })
          }
        }),
      )
      // Classify each local sucker, then dedup by (sorted pair + infra): a
      // chain-pair can carry BOTH a native and a CCIP sucker, so the pair is
      // not a unique edge. (website/ parity: fetchProjectSuckerInfra.)
      const classified = await Promise.all(
        raw.map(async s => {
          const client = getPublicClient(config, {
            chainId: s.a as JBChainId,
          }) as PublicClient | undefined
          const infra = client
            ? await classifyInfra(client, s.local)
            : ('unknown' as Infra)
          return { ...s, infra }
        }),
      )
      const seen = new Set<string>()
      const edges: BridgeEdge[] = []
      for (const s of classified) {
        const lo = Math.min(s.a, s.b)
        const hi = Math.max(s.a, s.b)
        const key = `${lo}-${hi}:${s.infra}`
        if (seen.has(key)) continue
        seen.add(key)
        edges.push({ a: lo, b: hi, infra: s.infra })
      }
      return edges.sort((x, y) => x.a - y.a || x.b - y.b)
    },
  })

  const infraLabel = (infra: Infra) =>
    infra === 'CCIP' ? 'CCIP' : infra === 'native' ? 'Native bridge' : 'Unverified'

  return (
    <div className="card p-5">
      <span className="field-label">Bridges</span>
      {isLoading ? (
        <p className="mt-3 text-sm text-smoke-500">Loading…</p>
      ) : isError ? (
        <p className="mt-3 text-sm text-smoke-700">
          Couldn&apos;t read the bridge routes right now.
        </p>
      ) : !data || data.length === 0 ? (
        <p className="mt-3 text-sm leading-relaxed text-smoke-700">
          These deployments aren&apos;t linked.
        </p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-smoke-500">
                <th className="pb-1.5 font-normal">Route</th>
                <th className="pb-1.5 text-right font-normal">Bridge</th>
              </tr>
            </thead>
            <tbody className="text-ink">
              {data.map(edge => (
                <tr
                  key={`${edge.a}-${edge.b}:${edge.infra}`}
                  className="border-t border-smoke-100"
                >
                  <td className="py-1.5 pr-3">
                    <span className="flex items-center gap-2">
                      <ChainIcon chainId={edge.a} size={16} />
                      {chainName(edge.a)}
                      <span className="text-smoke-500">↔</span>
                      <ChainIcon chainId={edge.b} size={16} />
                      {chainName(edge.b)}
                    </span>
                  </td>
                  <td className="py-1.5 text-right">
                    <span
                      className={
                        edge.infra === 'unknown'
                          ? 'text-red-700'
                          : 'text-smoke-700'
                      }
                    >
                      {infraLabel(edge.infra)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------- queued movements --

function QueuedMovementsCard({
  chainId,
  projectId,
}: {
  chainId: JBChainId
  projectId: number
}) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['settlement-movements', chainId, projectId],
    staleTime: 20_000,
    retry: 1,
    refetchInterval: 45_000,
    queryFn: async (): Promise<BridgeMovement[]> => {
      const res = await fetch(
        `/api/movements?chainId=${chainId}&projectId=${projectId}`,
      )
      if (!res.ok) throw new Error('movements unavailable')
      return ((await res.json()) as { items: BridgeMovement[] }).items
    },
  })

  // One Execute per source→dest group: a toRemote ships the whole outbox.
  const groups = useMemo(() => {
    const byKey = new Map<
      string,
      { sourceChainId: number; destChainId: number; sucker: Address; token: Address; rows: BridgeMovement[] }
    >()
    for (const m of data ?? []) {
      const key = `${m.sourceChainId}->${m.destChainId}:${m.token}`
      if (!byKey.has(key)) {
        byKey.set(key, {
          sourceChainId: m.sourceChainId,
          destChainId: m.destChainId,
          sucker: m.sourceSucker as Address,
          token: m.token as Address,
          rows: [],
        })
      }
      byKey.get(key)!.rows.push(m)
    }
    return [...byKey.values()]
  }, [data])

  return (
    <div className="card p-5">
      <span className="field-label">Queued movements</span>
      {isLoading ? (
        <p className="mt-3 text-sm text-smoke-500">Loading…</p>
      ) : isError ? (
        <p className="mt-3 text-sm text-smoke-700">
          Couldn&apos;t load queued movements right now.
        </p>
      ) : groups.length === 0 ? (
        <p className="mt-3 text-sm leading-relaxed text-smoke-700">
          No queued movements — anything in flight shows here until it clears.
        </p>
      ) : (
        <div className="mt-3 space-y-4">
          {groups.map(g => (
            <MovementGroup
              key={`${g.sourceChainId}->${g.destChainId}:${g.token}`}
              group={g}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function MovementGroup({
  group,
}: {
  group: {
    sourceChainId: number
    destChainId: number
    sucker: Address
    token: Address
    rows: BridgeMovement[]
  }
}) {
  const config = useConfig()
  const { isConnected, address, openSignIn } = useWallet()
  const tx = useSafeTx(group.sourceChainId)
  const [checking, setChecking] = useState(false)
  const [flowError, setFlowError] = useState<string | null>(null)

  const busy =
    checking ||
    tx.phase === 'simulating' ||
    tx.phase === 'signing' ||
    tx.phase === 'pending'

  const pending = group.rows.filter(r => r.status === 'pending')
  const chainMeta = JB_CHAINS[group.sourceChainId as JBChainId]
  const txUrl = tx.hash
    ? `https://${chainMeta?.etherscanHostname}/tx/${tx.hash}`
    : null

  const execute = async () => {
    if (busy) return
    if (!isConnected || !address) {
      openSignIn()
      return
    }
    setFlowError(null)
    setChecking(true)
    try {
      const client = getPublicClient(config, {
        chainId: group.sourceChainId as JBChainId,
      }) as PublicClient | undefined
      if (!client) throw new Error(`Unsupported chain ${group.sourceChainId}.`)
      const infra = await classifyInfra(client, group.sucker)
      const value = await findToRemoteValue(
        client,
        group.sourceChainId as JBChainId,
        group.sucker,
        group.token,
        infra,
        address,
      )
      if (value === null) {
        throw new Error('The bridge fee could not be determined yet — try again shortly.')
      }
      const request = buildToRemoteTx({
        chainId: group.sourceChainId as JBChainId,
        sucker: group.sucker,
        token: group.token,
        value,
      })
      await tx.send({ ...request, abi: request.abi as Abi })
    } catch (e) {
      setFlowError(e instanceof Error ? e.message : 'Could not send.')
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="rounded-xl border border-smoke-200 p-4">
      <div className="mb-2 flex items-center gap-2 text-sm text-smoke-700">
        <ChainIcon chainId={group.sourceChainId} size={16} />
        {chainName(group.sourceChainId)}
        <span className="text-smoke-500">→</span>
        <ChainIcon chainId={group.destChainId} size={16} />
        {chainName(group.destChainId)}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-smoke-500">
              <th className="pb-1.5 font-normal">Initiated</th>
              <th className="pb-1.5 font-normal">Beneficiary</th>
              <th className="pb-1.5 text-right font-normal">Tokens</th>
              <th className="pb-1.5 text-right font-normal">Status</th>
              <th className="pb-1.5 text-right font-normal">Action</th>
            </tr>
          </thead>
          <tbody className="text-ink">
            {group.rows.map(m => (
              <tr key={m.id} className="border-t border-smoke-100">
                <td className="py-1.5 pr-3 text-smoke-700">{timeAgo(m.timestamp)}</td>
                <td className="py-1.5 pr-3">{truncateAddress(m.beneficiary)}</td>
                <td className="py-1.5 text-right">
                  {formatTokenAmount(BigInt(m.projectTokenCount))}
                </td>
                <td className="py-1.5 text-right">
                  <span
                    className={
                      m.status === 'claimable'
                        ? 'text-melon-600'
                        : 'text-smoke-700'
                    }
                  >
                    {m.status === 'pending'
                      ? 'Queued'
                      : m.status === 'sent'
                        ? 'Bridging'
                        : 'Claimable'}
                  </span>
                </td>
                <td className="py-1.5 text-right">
                  {m.status === 'claimable' ? (
                    <ClaimButton destChainId={m.destChainId} />
                  ) : (
                    <span className="text-xs text-smoke-500">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {pending.length > 0 ? (
        <div className="mt-3">
          <button
            onClick={execute}
            disabled={busy}
            className="btn-secondary min-h-[40px] px-4 text-sm"
          >
            {checking
              ? 'Reading bridge fee…'
              : tx.phase === 'simulating'
                ? 'Double-checking…'
                : tx.phase === 'signing'
                  ? 'Confirm in your wallet…'
                  : tx.phase === 'pending'
                    ? 'Sending…'
                    : `Send ${pending.length} queued move${pending.length > 1 ? 's' : ''} to ${chainName(group.destChainId)}`}
          </button>
          <p className="mt-1.5 text-xs text-smoke-700">
            Anyone can send this — it ships the queued outbox in one bridge
            message. The value is the bridge&apos;s messaging fee, not the
            bridged tokens.
          </p>
        </div>
      ) : null}

      {tx.phase === 'success' ? (
        <p className="mt-2 text-xs text-smoke-900">
          Sent to {chainName(group.destChainId)}.
          {txUrl ? (
            <>
              {' '}
              <a
                href={txUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold text-bluebs-600 underline underline-offset-2"
              >
                View transaction
              </a>
            </>
          ) : null}
        </p>
      ) : null}

      {flowError || tx.error ? (
        <p className="mt-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700">
          {flowError ?? tx.error}
        </p>
      ) : null}
    </div>
  )
}

/**
 * Claiming a bridged movement (JBSucker.claim) needs the full merkle leaf AND
 * a 32-entry inclusion proof. Neither the SDK nor bendystraw provides a proof
 * builder, and reconstructing one requires a full outbox-tree scan that is out
 * of scope here — so claiming FAILS CLOSED: the button explains where to claim
 * rather than sending a call that would revert.
 *
 * GAP (documented): wire a proof source (an on-chain outbox-tree reconstruction
 * or an SDK/indexer proof endpoint) to enable one-click claims. Until then,
 * claims complete on the destination chain's own tooling.
 */
function ClaimButton({ destChainId }: { destChainId: number }) {
  const [open, setOpen] = useState(false)
  return (
    <span className="inline-flex flex-col items-end">
      <button
        onClick={() => setOpen(o => !o)}
        className="btn-secondary min-h-[32px] px-3 text-xs"
      >
        Claim on {chainName(destChainId)}
      </button>
      {open ? (
        <span className="mt-1 max-w-[220px] text-right text-[11px] leading-relaxed text-smoke-700">
          One-click claiming isn&apos;t available here yet — a claim needs a
          merkle proof this app can&apos;t build. Complete the claim on{' '}
          {chainName(destChainId)} with the sucker&apos;s own tooling.
        </span>
      ) : null}
    </span>
  )
}
