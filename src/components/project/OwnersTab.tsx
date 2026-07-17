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
  getCreditBalance,
  getCurrentRuleset,
  getTokenAddress,
} from '@bananapus/nana-sdk-core/v6'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import {
  erc20Abi,
  zeroAddress,
  type Address,
  type PublicClient,
} from 'viem'
import { usePublicClient, useReadContract, useReadContracts } from 'wagmi'
import { ChainIcon } from '@/components/ChainIcon'
import { TokenPanel } from '@/components/project/TokenPanel'
import { SubTabs } from '@/components/project/Tabs'
import { useSafeTx } from '@/hooks/useSafeTx'
import { useWallet } from '@/hooks/useWallet'
import type { BsParticipant } from '@/lib/bendystraw'
import { formatDate, formatTokenAmount, truncateAddress } from '@/lib/format'
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
                etherscanHost={etherscanHost}
              />
            ),
          },
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
    const byAddress = new Map<string, bigint>()
    for (const p of data?.items ?? []) {
      const key = p.address.toLowerCase()
      byAddress.set(key, (byAddress.get(key) ?? 0n) + BigInt(p.balance))
    }
    return [...byAddress.entries()]
      .map(([address, balance]) => ({ address, balance }))
      .sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0))
  }, [data])

  const total = holders.reduce((sum, h) => sum + h.balance, 0n)
  const top = holders.slice(0, 10)
  // All rows fetched = the aggregated count is the real holder count;
  // truncated = we only know it's at least that many.
  const exact = !!data && data.totalCount <= data.items.length
  const holderCountLine = exact
    ? `${holders.length} ${holders.length === 1 ? 'holder' : 'holders'}`
    : `${holders.length}+ holders`

  const percentOf = (balance: bigint) =>
    total > 0n ? Number((balance * 10_000n) / total) / 100 : 0

  return (
    <div className="card p-5">
      <span className="field-label">All holders</span>
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
          <div className="mt-3 space-y-2">
            {top.map(holder => {
              const pct = percentOf(holder.balance)
              return (
                <div
                  key={holder.address}
                  className="flex items-center gap-3 text-sm"
                >
                  <span className="w-28 shrink-0">
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
                  <span className="h-2 flex-1 overflow-hidden rounded-full bg-smoke-100">
                    <span
                      className="block h-full rounded-full bg-melon-500"
                      style={{ width: `${Math.max(pct, 0.5)}%` }}
                    />
                  </span>
                  <span className="w-14 shrink-0 text-right text-xs text-smoke-700">
                    {pct.toFixed(pct >= 10 ? 0 : 1)}%
                  </span>
                </div>
              )
            })}
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

function formatSplitPercent(percent: number): string {
  const pct = (percent / SPLITS_TOTAL_PERCENT) * 100
  return `${pct.toFixed(2).replace(/\.?0+$/, '')}%`
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
  etherscanHost,
}: {
  chainId: JBChainId
  projectId: number
  isRevnet: boolean
  chains: [number, number][]
  etherscanHost?: string
}) {
  const publicClient = usePublicClient({ chainId }) as PublicClient | undefined

  const splitsAddress = jbContractAddress['6'][JBCoreContracts.JBSplits][
    chainId
  ] as Address
  const directoryAddress = jbContractAddress['6'][JBCoreContracts.JBDirectory][
    chainId
  ] as Address
  const tokensAddress = jbContractAddress['6'][JBCoreContracts.JBTokens][
    chainId
  ] as Address

  const { data: rulesetData, isLoading: rulesetLoading } = useQuery({
    queryKey: ['currentRuleset', chainId, projectId],
    enabled: !!publicClient,
    staleTime: 60_000,
    retry: 1,
    queryFn: () =>
      getCurrentRuleset(publicClient!, {
        chainId,
        projectId: BigInt(projectId),
      }),
  })

  // The controller (read, never assumed) plus the project's own ERC-20 for
  // labeling the pending amount.
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

  const rulesetId = rulesetData?.ruleset.id ?? 0

  const { data: splits, isLoading: splitsLoading } = useReadContract({
    abi: jbSplitsAbi,
    address: splitsAddress,
    functionName: 'splitsOf',
    args: [BigInt(projectId), BigInt(rulesetId), RESERVED_TOKEN_SPLIT_GROUP_ID],
    chainId,
    query: { enabled: rulesetId > 0, staleTime: 60_000 },
  })

  const {
    data: pending,
    refetch: refetchPending,
  } = useReadContract({
    abi: jbControllerAbi,
    address: controller,
    functionName: 'pendingReservedTokenBalanceOf',
    args: [BigInt(projectId)],
    chainId,
    query: { enabled: !!controller, staleTime: 30_000 },
  })

  const rows = (splits ?? []) as readonly SplitRow[]
  const totalPercent = rows.reduce((sum, split) => sum + split.percent, 0)
  const leftoverPercent = Math.max(0, SPLITS_TOTAL_PERCENT - totalPercent)

  const recipientCell = (split: SplitRow) => {
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

  if (rulesetLoading || splitsLoading) {
    return (
      <div className="card p-5">
        <span className="field-label">
          {isRevnet ? 'Splits' : 'Reserved tokens'}
        </span>
        <p className="mt-2 text-sm text-smoke-500">Loading…</p>
      </div>
    )
  }

  return (
    <div className="card p-5">
      <span className="field-label">
        {isRevnet ? 'Splits' : 'Reserved tokens'}
      </span>
      <p className="mt-2 text-sm leading-relaxed text-smoke-700">
        A share of every batch of new tokens is set aside for the recipients
        below.
      </p>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-smoke-500">
              <th className="pb-1.5 font-normal">Recipient</th>
              <th className="pb-1.5 text-right font-normal">Share</th>
              <th className="pb-1.5 text-right font-normal">Locked until</th>
            </tr>
          </thead>
          <tbody className="text-ink">
            {rows.map((split, i) => (
              <tr key={i} className="border-t border-smoke-100">
                <td className="py-1.5 pr-3">{recipientCell(split)}</td>
                <td className="py-1.5 text-right">
                  {formatSplitPercent(split.percent)}
                </td>
                <td className="py-1.5 text-right">
                  {split.lockedUntil > 0 ? (
                    formatDate(split.lockedUntil)
                  ) : (
                    <span className="text-smoke-500">Not locked</span>
                  )}
                </td>
              </tr>
            ))}
            {leftoverPercent > 0 ? (
              <tr className="border-t border-smoke-100">
                <td className="py-1.5 pr-3 text-smoke-700">
                  {isRevnet
                    ? "The revnet's operator split pool (the rest)"
                    : 'Project owner (the rest)'}
                </td>
                <td className="py-1.5 text-right">
                  {formatSplitPercent(leftoverPercent)}
                </td>
                <td className="py-1.5 text-right">
                  <span className="text-smoke-500">Not locked</span>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex items-baseline justify-between gap-3 text-sm">
        <span className="text-smoke-700">Waiting to be distributed</span>
        <span className="font-medium text-ink">
          {pending !== undefined
            ? `${formatTokenAmount(pending)} ${symbol}`
            : '—'}
        </span>
      </div>

      <DistributeFlow
        chainId={chainId}
        projectId={projectId}
        controller={controller}
        pending={pending}
        symbol={symbol}
        onDone={refetchPending}
      />

      {chains.length > 1 ? (
        <p className="mt-3 text-xs leading-relaxed text-smoke-700">
          Each chain distributes separately:{' '}
          {chains
            .filter(([cid]) => cid !== chainId)
            .map(([cid, pid], i, arr) => (
              <span key={cid}>
                <Link
                  href={`/${toUrn(cid, pid)}#${isRevnet ? 'owners' : 'tokens'}`}
                  className="underline underline-offset-2 hover:text-ink"
                >
                  {chainName(cid)}
                </Link>
                {i < arr.length - 1 ? ', ' : ''}
              </span>
            ))}
          .
        </p>
      ) : null}
    </div>
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
}: {
  chainId: JBChainId
  projectId: number
  controller: Address | undefined
  pending: bigint | undefined
  symbol: string
  onDone: () => void
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

  if (tx.phase === 'success') {
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
    <div className="mt-3">
      <button
        onClick={handleDistribute}
        disabled={busy || !controller || !pending || pending <= 0n}
        className="btn-secondary min-h-[40px] px-4 text-sm"
      >
        {tx.phase === 'simulating'
          ? 'Double-checking the transaction…'
          : tx.phase === 'signing'
            ? 'Confirm in your wallet…'
            : tx.phase === 'pending'
              ? 'Distributing…'
              : 'Distribute now'}
      </button>
      {!pending || pending <= 0n ? (
        <p className="mt-1.5 text-xs text-smoke-700">
          Nothing to distribute right now.
        </p>
      ) : (
        <p className="mt-1.5 text-xs text-smoke-700">
          Anyone can send this — it moves the{' '}
          {formatTokenAmount(pending)} {symbol} above to the recipients.
        </p>
      )}
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
