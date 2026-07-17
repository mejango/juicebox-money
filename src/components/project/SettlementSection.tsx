'use client'

import {
  JB_CHAINS,
  JBCoreContracts,
  JBSuckerContracts,
  NATIVE_TOKEN,
  jbContractAddress,
  jbControllerAbi,
  jbDirectoryAbi,
  jbMultiTerminalAbi,
  jbSuckerRegistryAbi,
  jbTerminalStoreAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import {
  buildBridgePrepareTx,
  buildToRemoteTx,
  getAccountingContexts,
  getTokenAddress,
  getV6SuckerPairs,
  jbSuckerV6Abi,
} from '@bananapus/nana-sdk-core/v6'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  parseUnits,
  zeroAddress,
  type Abi,
  type Address,
  type PublicClient,
} from 'viem'
import { getPublicClient } from 'wagmi/actions'
import { useConfig } from 'wagmi'
import { ChainIcon } from '@/components/ChainIcon'
import { useSafeTx } from '@/hooks/useSafeTx'
import { useWallet } from '@/hooks/useWallet'
import type { BridgeMovement } from '@/lib/suckers-queries'
import { formatTokenAmount, timeAgo, truncateAddress } from '@/lib/format'
import { isKnownController } from '@/lib/manage'
import { chainName } from '@/lib/urn'

// ------------------------------------------------------------ inline ABIs --

/** Sucker views the SDK ABI doesn't carry: identity + token mapping + sync. */
const SUCKER_EXTRA_ABI = [
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

type Infra = 'CCIP' | 'native' | 'unknown'

/**
 * Classify a sucker's bridge. CCIP suckers expose CCIP_ROUTER; native
 * (OP-stack / Arbitrum) suckers don't implement it at all (that read
 * reverts), so probe their bridge-specific getters. Only when nothing
 * answers is the infra genuinely unknown — and fee-sensitive actions stay
 * blocked for it. (website/ parity: classifySuckerInfra.)
 */
async function classifyInfra(
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
async function findToRemoteValue(
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

function unpackAddress(bytes32: string): Address {
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
      <BridgesCard chains={chains} />
      <MoveCard chainId={chainId} projectId={projectId} chains={chains} />
      <QueuedMovementsCard chainId={chainId} projectId={projectId} />
      <SyncCard chainId={chainId} projectId={projectId} />
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

// ------------------------------------------------------ move between chains --

/** The frozen, reviewed prepare: what the user confirms is exactly what's
 *  sent, including the min the preview backed. */
type ReviewedMove = {
  sucker: Address
  token: Address
  projectToken: Address
  amount: bigint
  minReclaimed: bigint
  /** The live backing preview the min was floored from (0 = zero backing). */
  previewNet: bigint
  backingDecimals: number
  backingSymbol: string
  infra: Infra
  account: Address
}

function MoveCard({
  chainId,
  projectId,
  chains,
}: {
  chainId: JBChainId
  projectId: number
  chains: [number, number][]
}) {
  const config = useConfig()
  const { isConnected, address, openSignIn } = useWallet()

  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const connected = mounted && isConnected && !!address

  const [from, setFrom] = useState<number>(chainId)
  const [to, setTo] = useState<number | null>(null)
  const [amount, setAmount] = useState('')

  const fromPid = useMemo(
    () => chains.find(([cid]) => cid === from)?.[1] ?? projectId,
    [chains, from, projectId],
  )

  // Source-chain sucker pairs (linked destinations) + the caller's ERC-20
  // position on the source chain (only the deployed ERC-20 can bridge —
  // credits can't).
  const { data: src } = useQuery({
    queryKey: ['settlement-move-src', from, fromPid, address],
    enabled: connected,
    staleTime: 20_000,
    retry: 1,
    queryFn: async () => {
      const client = getPublicClient(config, {
        chainId: from as JBChainId,
      }) as PublicClient | undefined
      if (!client) throw new Error(`Unsupported chain ${from}`)
      const [pairs, token] = await Promise.all([
        getV6SuckerPairs(client, {
          chainId: from as JBChainId,
          projectId: BigInt(fromPid),
        }),
        getTokenAddress(client, {
          chainId: from as JBChainId,
          projectId: BigInt(fromPid),
        }),
      ])
      const erc20Balance =
        token && token !== zeroAddress
          ? ((await client.readContract({
              abi: erc20Abi,
              address: token,
              functionName: 'balanceOf',
              args: [address!],
            })) as bigint)
          : 0n
      return { pairs, token: token && token !== zeroAddress ? token : null, erc20Balance }
    },
  })

  const dests = useMemo(
    () =>
      (src?.pairs ?? []).map(p => ({
        chainId: Number(p.remoteChainId),
        sucker: p.local,
      })),
    [src],
  )

  // Default the destination to the first linked chain once pairs load.
  useEffect(() => {
    if (to === null && dests.length > 0) setTo(dests[0].chainId)
  }, [dests, to])

  const parsedAmount = useMemo(() => {
    try {
      const t = amount.trim()
      if (!t || Number(t) <= 0) return 0n
      return parseUnits(t, 18)
    } catch {
      return 0n
    }
  }, [amount])

  const selectedPair = dests.find(d => d.chainId === to) ?? null

  return (
    <div className="card p-5">
      <span className="field-label">Move between chains</span>
      <p className="mt-2 text-sm leading-relaxed text-smoke-700">
        Bridge your tokens to another chain. Only the deployed ERC-20 can move
        — internal credits can&apos;t bridge.
      </p>

      {!connected ? (
        <div className="mt-3">
          <button
            onClick={openSignIn}
            className="btn-secondary min-h-[40px] px-4 text-sm"
          >
            Sign in
          </button>
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-sm text-smoke-700">
            <span>From</span>
            <select
              value={from}
              onChange={e => {
                setFrom(Number(e.target.value))
                setTo(null)
                setAmount('')
              }}
              className="input-well min-h-[40px] px-3 text-sm"
            >
              {chains.map(([cid]) => (
                <option key={cid} value={cid}>
                  {chainName(cid)}
                </option>
              ))}
            </select>
            <span>to</span>
            <select
              value={to ?? ''}
              onChange={e => setTo(Number(e.target.value))}
              disabled={dests.length === 0}
              className="input-well min-h-[40px] px-3 text-sm"
            >
              {dests.length === 0 ? (
                <option value="">No linked chains</option>
              ) : (
                dests.map(d => (
                  <option key={d.chainId} value={d.chainId}>
                    {chainName(d.chainId)}
                  </option>
                ))
              )}
            </select>
          </div>

          {src && !src.token ? (
            <p className="rounded-lg bg-split-50 px-3.5 py-2.5 text-xs leading-relaxed text-smoke-900">
              You don&apos;t have any ERC-20 {' '}
              tokens on {chainName(from)}. If you hold credits, claim them as
              ERC-20 in the Accounts tab first — credits can&apos;t bridge.
            </p>
          ) : (
            <>
              <label className="block">
                <span className="field-label">Amount</span>
                <div className="input-well mt-1.5 flex items-center px-4">
                  <input
                    type="text"
                    inputMode="decimal"
                    value={amount}
                    onChange={e => setAmount(e.target.value)}
                    placeholder="0"
                    className="min-h-[44px] w-full bg-transparent text-lg font-medium outline-none placeholder:text-smoke-500"
                  />
                  <button
                    onClick={() =>
                      src?.erc20Balance != null &&
                      setAmount(formatUnits(src.erc20Balance, 18))
                    }
                    className="btn-secondary ml-3 px-2.5 py-0.5 text-[11px]"
                  >
                    MAX
                  </button>
                </div>
              </label>
              {src ? (
                <p className="text-xs text-smoke-700">
                  {formatTokenAmount(src.erc20Balance)} ERC-20 available on{' '}
                  {chainName(from)}.
                </p>
              ) : null}
            </>
          )}

          {selectedPair && src?.token && parsedAmount > 0n && address ? (
            <MoveFlow
              key={`${from}:${to}`}
              from={from as JBChainId}
              fromPid={fromPid}
              to={to as number}
              sucker={selectedPair.sucker}
              projectToken={src.token}
              amount={parsedAmount}
              maxBalance={src.erc20Balance}
              account={address}
            />
          ) : null}
        </div>
      )}
    </div>
  )
}

/** The three-step move: approve the sucker, prepare (queue the leaf), then
 *  send to the remote chain. Each step is its own reviewed useSafeTx send. */
function MoveFlow({
  from,
  fromPid,
  to,
  sucker,
  projectToken,
  amount,
  maxBalance,
  account,
}: {
  from: JBChainId
  fromPid: number
  to: number
  sucker: Address
  projectToken: Address
  amount: bigint
  maxBalance: bigint
  account: Address
}) {
  const config = useConfig()
  const tx = useSafeTx(from)
  const { address } = useWallet()

  // step: 0 review, 1 approve (if needed), 2 prepare, 3 send, 4 done
  const [step, setStep] = useState<0 | 1 | 2 | 3 | 4>(0)
  const [checking, setChecking] = useState(false)
  const [flowError, setFlowError] = useState<string | null>(null)
  const [review, setReview] = useState<ReviewedMove | null>(null)
  const [needsApproval, setNeedsApproval] = useState(false)
  const advancedFor = useRef<number>(-1)

  const busy =
    checking ||
    tx.phase === 'simulating' ||
    tx.phase === 'signing' ||
    tx.phase === 'pending'

  const chainMeta = JB_CHAINS[from]
  const txUrl = tx.hash
    ? `https://${chainMeta?.etherscanHostname}/tx/${tx.hash}`
    : null

  // Advance one step each time a send lands, exactly once per step.
  useEffect(() => {
    if (tx.phase !== 'success') return
    if (advancedFor.current === step) return
    advancedFor.current = step
    setStep(s => (s < 4 ? ((s + 1) as typeof s) : s))
    tx.reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tx.phase, step])

  /** Live re-reads + all fail-closed checks, then freeze the reviewed move. */
  const handleReview = async () => {
    if (busy) return
    setFlowError(null)
    setChecking(true)
    try {
      const client = getPublicClient(config, { chainId: from }) as
        | PublicClient
        | undefined
      if (!client) throw new Error(`Unsupported chain ${from}.`)
      const terminal = jbContractAddress['6'][JBCoreContracts.JBMultiTerminal][
        from
      ] as Address | undefined
      if (!terminal) throw new Error('No terminal on the source chain.')

      // The backing / terminal token the sucker reclaims and bridges: the
      // project's primary accounting token on the source chain.
      const contexts = await getAccountingContexts(client, {
        chainId: from,
        projectId: BigInt(fromPid),
      })
      const primary = contexts[0]
      if (!primary) throw new Error('This project holds no funds on the source chain to back the move.')
      const token = primary.token as Address
      const isNative = token.toLowerCase() === NATIVE_TOKEN.toLowerCase()

      const [suckerPid, mapping, infra, freshBalance] = await Promise.all([
        client.readContract({
          address: sucker,
          abi: SUCKER_EXTRA_ABI,
          functionName: 'projectId',
        }) as Promise<bigint>,
        client.readContract({
          address: sucker,
          abi: SUCKER_EXTRA_ABI,
          functionName: 'remoteTokenFor',
          args: [token],
        }) as Promise<{ enabled: boolean; emergencyHatch: boolean; minGas: number; addr: `0x${string}` }>,
        classifyInfra(client, sucker),
        client.readContract({
          abi: erc20Abi,
          address: projectToken,
          functionName: 'balanceOf',
          args: [account],
        }) as Promise<bigint>,
      ])

      // Fail closed on every uncertainty.
      if (suckerPid !== BigInt(fromPid)) {
        throw new Error('This bridge belongs to a different project.')
      }
      if (amount > freshBalance) {
        throw new Error('That is more ERC-20 than you hold on the source chain.')
      }
      if (infra === 'unknown') {
        throw new Error(
          'This bridge type could not be verified. Moving stays blocked until it can be read again.',
        )
      }
      if (!mapping.enabled || !mapping.addr || /^0x0+$/.test(mapping.addr)) {
        throw new Error('The backing token is not mapped on this bridge — nothing was sent.')
      }
      // Canonical ERC-20 over an OP-stack / Arbitrum native bridge strands in
      // escrow — the mapping can exist but the delivery leg never settles.
      if (infra === 'native' && !isNative) {
        throw new Error(
          'This route uses a native bridge, which cannot deliver this backing token — it would get stuck in escrow.',
        )
      }
      // The mapped destination token must match a verified accounting context
      // on the destination chain.
      const destClient = getPublicClient(config, { chainId: to as JBChainId }) as
        | PublicClient
        | undefined
      if (!destClient) throw new Error(`Unsupported destination chain ${to}.`)
      const destPid = BigInt(fromPid) // sucker groups share the project token identity; verify below
      const destContexts = await getAccountingContexts(destClient, {
        chainId: to as JBChainId,
        projectId: destPid,
      }).catch(() => [])
      const mappedRemote = unpackAddress(mapping.addr).toLowerCase()
      const destMatch = destContexts.some(
        c => c.token.toLowerCase() === mappedRemote,
      )
      if (!destMatch) {
        throw new Error(
          'The bridge maps this backing token to a token that is not a verified accounting context on the destination chain.',
        )
      }

      // Live backing preview: what the sucker's cash-out of the moved tokens
      // reclaims (holder = the sucker, a protocol-registered feeless address,
      // so the reclaim isn't fee-reduced). Floor the min at 99% of it; a zero
      // preview moves the same token count with no backing and says so.
      // previewCashOutFrom returns [ruleset, reclaimAmount, cashOutTaxRate,
      // hookSpecifications] — reclaimAmount is index 1.
      const preview = (await client.readContract({
        address: terminal,
        abi: jbMultiTerminalAbi,
        functionName: 'previewCashOutFrom',
        args: [sucker, BigInt(fromPid), amount, token, sucker, '0x'],
      })) as readonly [unknown, bigint, bigint, unknown]
      const gross = preview[1] ?? 0n
      const minReclaimed = gross > 0n ? (gross * 99n) / 100n : 0n

      const backingSymbol = isNative
        ? (JB_CHAINS[from]?.nativeTokenSymbol ?? 'ETH')
        : await client
            .readContract({ abi: erc20Abi, address: token, functionName: 'symbol' })
            .catch(() => truncateAddress(token))

      // Does the sucker already have enough allowance for the project token?
      const allowance = (await client.readContract({
        abi: erc20Abi,
        address: projectToken,
        functionName: 'allowance',
        args: [account, sucker],
      })) as bigint
      setNeedsApproval(allowance < amount)

      setReview({
        sucker,
        token,
        projectToken,
        amount,
        minReclaimed,
        previewNet: gross,
        backingDecimals: primary.decimals,
        backingSymbol,
        infra,
        account,
      })
      setStep(allowance < amount ? 1 : 2)
      advancedFor.current = -1
    } catch (e) {
      setFlowError(e instanceof Error ? e.message : 'Could not prepare this move.')
    } finally {
      setChecking(false)
    }
  }

  const accountChanged = () =>
    address?.toLowerCase() !== review?.account.toLowerCase()

  const sendApprove = () => {
    if (!review || busy) return
    if (accountChanged()) {
      setReview(null)
      setStep(0)
      setFlowError('Your connected account changed — review the move again.')
      return
    }
    tx.send({
      chainId: from,
      address: review.projectToken,
      abi: erc20Abi as Abi,
      functionName: 'approve',
      args: [review.sucker, review.amount],
    })
  }

  const sendPrepare = () => {
    if (!review || busy) return
    if (accountChanged()) {
      setReview(null)
      setStep(0)
      setFlowError('Your connected account changed — review the move again.')
      return
    }
    const request = buildBridgePrepareTx({
      chainId: from,
      sucker: review.sucker,
      projectTokenCount: review.amount,
      beneficiary: review.account,
      minTokensReclaimed: review.minReclaimed,
      token: review.token,
    })
    tx.send({ ...request, abi: request.abi as Abi })
  }

  const sendToRemote = async () => {
    if (!review || busy) return
    if (accountChanged()) {
      setReview(null)
      setStep(0)
      setFlowError('Your connected account changed — review the move again.')
      return
    }
    setFlowError(null)
    setChecking(true)
    try {
      const client = getPublicClient(config, { chainId: from }) as
        | PublicClient
        | undefined
      if (!client) throw new Error(`Unsupported chain ${from}.`)
      const value = await findToRemoteValue(
        client,
        from,
        review.sucker,
        review.token,
        review.infra,
        review.account,
      )
      if (value === null) {
        throw new Error(
          'Prepared, but the bridge fee could not be determined yet — try sending again shortly.',
        )
      }
      const request = buildToRemoteTx({
        chainId: from,
        sucker: review.sucker,
        token: review.token,
        value,
      })
      await tx.send({ ...request, abi: request.abi as Abi })
    } catch (e) {
      setFlowError(e instanceof Error ? e.message : 'Could not send to the remote chain.')
    } finally {
      setChecking(false)
    }
  }

  if (amount > maxBalance) {
    return (
      <p className="text-xs text-red-700">
        That is more than the {formatTokenAmount(maxBalance)} ERC-20 you hold on{' '}
        {chainName(from)}.
      </p>
    )
  }

  return (
    <div className="rounded-xl border border-smoke-200 p-4">
      {review ? (
        <div className="mb-3 rounded-lg bg-split-50 px-3.5 py-2.5 text-xs leading-relaxed text-smoke-900">
          <p>
            Moving {formatTokenAmount(review.amount)} tokens to {chainName(to)}.
          </p>
          <p className="mt-1">
            {review.previewNet > 0n ? (
              <>
                About{' '}
                {formatTokenAmount(review.previewNet, review.backingDecimals)}{' '}
                {review.backingSymbol} of backing moves with them; the prepare
                reverts below the 99% floor.
              </>
            ) : (
              <>
                This chain contributes no backing right now — the same token
                count moves, but no backing goes with it.
              </>
            )}
          </p>
          <p className="mt-1 text-smoke-700">
            Bridge: {review.infra === 'CCIP' ? 'CCIP' : 'native'}.
          </p>
        </div>
      ) : null}

      {/* Step buttons */}
      {step === 0 ? (
        <button
          onClick={handleReview}
          disabled={busy}
          className="btn-primary min-h-[44px] w-full text-sm"
        >
          {checking ? 'Checking the route…' : 'Review move'}
        </button>
      ) : null}

      {step === 1 ? (
        <StepButton
          label="Step 1 of 3 — Approve the bridge"
          phase={tx.phase}
          busy={busy}
          onClick={sendApprove}
          idleText="Approve"
          note="Lets the bridge move your ERC-20 for this transfer."
        />
      ) : null}

      {step === 2 ? (
        <StepButton
          label={`Step ${needsApproval ? '2 of 3' : '1 of 2'} — Prepare the move`}
          phase={tx.phase}
          busy={busy}
          onClick={sendPrepare}
          idleText="Prepare"
          note="Queues your move into the bridge's outbox."
        />
      ) : null}

      {step === 3 ? (
        <StepButton
          label={`Step ${needsApproval ? '3 of 3' : '2 of 2'} — Send to ${chainName(to)}`}
          phase={checking ? 'simulating' : tx.phase}
          busy={busy}
          onClick={sendToRemote}
          idleText="Send"
          note={`Ships the queued outbox to ${chainName(to)}. Anyone can send this; the value is the bridge's messaging fee, not the bridged tokens.`}
        />
      ) : null}

      {step === 4 ? (
        <div className="rounded-lg bg-split-50 px-3.5 py-2.5 text-xs leading-relaxed text-smoke-900">
          Bridging to {chainName(to)}. Once it lands, claim it from Queued
          movements below.
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
        </div>
      ) : null}

      {tx.phase === 'pending' && txUrl ? (
        <p className="mt-2 text-xs text-smoke-700">
          Waiting for confirmation —{' '}
          <a
            href={txUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2"
          >
            view transaction
          </a>
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

function StepButton({
  label,
  phase,
  busy,
  onClick,
  idleText,
  note,
}: {
  label: string
  phase: string
  busy: boolean
  onClick: () => void
  idleText: string
  note: string
}) {
  return (
    <div>
      <p className="mb-2 text-sm font-medium text-ink">{label}</p>
      <button
        onClick={onClick}
        disabled={busy}
        className="btn-primary min-h-[44px] w-full text-sm"
      >
        {phase === 'simulating'
          ? 'Double-checking the transaction…'
          : phase === 'signing'
            ? 'Confirm in your wallet…'
            : phase === 'pending'
              ? 'Submitting…'
              : idleText}
      </button>
      <p className="mt-1.5 text-xs text-smoke-700">{note}</p>
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

// ------------------------------------------------------------------- sync --

function SyncCard({
  chainId,
  projectId,
}: {
  chainId: JBChainId
  projectId: number
}) {
  const config = useConfig()

  const { data, isLoading, isError } = useQuery({
    queryKey: ['settlement-sync-peers', chainId, projectId],
    staleTime: 60_000,
    retry: 1,
    queryFn: async () => {
      const client = getPublicClient(config, { chainId }) as
        | PublicClient
        | undefined
      if (!client) throw new Error(`Unsupported chain ${chainId}`)
      const pairs = await getV6SuckerPairs(client, {
        chainId,
        projectId: BigInt(projectId),
      })
      // "Sync from [peer]" pushes the PEER's accounting snapshot to us, so it
      // runs syncAccountingData on the PEER's sucker, on the peer's chain.
      return pairs.map(p => ({
        peerChainId: Number(p.remoteChainId),
        peerSucker: p.remote,
      }))
    },
  })

  return (
    <div className="card p-5">
      <span className="field-label">Sync accounting</span>
      <p className="mt-2 text-sm leading-relaxed text-smoke-700">
        Pull another chain&apos;s latest supply and balance snapshot over the
        bridge. Anyone can trigger a sync.
      </p>
      {isLoading ? (
        <p className="mt-3 text-sm text-smoke-500">Loading…</p>
      ) : isError ? (
        <p className="mt-3 text-sm text-smoke-700">
          Couldn&apos;t read the linked chains right now.
        </p>
      ) : !data || data.length === 0 ? (
        <p className="mt-3 text-sm leading-relaxed text-smoke-700">
          No linked chains to sync from.
        </p>
      ) : (
        <div className="mt-3 space-y-3">
          {data.map(peer => (
            <SyncRow
              key={peer.peerChainId}
              peerChainId={peer.peerChainId}
              peerSucker={peer.peerSucker}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function SyncRow({
  peerChainId,
  peerSucker,
}: {
  peerChainId: number
  peerSucker: Address
}) {
  const config = useConfig()
  const { isConnected, address, openSignIn } = useWallet()
  const tx = useSafeTx(peerChainId)
  const [checking, setChecking] = useState(false)
  const [flowError, setFlowError] = useState<string | null>(null)

  const busy =
    checking ||
    tx.phase === 'simulating' ||
    tx.phase === 'signing' ||
    tx.phase === 'pending'

  const chainMeta = JB_CHAINS[peerChainId as JBChainId]
  const txUrl = tx.hash
    ? `https://${chainMeta?.etherscanHostname}/tx/${tx.hash}`
    : null

  const sync = async () => {
    if (busy) return
    if (!isConnected || !address) {
      openSignIn()
      return
    }
    setFlowError(null)
    setChecking(true)
    try {
      const client = getPublicClient(config, {
        chainId: peerChainId as JBChainId,
      }) as PublicClient | undefined
      if (!client) throw new Error(`Unsupported chain ${peerChainId}.`)
      const infra = await classifyInfra(client, peerSucker)
      const value = await findSyncValue(client, peerSucker, infra, address)
      if (value === null) {
        throw new Error('The bridge fee could not be determined yet — try again shortly.')
      }
      await tx.send({
        chainId: peerChainId,
        address: peerSucker,
        abi: SUCKER_EXTRA_ABI as unknown as Abi,
        functionName: 'syncAccountingData',
        args: [],
        value,
      })
    } catch (e) {
      setFlowError(e instanceof Error ? e.message : 'Could not sync.')
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-smoke-100 pt-3 first:border-0 first:pt-0">
      <span className="flex items-center gap-2 text-sm text-smoke-700">
        <ChainIcon chainId={peerChainId} size={16} />
        {chainName(peerChainId)}
      </span>
      <div className="text-right">
        <button
          onClick={sync}
          disabled={busy}
          className="btn-secondary min-h-[36px] px-4 text-xs"
        >
          {checking
            ? 'Reading bridge fee…'
            : tx.phase === 'simulating'
              ? 'Double-checking…'
              : tx.phase === 'signing'
                ? 'Confirm in your wallet…'
                : tx.phase === 'pending'
                  ? 'Syncing…'
                  : tx.phase === 'success'
                    ? 'Synced'
                    : `Sync from ${chainName(peerChainId)}`}
        </button>
        {tx.phase === 'pending' && txUrl ? (
          <p className="mt-1 text-xs text-smoke-700">
            <a
              href={txUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2"
            >
              view transaction
            </a>
          </p>
        ) : null}
        {flowError || tx.error ? (
          <p className="mt-1 text-xs text-red-700">{flowError ?? tx.error}</p>
        ) : null}
      </div>
    </div>
  )
}
