'use client'

import {
  JB_CHAINS,
  JBCoreContracts,
  NATIVE_TOKEN,
  SPLITS_TOTAL_PERCENT,
  jbContractAddress,
  jbControllerAbi,
  jbDirectoryAbi,
  jbSplitsAbi,
  jbTerminalStoreAbi,
  jbTokensAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import {
  RESERVED_TOKEN_SPLIT_GROUP_ID,
  buildClaimTokensTx,
  getAccountingContexts,
  getAllRulesets,
  getCreditBalance,
  getCurrentRuleset,
  getTokenAddress,
  type JBRulesetWithMetadata,
} from '@bananapus/nana-sdk-core/v6'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import {
  erc20Abi,
  formatUnits,
  zeroAddress,
  type Address,
  type PublicClient,
} from 'viem'
import { usePublicClient, useReadContract, useReadContracts } from 'wagmi'
import { ChainIcon } from '@/components/ChainIcon'
import { AutoIssuanceSection } from '@/components/project/AutoIssuanceSection'
import { LoansSection } from '@/components/project/LoansSection'
import { SettlementSection } from '@/components/project/SettlementSection'
import { TokenPanel } from '@/components/project/TokenPanel'
import { SubTabs } from '@/components/project/Tabs'
import { useSafeTx } from '@/hooks/useSafeTx'
import { useWallet } from '@/hooks/useWallet'
import type { BsParticipant } from '@/lib/bendystraw'
import { formatTokenAmount, truncateAddress } from '@/lib/format'
import { isKnownController } from '@/lib/manage'
import { chainName, toUrn } from '@/lib/urn'

/** The reserved-split sentinel that burns the tokens instead of sending them. */
const BURN_ADDRESS = '0x000000000000000000000000000000000000dead'

/**
 * The Owners (revnet) / Tokens (custom) tab (website/ parity:
 * renderOwnersSection). Token panel on top, then subtabs: Accounts (your
 * per-chain position + the holder distribution) and Splits/Reserved (where
 * reserved tokens go, plus the anyone-can-send distribute flow).
 */
export function OwnersTab({
  chainId,
  projectId,
  isRevnet,
  suckerGroupId,
  chains,
}: {
  chainId: JBChainId
  projectId: number
  isRevnet: boolean
  suckerGroupId: string | null
  /** [chainId, projectId] pairs across the sucker group (incl. this chain). */
  chains: [number, number][]
}) {
  const etherscanHost = JB_CHAINS[chainId]?.etherscanHostname

  return (
    <div className="space-y-5">
      <TokenPanel
        chainId={chainId}
        projectId={projectId}
        chainIds={chains.map(([cid]) => cid)}
        etherscanHost={etherscanHost}
        compact
      />
      <SubTabs
        tabs={[
          {
            label: 'Accounts',
            content: (
              <div className="space-y-5">
                <YouCard chains={chains} />
                <AllHoldersCard
                  chainId={chainId}
                  projectId={projectId}
                  suckerGroupId={suckerGroupId}
                  etherscanHost={etherscanHost}
                />
              </div>
            ),
          },
          {
            label: isRevnet ? 'Splits' : 'Reserved',
            content: (
              <ReservedCard
                chainId={chainId}
                projectId={projectId}
                isRevnet={isRevnet}
                chains={chains}
              />
            ),
          },
          ...(chains.length > 1
            ? [
                {
                  label: 'Settlement',
                  content: (
                    <SettlementSection
                      chainId={chainId}
                      projectId={projectId}
                      chains={chains}
                      isRevnet={isRevnet}
                    />
                  ),
                },
              ]
            : []),
          ...(isRevnet
            ? [
                {
                  label: 'Loans',
                  content: (
                    <LoansSection chainId={chainId} projectId={projectId} />
                  ),
                },
                {
                  label: 'Auto issuance',
                  content: (
                    <AutoIssuanceSection
                      chainId={chainId}
                      projectId={projectId}
                    />
                  ),
                },
              ]
            : []),
        ]}
      />
    </div>
  )
}

// -------------------------------------------------------------- YOU card --

function YouCard({ chains }: { chains: [number, number][] }) {
  const { isConnected, address, openSignIn } = useWallet()

  // Wallet state only exists client-side; keep SSR + first client render
  // identical so hydration always matches (OwnerPanel pattern).
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const connected = mounted && isConnected && !!address

  return (
    <div className="card p-5">
      <span className="field-label">You</span>
      {!connected ? (
        <div className="mt-2">
          <p className="text-sm leading-relaxed text-smoke-700">
            Connect to see your position.
          </p>
          <button
            onClick={openSignIn}
            className="btn-secondary mt-3 min-h-[40px] px-4 text-sm"
          >
            Sign in
          </button>
        </div>
      ) : (
        <div className="mt-3 divide-y divide-smoke-100">
          {chains.map(([cid, pid]) => (
            <YourChainRow
              key={cid}
              chainId={cid as JBChainId}
              projectId={pid}
              holder={address!}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/** Everything the YOU card shows for one chain, read in one pass. */
type Position = {
  /** Credits + ERC-20, 18-dec fixed point (JBTokens.totalBalanceOf). */
  balance: bigint
  credits: bigint
  erc20Balance: bigint
  /** The project's ERC-20, or null when only credits exist. */
  token: Address | null
  /** What the full balance would reclaim from surplus right now, or null
   *  when the project has no accounting context on this chain. */
  cashOutValue: bigint | null
  cashOutDecimals: number
  cashOutSymbol: string
}

function YourChainRow({
  chainId,
  projectId,
  holder,
}: {
  chainId: JBChainId
  projectId: number
  holder: Address
}) {
  const publicClient = usePublicClient({ chainId }) as PublicClient | undefined

  const {
    data: position,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['yourPosition', chainId, projectId, holder],
    enabled: !!publicClient,
    staleTime: 30_000,
    retry: 1,
    queryFn: async (): Promise<Position> => {
      const client = publicClient!
      const tokensAddress = jbContractAddress['6'][JBCoreContracts.JBTokens][
        chainId
      ] as Address | undefined
      const terminal = jbContractAddress['6'][
        JBCoreContracts.JBMultiTerminal
      ][chainId] as Address | undefined
      const store = jbContractAddress['6'][JBCoreContracts.JBTerminalStore][
        chainId
      ] as Address | undefined
      if (!tokensAddress || !terminal || !store) {
        throw new Error(`Unsupported chain ${chainId}`)
      }
      const [balance, credits, token, contexts] = await Promise.all([
        client.readContract({
          abi: jbTokensAbi,
          address: tokensAddress,
          functionName: 'totalBalanceOf',
          args: [holder, BigInt(projectId)],
        }),
        getCreditBalance(client, {
          chainId,
          projectId: BigInt(projectId),
          holder,
        }),
        getTokenAddress(client, { chainId, projectId: BigInt(projectId) }),
        getAccountingContexts(client, {
          chainId,
          projectId: BigInt(projectId),
        }),
      ])
      const erc20Balance = token
        ? await client.readContract({
            abi: erc20Abi,
            address: token,
            functionName: 'balanceOf',
            args: [holder],
          })
        : 0n

      // Cash-out value: what the FULL balance would reclaim from surplus
      // right now, denominated in the primary accounting token.
      const primary = contexts[0]
      let cashOutValue: bigint | null = null
      let cashOutSymbol = ''
      let cashOutDecimals = 18
      if (primary) {
        cashOutDecimals = primary.decimals
        const isNative =
          primary.token.toLowerCase() === NATIVE_TOKEN.toLowerCase()
        cashOutSymbol = isNative
          ? (JB_CHAINS[chainId]?.nativeTokenSymbol ?? 'ETH')
          : await client
              .readContract({
                abi: erc20Abi,
                address: primary.token,
                functionName: 'symbol',
              })
              .catch(() => truncateAddress(primary.token))
        cashOutValue =
          balance > 0n
            ? ((await client.readContract({
                abi: jbTerminalStoreAbi,
                address: store,
                functionName: 'currentReclaimableSurplusOf',
                args: [
                  BigInt(projectId),
                  balance,
                  [terminal],
                  contexts.map(ctx => ctx.token),
                  BigInt(primary.decimals),
                  BigInt(primary.currency),
                ],
              })) as bigint)
            : 0n
      }

      return {
        balance,
        credits,
        erc20Balance,
        token,
        cashOutValue,
        cashOutDecimals,
        cashOutSymbol,
      }
    },
  })

  return (
    <div className="py-3 first:pt-0 last:pb-0">
      <div className="flex items-start justify-between gap-3">
        <span className="flex items-center gap-2 text-sm text-smoke-700">
          <ChainIcon chainId={chainId} size={16} />
          {chainName(chainId)}
        </span>
        <div className="text-right">
          {isLoading ? (
            <span className="text-sm text-smoke-500">Loading…</span>
          ) : isError || !position ? (
            <span className="text-sm text-smoke-500">
              Couldn&apos;t load your position here.
            </span>
          ) : (
            <>
              <p className="text-sm font-medium text-ink">
                {formatTokenAmount(position.balance)} tokens
              </p>
              {position.token ? (
                <p className="mt-0.5 text-xs text-smoke-700">
                  {formatTokenAmount(position.credits)} credits |{' '}
                  {formatTokenAmount(position.erc20Balance)} ERC-20
                </p>
              ) : position.credits > 0n ? (
                <p className="mt-0.5 text-xs text-smoke-700">
                  All credits — no ERC-20 deployed yet
                </p>
              ) : null}
              {position.cashOutValue !== null ? (
                <p className="mt-0.5 text-xs text-smoke-700">
                  Cash-out value (approx):{' '}
                  {formatTokenAmount(
                    position.cashOutValue,
                    position.cashOutDecimals,
                  )}{' '}
                  {position.cashOutSymbol}
                </p>
              ) : null}
            </>
          )}
        </div>
      </div>
      {position?.token && position.credits > 0n ? (
        <ClaimFlow
          chainId={chainId}
          projectId={projectId}
          holder={holder}
          credits={position.credits}
          onDone={refetch}
        />
      ) : null}
    </div>
  )
}

// ------------------------------------------------------------ claim flow --

/** The reviewed claim: args frozen at review time so what the user confirms
 *  is what's sent (FundsTab pattern). */
type ReviewedClaim = {
  request: {
    chainId: JBChainId
    address: Address
    abi: typeof jbControllerAbi
    functionName: 'claimTokensFor'
    args: readonly [Address, bigint, bigint, Address]
  }
  /** The credit count being claimed, 18-dec fixed point. */
  amount: bigint
  /** The account the review was made for. */
  account: Address
}

/**
 * Claim credits as ERC-20 (JBController.claimTokensFor, tx #7): full credit
 * balance, beneficiary = the holder. The project's controller is read from
 * JBDirectory — never assumed — and must be the canonical JBController the
 * SDK builder targets.
 */
function ClaimFlow({
  chainId,
  projectId,
  holder,
  credits,
  onDone,
}: {
  chainId: JBChainId
  projectId: number
  holder: Address
  credits: bigint
  onDone: () => void
}) {
  const publicClient = usePublicClient({ chainId }) as PublicClient | undefined
  const { address } = useWallet()
  const tx = useSafeTx(chainId)

  const [checking, setChecking] = useState(false)
  const [flowError, setFlowError] = useState<string | null>(null)
  const [review, setReview] = useState<ReviewedClaim | null>(null)

  const busy =
    checking ||
    tx.phase === 'simulating' ||
    tx.phase === 'signing' ||
    tx.phase === 'pending'

  const chainMeta = JB_CHAINS[chainId]
  const txUrl = tx.hash
    ? `https://${chainMeta?.etherscanHostname}/tx/${tx.hash}`
    : null

  useEffect(() => {
    if (tx.phase === 'success') onDone()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tx.phase])

  /** Re-read live state (credits, controller) and freeze the exact args. */
  const handleReview = async () => {
    if (!publicClient || busy) return
    setFlowError(null)
    setChecking(true)
    try {
      const directory = jbContractAddress['6'][JBCoreContracts.JBDirectory][
        chainId
      ] as Address
      const [freshCredits, controller] = await Promise.all([
        getCreditBalance(publicClient, {
          chainId,
          projectId: BigInt(projectId),
          holder,
        }),
        publicClient.readContract({
          abi: jbDirectoryAbi,
          address: directory,
          functionName: 'controllerOf',
          args: [BigInt(projectId)],
        }),
      ])
      if (freshCredits <= 0n) {
        throw new Error('No credits left to claim.')
      }
      // The claim goes through the project's own controller. The SDK builder
      // targets the canonical JBController — bail out for custom controllers
      // rather than send a call that would revert (OwnerPanel pattern).
      if (!isKnownController(chainId, controller)) {
        throw new Error(
          'This project uses a custom controller — claiming here is not supported.',
        )
      }
      const request = buildClaimTokensTx({
        chainId,
        holder,
        projectId: BigInt(projectId),
        tokenCount: freshCredits,
        beneficiary: holder,
      })
      setReview({ request, amount: freshCredits, account: holder })
    } catch (e) {
      setFlowError(e instanceof Error ? e.message : 'Something went wrong.')
    } finally {
      setChecking(false)
    }
  }

  const handleConfirm = () => {
    if (!review || busy) return
    // Account-unchanged recheck: the frozen args claim FOR this holder.
    if (address?.toLowerCase() !== review.account.toLowerCase()) {
      setReview(null)
      setFlowError('Your connected account changed — start the claim again.')
      return
    }
    tx.send(review.request)
  }

  if (tx.phase === 'success') {
    return (
      <div className="mt-2 rounded-lg bg-split-50 px-3.5 py-2.5 text-xs leading-relaxed text-smoke-900">
        Claimed — the tokens are in your wallet as ERC-20.
        {txUrl ? (
          <>
            {' '}
            <a
              href={txUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-bluebs-600 underline underline-offset-2 hover:text-bluebs-700"
            >
              View transaction
            </a>
          </>
        ) : null}
      </div>
    )
  }

  return (
    <div className="mt-2">
      {review ? (
        <div className="rounded-lg bg-split-50 px-3.5 py-2.5 text-xs leading-relaxed text-smoke-900">
          {formatTokenAmount(review.amount)} credits will become ERC-20 tokens
          in your wallet. Nothing else changes — same balance, now movable.
        </div>
      ) : null}
      <button
        onClick={review ? handleConfirm : handleReview}
        disabled={busy}
        className="btn-secondary mt-2 min-h-[36px] px-4 text-xs"
      >
        {checking
          ? 'Checking your credits…'
          : tx.phase === 'simulating'
            ? 'Double-checking the transaction…'
            : tx.phase === 'signing'
              ? 'Confirm in your wallet…'
              : tx.phase === 'pending'
                ? 'Claiming…'
                : review
                  ? 'Confirm claim'
                  : 'Claim as ERC-20'}
      </button>
      {tx.phase === 'pending' && txUrl ? (
        <p className="mt-1.5 text-xs text-smoke-700">
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
        <p className="mt-1.5 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700">
          {flowError ?? tx.error}
        </p>
      ) : null}
    </div>
  )
}

// -------------------------------------------------------------- ALL card --

type AggregatedHolder = {
  address: string
  balance: bigint
  volumeUsd: bigint
  chains: number[]
}

function polarPoint(cx: number, cy: number, radius: number, angle: number) {
  return {
    x: (cx + Math.cos(angle) * radius).toFixed(3),
    y: (cy + Math.sin(angle) * radius).toFixed(3),
  }
}

function donutSlicePath(start: number, end: number): string {
  const cx = 120
  const cy = 112
  const outer = 92
  const inner = 54
  const largeArc = end - start > Math.PI ? 1 : 0
  const p1 = polarPoint(cx, cy, outer, start)
  const p2 = polarPoint(cx, cy, outer, end)
  const p3 = polarPoint(cx, cy, inner, end)
  const p4 = polarPoint(cx, cy, inner, start)
  return [
    `M ${p1.x} ${p1.y}`,
    `A ${outer} ${outer} 0 ${largeArc} 1 ${p2.x} ${p2.y}`,
    `L ${p3.x} ${p3.y}`,
    `A ${inner} ${inner} 0 ${largeArc} 0 ${p4.x} ${p4.y}`,
    'Z',
  ].join(' ')
}

function holderPercent(balance: bigint, total: bigint): number {
  return total > 0n
    ? Number((balance * 1_000_000n) / total) / 10_000
    : 0
}

function holderPercentLabel(balance: bigint, total: bigint): string {
  const pct = holderPercent(balance, total)
  if (pct >= 10) return `${pct.toFixed(2)}%`
  if (pct >= 1) return `${pct.toFixed(3)}%`
  if (pct >= 0.01) return `${pct.toFixed(4)}%`
  return '<0.01%'
}

function compactTokenTotal(raw: bigint): string {
  const value = Number(formatUnits(raw, 18))
  if (!Number.isFinite(value)) return '—'
  if (value >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(value >= 10_000_000_000 ? 0 : 1).replace(/\.0$/, '')}b`
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}m`
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1).replace(/\.0$/, '')}k`
  }
  return formatTokenAmount(raw)
}

function indexedPaidLabel(raw: bigint): string {
  if (raw <= 0n) return '—'
  const usd = Number(raw / 1_000_000_000_000n) / 1_000_000
  if (usd > 0 && usd < 0.01) return '<$0.01'
  return `$${usd.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

function OwnersDonut({
  holders,
  total,
  countLabel,
  tokenUnit,
}: {
  holders: AggregatedHolder[]
  total: bigint
  countLabel: string
  tokenUnit: string
}) {
  const drawable = holders.filter(holder => holder.balance > 0n).reverse()
  const slices: { holder: AggregatedHolder; path: string }[] = []
  let angle = 0

  if (drawable.length === 1) {
    slices.push({
      holder: drawable[0],
      path: donutSlicePath(0, Math.PI * 2 - 0.001),
    })
  } else {
    for (const holder of drawable) {
      const share = Number(
        (holder.balance * 1_000_000_000_000n) / total,
      ) / 1_000_000_000_000
      if (!Number.isFinite(share) || share <= 0) continue
      const next = angle + share * Math.PI * 2
      slices.push({ holder, path: donutSlicePath(angle, next) })
      angle = next
    }
  }

  return (
    <div className="min-w-0 text-center">
      <svg
        viewBox="0 0 240 218"
        role="img"
        aria-label={`${tokenUnit} owner distribution`}
        className="mx-auto block w-full max-w-[280px]"
      >
        {slices.map(({ holder, path }) => (
          <path
            key={holder.address}
            d={path}
            className="fill-crush-300 transition-colors hover:fill-crush-400"
            stroke="white"
            strokeWidth="0.8"
          >
            <title>
              {truncateAddress(holder.address)} —{' '}
              {holderPercentLabel(holder.balance, total)}
            </title>
          </path>
        ))}
        <text
          x="120"
          y="108"
          textAnchor="middle"
          className="fill-ink font-agrandir text-[28px] font-medium"
        >
          {countLabel}
        </text>
        <text
          x="120"
          y="132"
          textAnchor="middle"
          className="fill-smoke-500 text-[11px] uppercase tracking-wide"
        >
          owners
        </text>
      </svg>
      <p className="mt-1 text-xs text-smoke-500">
        {compactTokenTotal(total)} {tokenUnit}
      </p>
    </div>
  )
}

function AllHoldersCard({
  chainId,
  projectId,
  suckerGroupId,
  etherscanHost,
}: {
  chainId: JBChainId
  projectId: number
  suckerGroupId: string | null
  etherscanHost?: string
}) {
  const { data: projectTokenAddress } = useReadContract({
    abi: jbTokensAbi,
    address: jbContractAddress['6'][JBCoreContracts.JBTokens][chainId],
    functionName: 'tokenOf',
    args: [BigInt(projectId)],
    chainId,
    query: { staleTime: 60_000 },
  })
  const tokenDeployed =
    !!projectTokenAddress && projectTokenAddress !== zeroAddress
  const { data: projectTokenSymbol } = useReadContract({
    abi: erc20Abi,
    address: projectTokenAddress as Address,
    functionName: 'symbol',
    chainId,
    query: { enabled: tokenDeployed, staleTime: 60_000 },
  })
  const tokenUnit = projectTokenSymbol ? String(projectTokenSymbol) : 'tokens'

  const { data, isLoading, isError } = useQuery({
    queryKey: ['participants', suckerGroupId ?? `${chainId}:${projectId}`],
    staleTime: 60_000,
    retry: 1,
    queryFn: async () => {
      const qs = suckerGroupId
        ? `suckerGroupId=${encodeURIComponent(suckerGroupId)}`
        : `chainId=${chainId}&projectId=${projectId}`
      const res = await fetch(`/api/participants?${qs}`)
      if (!res.ok) throw new Error('Holder data unavailable')
      return (await res.json()) as {
        items: BsParticipant[]
        totalCount: number
      }
    },
  })

  // One row per holder: an omnichain holder shows up once per chain in the
  // indexer, so fold the rows together by address before ranking.
  const holders = useMemo(() => {
    const byAddress = new Map<
      string,
      {
        address: string
        balance: bigint
        volumeUsd: bigint
        chains: Set<number>
      }
    >()
    for (const p of data?.items ?? []) {
      const key = p.address.toLowerCase()
      const holder = byAddress.get(key) ?? {
        address: p.address,
        balance: 0n,
        volumeUsd: 0n,
        chains: new Set<number>(),
      }
      holder.balance += BigInt(p.balance)
      holder.volumeUsd += BigInt(p.volumeUsd || '0')
      holder.chains.add(p.chainId)
      byAddress.set(key, holder)
    }
    return [...byAddress.values()]
      .map(holder => ({
        ...holder,
        chains: [...holder.chains].sort((a, b) => a - b),
      }))
      .sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0))
  }, [data])

  const total = holders.reduce((sum, h) => sum + h.balance, 0n)
  const top = holders.slice(0, 10)
  // All rows fetched = the aggregated count is the real holder count;
  // truncated = we only know it's at least that many.
  const exact = !!data && data.totalCount <= data.items.length
  const holderCount = exact ? String(holders.length) : `${holders.length}+`
  const holderCountLine = `${holderCount} ${
    holders.length === 1 && exact ? 'holder' : 'holders'
  }`

  return (
    <div className="card p-5">
      <span className="field-label">All</span>
      <p className="mt-2 text-sm leading-relaxed text-smoke-700">
        Token owners paid in, received splits, received auto-issuance, or got
        them second-hand.
      </p>
      {isLoading ? (
        <p className="mt-2 text-sm text-smoke-500">Loading…</p>
      ) : isError ? (
        <p className="mt-2 text-sm text-smoke-700">
          Holder data is unavailable right now.
        </p>
      ) : holders.length === 0 ? (
        <p className="mt-2 text-sm leading-relaxed text-smoke-700">
          No one holds this project&apos;s tokens yet.
        </p>
      ) : (
        <>
          <div className="mt-4 grid items-start gap-6 md:grid-cols-[minmax(200px,280px)_minmax(0,1fr)]">
            <OwnersDonut
              holders={holders}
              total={total}
              countLabel={holderCount}
              tokenUnit={tokenUnit}
            />
            <div className="min-w-0 overflow-x-auto rounded-xl border border-smoke-200">
              <div className="min-w-[520px]">
                <div className="grid grid-cols-[minmax(150px,1.5fr)_80px_100px_90px] gap-3 bg-smoke-75 px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wide text-smoke-500">
                  <span>Account</span>
                  <span>Share</span>
                  <span>Chains</span>
                  <span>Paid</span>
                </div>
                <div className="divide-y divide-smoke-100">
                  {top.map(holder => (
                    <div
                      key={holder.address}
                      className="grid grid-cols-[minmax(150px,1.5fr)_80px_100px_90px] items-center gap-3 px-4 py-3 text-sm"
                    >
                      <span className="min-w-0">
                        {etherscanHost ? (
                          <a
                            href={`https://${etherscanHost}/address/${holder.address}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-ink hover:underline"
                          >
                            {truncateAddress(holder.address)}
                          </a>
                        ) : (
                          <span className="text-ink">
                            {truncateAddress(holder.address)}
                          </span>
                        )}
                      </span>
                      <span className="font-medium text-ink">
                        {holderPercentLabel(holder.balance, total)}
                      </span>
                      <span className="flex items-center pl-1">
                        {holder.chains.map((id, index) => (
                          <ChainIcon
                            key={id}
                            chainId={id}
                            size={16}
                            className={index > 0 ? '-ml-1' : ''}
                          />
                        ))}
                      </span>
                      <span className="text-smoke-700">
                        {indexedPaidLabel(holder.volumeUsd)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
          <p className="mt-3 text-xs text-smoke-700">
            {holderCountLine}
            {holders.length > top.length || !exact
              ? ' — showing the 10 largest, as shares of the balances tracked here'
              : ''}
          </p>
        </>
      )}
    </div>
  )
}

// --------------------------------------------- Reserved / Splits subtab --

/** The JBSplits.splitsOf tuple shape (FundsTab pattern). */
type SplitRow = {
  percent: number
  projectId: bigint
  beneficiary: Address
  preferAddToBalance: boolean
  lockedUntil: number
  hook: Address
}

function formatPercent(pct: number): string {
  return `${pct.toFixed(2).replace(/\.?0+$/, '')}%`
}

/** A split's percentage of all issuance, not merely of the reserved group. */
function effectiveSplitPercent(
  splitPercent: number,
  reservedPercent: number,
): number {
  return (reservedPercent / 100) * (splitPercent / SPLITS_TOTAL_PERCENT)
}

function SplitRecipient({
  split,
  chainId,
}: {
  split: SplitRow
  chainId: JBChainId
}) {
  const etherscanHost = JB_CHAINS[chainId]?.etherscanHostname

  if (split.hook !== zeroAddress) {
    return (
      <span>
        {linkedAddress(split.hook, etherscanHost)}
        <span className="ml-1.5 text-xs text-smoke-500">hook</span>
      </span>
    )
  }
  if (split.projectId > 0n) {
    return (
      <Link
        href={`/${toUrn(chainId, Number(split.projectId))}`}
        className="text-ink hover:underline"
      >
        Project #{split.projectId.toString()}
      </Link>
    )
  }
  if (split.beneficiary.toLowerCase() === BURN_ADDRESS) {
    return <span className="text-ink">Burn</span>
  }
  return linkedAddress(split.beneficiary, etherscanHost)
}

/**
 * Where reserved tokens go under the current ruleset, how many are waiting,
 * and the anyone-can-send distribute flow
 * (JBController.sendReservedTokensToSplitsOf, tx #20).
 */
function ReservedCard({
  chainId,
  projectId,
  isRevnet,
  chains,
}: {
  chainId: JBChainId
  projectId: number
  isRevnet: boolean
  chains: [number, number][]
}) {
  const publicClient = usePublicClient({ chainId }) as PublicClient | undefined

  const splitsAddress = jbContractAddress['6'][JBCoreContracts.JBSplits][
    chainId
  ] as Address

  const {
    data: stageData,
    isLoading: rulesetLoading,
    isError: rulesetError,
  } = useQuery({
    queryKey: ['splitStages', chainId, projectId],
    enabled: !!publicClient,
    staleTime: 60_000,
    retry: 1,
    queryFn: async () => {
      const args = { chainId, projectId: BigInt(projectId) }
      const [all, current] = await Promise.all([
        getAllRulesets(publicClient!, { ...args, size: 50n }),
        getCurrentRuleset(publicClient!, args).catch(() => null),
      ])
      return { all, current }
    },
  })

  const stages: readonly JBRulesetWithMetadata[] = useMemo(
    () =>
      (stageData?.all ?? [])
        .slice()
        .sort((a, b) => a.ruleset.start - b.ruleset.start),
    [stageData?.all],
  )

  const now = Math.floor(Date.now() / 1000)
  let currentStageIndex = stages.findIndex(
    stage => stage.ruleset.id === stageData?.current?.ruleset.id,
  )
  if (currentStageIndex < 0) {
    currentStageIndex = 0
    stages.forEach((stage, index) => {
      if (stage.ruleset.start <= now) currentStageIndex = index
    })
  }

  const [chosenStageIndex, setChosenStageIndex] = useState<number | null>(null)
  const activeStageIndex = stages.length
    ? Math.min(
        Math.max(chosenStageIndex ?? currentStageIndex, 0),
        stages.length - 1,
      )
    : 0
  const activeStage = stages[activeStageIndex]
  const rulesetId = activeStage?.ruleset.id ?? 0
  const isCurrentStage = activeStageIndex === currentStageIndex

  const {
    data: splits,
    isLoading: splitsLoading,
    isError: splitsError,
  } = useReadContract({
    abi: jbSplitsAbi,
    address: splitsAddress,
    functionName: 'splitsOf',
    args: [BigInt(projectId), BigInt(rulesetId), RESERVED_TOKEN_SPLIT_GROUP_ID],
    chainId,
    query: { enabled: rulesetId > 0, staleTime: 60_000 },
  })

  const rows = (splits ?? []) as readonly SplitRow[]

  if (rulesetLoading) {
    return (
      <div className="card p-5">
        <span className="field-label">
          {isRevnet ? 'Splits' : 'Reserved tokens'}
        </span>
        <p className="mt-2 text-sm text-smoke-500">Loading…</p>
      </div>
    )
  }

  if (rulesetError || stages.length === 0) {
    return (
      <div className="card p-5">
        <span className="field-label">
          {isRevnet ? 'Splits' : 'Reserved tokens'}
        </span>
        <p className="mt-2 text-sm text-smoke-700">
          {rulesetError
            ? 'Couldn’t read the split stages right now.'
            : 'No stages found onchain.'}
        </p>
      </div>
    )
  }

  const reservedPercent = activeStage.metadata.reservedPercent

  return (
    <div className="card p-5">
      <span className="field-label">
        {isRevnet ? 'Splits' : 'Reserved tokens'}
      </span>
      <p className="mt-2 text-sm leading-relaxed text-smoke-700">
        A share of every batch of new tokens is set aside for the recipients
        below.
      </p>

      {isRevnet ? (
        <div className="mt-5 flex flex-wrap gap-5" aria-label="Split stage">
          {stages.map((stage, index) => (
            <button
              key={stage.ruleset.id}
              type="button"
              onClick={() => setChosenStageIndex(index)}
              className={`inline-flex min-h-[34px] items-center gap-2 border-b-2 px-0.5 pb-1 text-sm font-medium transition-colors ${
                activeStageIndex === index
                  ? 'border-ink text-ink'
                  : 'border-transparent text-smoke-500 hover:text-ink'
              }`}
            >
              Stage {index + 1}
              {index === currentStageIndex ? (
                <span
                  className="h-1.5 w-1.5 rounded-full bg-melon-600"
                  title="Current stage"
                  aria-label="Current stage"
                />
              ) : null}
            </button>
          ))}
        </div>
      ) : null}

      <p className="mt-3 text-sm text-smoke-700">
        {isRevnet ? 'The split limit for this stage is ' : 'Reserved rate: '}
        <span className="font-medium text-ink">
          {formatPercent(reservedPercent / 100)}
        </span>{' '}
        of issuance.
      </p>

      {splitsLoading ? (
        <p className="mt-4 text-sm text-smoke-500">Loading splits…</p>
      ) : splitsError ? (
        <p className="mt-4 text-sm text-smoke-700">
          Couldn’t read splits for this stage.
        </p>
      ) : rows.length === 0 ? (
        <p className="mt-4 text-sm text-smoke-700">
          {isRevnet
            ? 'No splits are configured for this stage — split tokens go to the revnet owner.'
            : 'No reserved recipients are configured — reserved tokens go to the project owner.'}
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <div className="min-w-[720px]">
            <div className="grid grid-cols-[minmax(220px,1.35fr)_minmax(200px,1fr)_minmax(180px,1fr)] gap-4 border-y border-smoke-200 px-3 py-2 text-xs text-smoke-500">
              <span>Account</span>
              <span>Percentage</span>
              <span>Pending splits</span>
            </div>
            <div className="space-y-5 pt-5">
              {chains.map(([cid, pid]) => (
                <ChainSplitsBlock
                  key={`${rulesetId}:${cid}`}
                  chainId={cid as JBChainId}
                  projectId={pid}
                  rows={rows}
                  reservedPercent={reservedPercent}
                  isCurrentStage={isCurrentStage}
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** One inline chain table, with that chain's pending balance and action. */
function ChainSplitsBlock({
  chainId,
  projectId,
  rows,
  reservedPercent,
  isCurrentStage,
}: {
  chainId: JBChainId
  projectId: number
  rows: readonly SplitRow[]
  reservedPercent: number
  isCurrentStage: boolean
}) {
  const directoryAddress = jbContractAddress['6'][JBCoreContracts.JBDirectory][
    chainId
  ] as Address
  const tokensAddress = jbContractAddress['6'][JBCoreContracts.JBTokens][
    chainId
  ] as Address

  const { data: base } = useReadContracts({
    contracts: [
      {
        abi: jbDirectoryAbi,
        address: directoryAddress,
        functionName: 'controllerOf',
        args: [BigInt(projectId)],
        chainId,
      },
      {
        abi: jbTokensAbi,
        address: tokensAddress,
        functionName: 'tokenOf',
        args: [BigInt(projectId)],
        chainId,
      },
    ],
    query: { staleTime: 60_000 },
  })
  const controller = base?.[0]?.result as Address | undefined
  const token = base?.[1]?.result as Address | undefined
  const tokenDeployed = !!token && token !== zeroAddress

  const { data: tokenSymbol } = useReadContract({
    abi: erc20Abi,
    address: token,
    functionName: 'symbol',
    chainId,
    query: { enabled: tokenDeployed, staleTime: 5 * 60_000 },
  })
  const symbol = tokenDeployed ? (tokenSymbol ?? 'tokens') : 'tokens'

  const {
    data: pending,
    isLoading: pendingLoading,
    refetch: refetchPending,
  } = useReadContract({
    abi: jbControllerAbi,
    address: controller,
    functionName: 'pendingReservedTokenBalanceOf',
    args: [BigInt(projectId)],
    chainId,
    query: { enabled: !!controller, staleTime: 30_000 },
  })

  const availablePending = isCurrentStage ? pending : 0n

  return (
    <section>
      <div className="flex items-center gap-2 text-sm font-medium text-smoke-700">
        <ChainIcon chainId={chainId} size={18} />
        <span>{chainName(chainId)}</span>
      </div>
      <div className="mt-2 overflow-hidden rounded-xl border border-smoke-200">
        {rows.map((split, index) => {
          const fraction = split.percent / SPLITS_TOTAL_PERCENT
          const recipientPending =
            availablePending && availablePending > 0n
              ? (availablePending * BigInt(split.percent)) /
                BigInt(SPLITS_TOTAL_PERCENT)
              : 0n

          return (
            <div
              key={`${split.beneficiary}-${split.projectId}-${index}`}
              className="grid grid-cols-[minmax(220px,1.35fr)_minmax(200px,1fr)_minmax(180px,1fr)] items-center gap-4 border-b border-smoke-100 px-3 py-3 text-sm last:border-b-0"
            >
              <span>
                <SplitRecipient split={split} chainId={chainId} />
              </span>
              <span>
                <strong className="font-medium text-ink">
                  {formatPercent(
                    effectiveSplitPercent(split.percent, reservedPercent),
                  )}
                </strong>
                <span className="text-smoke-500">
                  {' '}
                  ({formatPercent(fraction * 100)} of limit)
                </span>
              </span>
              <span className="text-ink">
                {pendingLoading && isCurrentStage
                  ? 'Loading…'
                  : recipientPending > 0n
                    ? `${formatTokenAmount(recipientPending)} ${symbol}`
                    : '—'}
              </span>
            </div>
          )
        })}
      </div>
      <div className="flex justify-end">
        <DistributeFlow
          chainId={chainId}
          projectId={projectId}
          controller={controller}
          pending={availablePending}
          symbol={symbol}
          onDone={() => void refetchPending()}
          compact
        />
      </div>
    </section>
  )
}

/**
 * "Distribute now" (tx #20): anyone can send it — it just moves the pending
 * reserved tokens to the recipients above. No user inputs, so the useSafeTx
 * simulation is the whole safety gate.
 */
function DistributeFlow({
  chainId,
  projectId,
  controller,
  pending,
  symbol,
  onDone,
  compact = false,
}: {
  chainId: JBChainId
  projectId: number
  controller: Address | undefined
  pending: bigint | undefined
  symbol: string
  onDone: () => void
  compact?: boolean
}) {
  const { isConnected, openSignIn } = useWallet()
  const tx = useSafeTx(chainId)

  const busy =
    tx.phase === 'simulating' ||
    tx.phase === 'signing' ||
    tx.phase === 'pending'

  const chainMeta = JB_CHAINS[chainId]
  const txUrl = tx.hash
    ? `https://${chainMeta?.etherscanHostname}/tx/${tx.hash}`
    : null

  useEffect(() => {
    if (tx.phase === 'success') onDone()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tx.phase])

  const handleDistribute = () => {
    if (busy || !controller || !pending || pending <= 0n) return
    if (!isConnected) {
      openSignIn()
      return
    }
    tx.send({
      chainId,
      address: controller,
      abi: jbControllerAbi,
      functionName: 'sendReservedTokensToSplitsOf',
      args: [BigInt(projectId)],
    })
  }

  if (tx.phase === 'success' && !compact) {
    return (
      <div className="mt-3 rounded-lg bg-split-50 px-3.5 py-2.5 text-xs leading-relaxed text-smoke-900">
        Distributed — the reserved tokens went to the recipients.
        {txUrl ? (
          <>
            {' '}
            <a
              href={txUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-bluebs-600 underline underline-offset-2 hover:text-bluebs-700"
            >
              View transaction
            </a>
          </>
        ) : null}
      </div>
    )
  }

  return (
    <div className={compact ? 'mt-2 flex flex-col items-end' : 'mt-3'}>
      <button
        onClick={handleDistribute}
        disabled={busy || !controller || !pending || pending <= 0n}
        className="btn-secondary min-h-[40px] px-4 text-sm"
      >
        {tx.phase === 'success'
          ? 'Distributed'
          : tx.phase === 'simulating'
          ? 'Double-checking the transaction…'
          : tx.phase === 'signing'
            ? 'Confirm in your wallet…'
            : tx.phase === 'pending'
              ? 'Distributing…'
              : compact
                ? 'Distribute'
                : 'Distribute now'}
      </button>
      {!compact && (!pending || pending <= 0n) ? (
        <p className="mt-1.5 text-xs text-smoke-700">
          Nothing to distribute right now.
        </p>
      ) : !compact ? (
        <p className="mt-1.5 text-xs text-smoke-700">
          Anyone can send this — it moves the{' '}
          {formatTokenAmount(pending ?? 0n)} {symbol} above to the recipients.
        </p>
      ) : null}
      {compact && tx.phase === 'success' ? (
        <p className="mt-1.5 text-xs text-smoke-700">
          Pending splits distributed.
          {txUrl ? (
            <>
              {' '}
              <a
                href={txUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2"
              >
                View transaction
              </a>
            </>
          ) : null}
        </p>
      ) : null}
      {tx.phase === 'pending' && txUrl ? (
        <p className="mt-1.5 text-xs text-smoke-700">
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
      {tx.error ? (
        <p className="mt-1.5 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700">
          {tx.error}
        </p>
      ) : null}
    </div>
  )
}

function linkedAddress(address: Address, etherscanHost?: string) {
  const label = truncateAddress(address)
  return etherscanHost ? (
    <a
      href={`https://${etherscanHost}/address/${address}`}
      target="_blank"
      rel="noopener noreferrer"
      className="text-ink hover:underline"
    >
      {label}
    </a>
  ) : (
    <span className="text-ink">{label}</span>
  )
}
