'use client'

import {
  JB_CHAINS,
  JBCoreContracts,
  SPLITS_TOTAL_PERCENT,
  jbContractAddress,
  jbControllerAbi,
  jbDirectoryAbi,
  jbMultiTerminalAbi,
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
  getBorrowableAmount,
  getCreditBalance,
  getCurrentRuleset,
  getTokenAddress,
  type JBRulesetWithMetadata,
} from '@bananapus/nana-sdk-core/v6'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { erc20Abi, type Address, type PublicClient } from 'viem'
import { usePublicClient, useReadContract } from 'wagmi'
import { ChainIcon } from '@/components/ChainIcon'
import {
  HolderDistributionSkeleton,
  SplitsCardSkeleton,
} from '@/components/LoadingSkeletons'
import { Skeleton, SkeletonTable } from '@/components/ui/Skeleton'
import { AddLiquidityFlow } from '@/components/project/AddLiquidityFlow'
import { AutoIssuanceSection } from '@/components/project/AutoIssuanceSection'
import { CashOutPanel } from '@/components/project/CashOutFlow'
import { BurnTokensFlow } from '@/components/project/BurnTokensFlow'
import { EditSplitsFlow } from '@/components/project/EditSplitsFlow'
import { GetLoanFlow } from '@/components/project/GetLoanFlow'
import { LoansSection } from '@/components/project/LoansSection'
import { MarketSection } from '@/components/project/MarketSection'
import { MoveCard } from '@/components/project/MoveFlow'
import { SettlementSection } from '@/components/project/SettlementSection'
import {
  SplitRecipient,
  type Split as SplitRow,
} from '@/components/project/SplitRecipient'
import { TokenPanel } from '@/components/project/TokenPanel'
import { SubTabs } from '@/components/project/Tabs'
import { AddressLink } from '@/components/ui/AddressLink'
import { AddressText } from '@/components/ui/AddressLabel'
import { ModalShell } from '@/components/ui/ModalShell'
import { donutSlicePath } from '@/lib/donut'
import {
  LiquidityPositions,
  useUserLpSummary,
} from '@/components/project/LiquidityPositions'
import { TxError } from '@/components/ui/TxError'
import { useProjectTokenSymbol } from '@/hooks/useProjectTokenSymbol'
import { txPhaseLabel, useSafeTx } from '@/hooks/useSafeTx'
import { useWallet } from '@/hooks/useWallet'
import { useViewedAccount } from '@/hooks/useViewedAccount'
import type { BsParticipant } from '@/lib/bendystraw'
import { netOfCashOutFee } from '@/lib/cashOut'
import {
  compactTokenTotal,
  fmtPct,
  formatTokenAmount,
} from '@/lib/format'
import { isKnownController } from '@/lib/manage'
import { netLoanProceeds } from '@/lib/loanFees'
import { tokenSymbol as readTokenSymbol } from '@/lib/token-symbol'
import { buildSendReservedTokensRequest } from '@/lib/transaction-builders'
import { chainName } from '@/lib/urn'

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
  tokenSymbol = 'tokens',
}: {
  chainId: JBChainId
  projectId: number
  isRevnet: boolean
  suckerGroupId: string | null
  /** [chainId, projectId] pairs across the sucker group (incl. this chain). */
  chains: [number, number][]
  /** The project's own token symbol, for the Market card display. */
  tokenSymbol?: string
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
        hashParent="tokens"
        tabs={[
          {
            label: 'Accounts',
            content: (
              <div className="space-y-5">
                <YouCard
                  chainId={chainId}
                  projectId={projectId}
                  isRevnet={isRevnet}
                  chains={chains}
                />
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
            label: 'Market',
            content: (
              <MarketSection
                chainId={chainId}
                projectId={projectId}
                tokenSymbol={tokenSymbol}
              />
            ),
          },
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
          ...(isRevnet
            ? [
                {
                  label: 'Auto issuance',
                  content: (
                    <AutoIssuanceSection
                      chains={chains}
                      tokenSymbol={tokenSymbol}
                    />
                  ),
                },
                {
                  label: 'Loans',
                  content: (
                    <LoansSection chainId={chainId} projectId={projectId} />
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

type YouAction = 'cashOut' | 'burn' | 'loan' | 'move' | 'liquidity'
const OWNERS_PAGE_SIZE = 30

export function ownerPageWindow<T>(
  items: readonly T[],
  requestedPage: number,
  pageSize = OWNERS_PAGE_SIZE,
) {
  const safePageSize = Math.max(1, Math.floor(pageSize))
  const pageCount = Math.max(1, Math.ceil(items.length / safePageSize))
  const page = Math.max(0, Math.min(pageCount - 1, Math.floor(requestedPage)))
  const start = page * safePageSize
  return {
    items: items.slice(start, start + safePageSize),
    page,
    pageCount,
  }
}

/**
 * The Accounts (YOU) card (website/ parity: renderYouCard + opsActionsRow):
 * the connected holder's per-chain position (balance, cash-out value, and — for
 * revnets — max loan), plus every token-holder action in one place: Cash out,
 * Get a loan (revnet), and Move between chains (multichain). Each action opens
 * its flow in a modal. Every write runs through useSafeTx (simulate-first).
 */
function YouCard({
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
  const { openSignIn } = useWallet()
  const { address } = useViewedAccount()

  // Wallet state only exists client-side; keep SSR + first client render
  // identical so hydration always matches (OwnerPanel pattern).
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const connected = mounted && !!address

  const [action, setAction] = useState<YouAction | null>(null)

  // The project's OWN token symbol, resolved on-chain (NOT bendystraw's
  // accounting symbol). Omnichain ERC-20s share one address/symbol, so resolve
  // it once on the primary chain.
  const { data: ownToken } = useProjectTokenSymbol(
    (chains[0]?.[0] ?? chainId) as JBChainId,
    chains[0]?.[1] ?? projectId,
  )
  const collateralSymbol = ownToken?.symbol || 'tokens'

  const multiChain = chains.length > 1

  const actionBtn = (id: YouAction, label: string) => (
    <button
      type="button"
      onClick={() => setAction(id)}
      className="btn-secondary min-h-[40px] px-4 text-sm"
      aria-haspopup="dialog"
      aria-expanded={action === id}
    >
      {label}
    </button>
  )

  const actionTitle =
    action === 'cashOut'
      ? 'Cash out'
      : action === 'burn'
        ? 'Burn tokens'
        : action === 'loan'
          ? 'Get a loan'
          : action === 'move'
            ? 'Move between chains'
            : action === 'liquidity'
              ? 'Add market liquidity'
              : null

  return (
    <div className="card p-5">
      <span className="field-label">You</span>
      {!connected ? (
        <div className="mt-2">
          <p className="text-sm leading-relaxed text-smoke-700">
            Sign in to see your position.
          </p>
          <button
            onClick={openSignIn}
            className="btn-primary mt-3 min-h-[40px] px-4 text-sm"
          >
            Sign in
          </button>
        </div>
      ) : (
        <>
          <div className="mt-4 overflow-x-auto rounded-xl border border-smoke-200">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-smoke-50">
                <tr className="border-b border-smoke-200 text-left text-xs text-smoke-500">
                  <th className="whitespace-nowrap px-4 py-3 font-normal">
                    Chain
                  </th>
                  <th className="whitespace-nowrap px-4 py-3 text-right font-normal">
                    Balance
                  </th>
                  <th className="whitespace-nowrap px-4 py-3 text-right font-normal">
                    Cash out
                  </th>
                  <th
                    className="whitespace-nowrap px-4 py-3 text-right font-normal"
                    title="Estimated proceeds after the protocol, REV, and minimum source fees"
                  >
                    Max loan
                  </th>
                  <th className="whitespace-nowrap px-4 py-3 text-right font-normal">
                    LP
                  </th>
                </tr>
              </thead>
              <tbody>
                {chains.map(([cid, pid]) => (
                  <YourChainRow
                    key={cid}
                    chainId={cid as JBChainId}
                    projectId={pid}
                    holder={address!}
                    isRevnet={isRevnet}
                    tokenSymbol={collateralSymbol}
                  />
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            {actionBtn('cashOut', 'Cash out')}
            {isRevnet ? actionBtn('loan', 'Get a loan') : null}
            {multiChain ? actionBtn('move', 'Move between chains') : null}
            {actionBtn('liquidity', 'Add market liquidity')}
            {actionBtn('burn', 'Burn')}
          </div>

          {action && actionTitle ? (
            <ModalShell
              title={actionTitle}
              onClose={() => setAction(null)}
              maxWidth={action === 'liquidity' ? 'max-w-3xl' : 'max-w-xl'}
            >
              {action === 'cashOut' ? (
                <CashOutPanel
                  chainId={chainId}
                  projectId={projectId}
                  showHeading={false}
                />
              ) : action === 'burn' ? (
                <BurnTokensFlow
                  chainId={chainId}
                  projectId={projectId}
                  tokenSymbol={collateralSymbol}
                  showHeading={false}
                />
              ) : action === 'loan' ? (
                <GetLoanFlow
                  chainId={chainId}
                  projectId={projectId}
                  collateralSymbol={collateralSymbol}
                />
              ) : action === 'move' ? (
                <MoveCard
                  chainId={chainId}
                  projectId={projectId}
                  chains={chains}
                />
              ) : (
                <AddLiquidityFlow
                  chainId={chainId}
                  projectId={projectId}
                  tokenSymbol={collateralSymbol}
                  framed={false}
                  showHeading={false}
                />
              )}
            </ModalShell>
          ) : null}
        </>
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
  /** What the full balance would reclaim from surplus right now, net of the
   *  protocol cash-out fee, or null when the project has no accounting
   *  context on this chain. */
  cashOutValue: bigint | null
  cashOutDecimals: number
  cashOutSymbol: string
  /** Minimum-fee proceeds from the currently-borrowable amount against the
   *  full balance (revnet only), in the accounting token's decimals; null when
   *  not a revnet or unreadable. 0 while the cash-out delay is active. */
  maxLoan: bigint | null
}

function YourChainRow({
  chainId,
  projectId,
  holder,
  isRevnet,
  tokenSymbol,
}: {
  chainId: JBChainId
  projectId: number
  holder: Address
  isRevnet: boolean
  tokenSymbol: string
}) {
  const publicClient = usePublicClient({ chainId }) as PublicClient | undefined

  const {
    data: position,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['yourPosition', chainId, projectId, holder, isRevnet],
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
      const [balance, credits, token, contexts, ruleset] = await Promise.all([
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
        getCurrentRuleset(client, {
          chainId,
          projectId: BigInt(projectId),
        }).catch(() => null),
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
      // right now, denominated in the primary accounting token and net of
      // the protocol's exact 2.5% cash-out fee (a non-zero tax rate fees
      // EVERY cash out; a zero tax rate fees only the fee-free surplus).
      const primary = contexts[0]
      let cashOutValue: bigint | null = null
      let cashOutSymbol = ''
      let cashOutDecimals = 18
      if (primary) {
        cashOutDecimals = primary.decimals
        cashOutSymbol = await readTokenSymbol(client, primary.token, {
          chainId,
        })
        const gross =
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
        // Unreadable ruleset or fee-free surplus assume the full fee, so
        // the shown value never overstates what a cash out would pay.
        const cashOutTaxRate = ruleset
          ? BigInt(ruleset.metadata.cashOutTaxRate)
          : null
        const feeFreeSurplus =
          gross > 0n && cashOutTaxRate === 0n
            ? await client
                .readContract({
                  abi: jbMultiTerminalAbi,
                  address: terminal,
                  functionName: 'feeFreeSurplusOf',
                  args: [BigInt(projectId), primary.token],
                })
                .catch(() => gross)
            : gross
        cashOutValue = netOfCashOutFee({
          gross,
          cashOutTaxRate: cashOutTaxRate ?? 1n,
          feeFreeSurplus,
        })
      }

      // Max loan: what the full balance can currently borrow against via
      // REVLoans, in the primary accounting token's terms. Revnet-only —
      // custom projects have no REVLoans, so it stays null ("—"). 0 while the
      // revnet's cash-out delay locks loans.
      let maxLoan: bigint | null = null
      if (isRevnet && primary && balance > 0n) {
        maxLoan = await getBorrowableAmount(client, {
          chainId,
          revnetId: BigInt(projectId),
          collateralCount: balance,
          decimals: BigInt(primary.decimals),
          currency: BigInt(primary.currency),
        })
          .then(r => netLoanProceeds(r.borrowableNow))
          .catch(() => null)
      }

      return {
        balance,
        credits,
        erc20Balance,
        token,
        cashOutValue,
        cashOutDecimals,
        cashOutSymbol,
        maxLoan,
      }
    },
  })

  return (
    <>
      <tr className="border-b border-smoke-100 last:border-0">
        <td className="whitespace-nowrap px-4 py-3">
          <span className="flex items-center gap-2 text-sm text-smoke-700">
            <ChainIcon chainId={chainId} size={16} />
            {chainName(chainId)}
          </span>
        </td>
        {isLoading ? (
          <>
            {Array.from({ length: 4 }, (_, index) => (
              <td key={index} className="px-4 py-3">
                <Skeleton className="ml-auto h-4 w-20 rounded" />
              </td>
            ))}
          </>
        ) : isError || !position ? (
          <td colSpan={4} className="px-4 py-3 text-right text-smoke-500">
            Couldn&apos;t load your position here.
          </td>
        ) : (
          <>
            <td className="whitespace-nowrap px-4 py-3 text-right align-top">
              <p className="font-medium text-ink">
                {formatTokenAmount(position.balance)} {tokenSymbol}
              </p>
              {position.token ? (
                <p className="mt-0.5 text-xs text-smoke-500">
                  {!isRevnet ? (
                    <>{formatTokenAmount(position.credits)} credits · </>
                  ) : null}
                  {formatTokenAmount(position.erc20Balance)} ERC-20
                </p>
              ) : !isRevnet && position.credits > 0n ? (
                <p className="mt-0.5 text-xs text-smoke-500">Credits only</p>
              ) : null}
            </td>
            <td className="whitespace-nowrap px-4 py-3 text-right align-top font-medium text-ink">
              {position.cashOutValue === null ? (
                '—'
              ) : (
                <>
                  ~
                  {formatTokenAmount(
                    position.cashOutValue,
                    position.cashOutDecimals,
                  )}{' '}
                  {position.cashOutSymbol}
                </>
              )}
            </td>
            <td className="whitespace-nowrap px-4 py-3 text-right align-top font-medium text-ink">
              {!isRevnet || position.maxLoan === null ? (
                '—'
              ) : position.maxLoan > 0n ? (
                <>
                  ~
                  {formatTokenAmount(
                    position.maxLoan,
                    position.cashOutDecimals,
                  )}{' '}
                  {position.cashOutSymbol}
                </>
              ) : (
                'Locked'
              )}
            </td>
            <td className="whitespace-nowrap px-4 py-3 text-right align-top text-smoke-700">
              <YourLpCell
                chainId={chainId}
                projectId={projectId}
                holder={holder}
                sym={tokenSymbol}
              />
            </td>
          </>
        )}
      </tr>
      {!isRevnet && position?.token && position.credits > 0n ? (
        <tr className="border-b border-smoke-100 last:border-0">
          <td colSpan={5} className="px-4 pb-3">
            <ClaimFlow
              chainId={chainId}
              projectId={projectId}
              holder={holder}
              credits={position.credits}
              onDone={refetch}
            />
          </td>
        </tr>
      ) : null}
    </>
  )
}

/**
 * The wallet's LP standing on one chain, in the You table: how many positions
 * it owns and what they have earned, opening the full panel to claim or exit.
 * Renders "—" where the chain has no pool or the wallet has no position.
 */
function YourLpCell({
  chainId,
  projectId,
  holder,
  sym,
}: {
  chainId: JBChainId
  projectId: number
  holder: Address
  sym: string
}) {
  const [open, setOpen] = useState(false)
  const summary = useUserLpSummary(chainId, projectId, holder)

  if (summary.isLoading) return <span className="text-smoke-500">…</span>
  // An incomplete log scan must not read as "you have no positions".
  if (summary.isError) {
    return (
      <span className="text-smoke-500" title="Could not verify the complete position history on this chain.">
        Unavailable
      </span>
    )
  }
  if (!summary.positions.length) return <>—</>

  const owed =
    summary.tokenFees > 0n || summary.pairFees > 0n
      ? `${formatTokenAmount(summary.tokenFees, 18)} ${sym} + ${formatTokenAmount(
          summary.pairFees,
          summary.pool?.pair.decimals ?? 18,
        )} ${summary.pool?.pair.symbol ?? ''} fees`
      : null

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-right underline decoration-dotted underline-offset-2 hover:text-ink"
      >
        {summary.positions.length}{' '}
        {summary.positions.length === 1 ? 'position' : 'positions'}
        {owed ? <span className="block text-xs text-smoke-500">{owed}</span> : null}
      </button>
      {open ? (
        <ModalShell
          title="Your liquidity"
          subtitle="Positions owned by this wallet in the project's market pool."
          onClose={() => setOpen(false)}
          maxWidth="max-w-xl"
        >
          <LiquidityPositions chainId={chainId} projectId={projectId} sym={sym} />
        </ModalShell>
      ) : null}
    </>
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

  const busy = checking || tx.busy

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
      <div className="callout callout-success mt-2 text-xs">
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
        <div className="callout callout-info text-xs">
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
          : txPhaseLabel(tx.phase, {
              pending: 'Claiming…',
              idle: review ? 'Confirm claim' : 'Claim as ERC-20',
            })}
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
      <TxError
        error={flowError ?? tx.error}
        className="mt-1.5 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700"
      />
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
  const [activeHolder, setActiveHolder] = useState<AggregatedHolder | null>(null)
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
    <div className="relative min-w-0 text-center">
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
            tabIndex={0}
            aria-label={`${holder.address}, ${formatTokenAmount(holder.balance)} ${tokenUnit}, ${holderPercentLabel(holder.balance, total)}`}
            onPointerEnter={() => setActiveHolder(holder)}
            onPointerLeave={() => setActiveHolder(null)}
            onFocus={() => setActiveHolder(holder)}
            onBlur={() => setActiveHolder(null)}
          >
            <title>
              <AddressText address={holder.address} /> —{' '}
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
      {activeHolder ? (
        <div
          role="tooltip"
          className="pointer-events-none absolute left-1/2 top-2 z-10 min-w-[180px] -translate-x-1/2 rounded-lg bg-ink px-3 py-2 text-left text-xs text-white shadow-lg"
        >
          <p className="font-medium">
            <AddressText address={activeHolder.address} />
          </p>
          <p className="mt-0.5 whitespace-nowrap text-white/80">
            {formatTokenAmount(activeHolder.balance)} {tokenUnit} ·{' '}
            {holderPercentLabel(activeHolder.balance, total)}
          </p>
        </div>
      ) : null}
      <p className="mt-1 text-xs text-smoke-500">
        Total: {compactTokenTotal(total)} {tokenUnit}
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
  const { data: projectToken } = useProjectTokenSymbol(chainId, projectId)
  const tokenUnit = projectToken?.symbol || 'tokens'

  const { data, isLoading, isError } = useQuery({
    queryKey: ['participants', suckerGroupId ?? `${chainId}:${projectId}`],
    staleTime: 60_000,
    retry: 1,
    queryFn: async () => {
      // chainId rides along on the suckerGroup branch as an endpoint-routing
      // hint (testnet groups live on the testnet indexer).
      const qs = suckerGroupId
        ? `suckerGroupId=${encodeURIComponent(suckerGroupId)}&chainId=${chainId}`
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
  const [requestedPage, setRequestedPage] = useState(0)
  const paginationRef = useRef<HTMLElement>(null)
  const { items: visibleHolders, page, pageCount } = ownerPageWindow(
    holders,
    requestedPage,
  )
  const goToPage = (nextPage: number) => {
    setRequestedPage(Math.max(0, Math.min(pageCount - 1, nextPage)))
    paginationRef.current?.scrollIntoView?.({ block: 'nearest' })
  }
  // All rows fetched = the aggregated count is the real holder count;
  // truncated = we only know it's at least that many.
  const exact = !!data && data.totalCount <= data.items.length
  const holderCount = exact ? String(holders.length) : `${holders.length}+`
  const holderCountLine = `${holderCount} ${
    holders.length === 1 && exact ? 'holder' : 'holders'
  }`

  return (
    <div className="card overflow-hidden p-5">
      <div>
        <span className="field-label">All</span>
        <p className="mt-2 text-sm leading-relaxed text-smoke-700">
          Token owners paid in, received splits, received auto-issuance, or got
          them second-hand.
        </p>
      </div>
      {isLoading ? (
        <HolderDistributionSkeleton rows={5} />
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
            <div className="min-w-0">
              <div className="overflow-x-auto rounded-xl border border-smoke-200">
                <div className="min-w-[520px]">
                  <div className="grid grid-cols-[minmax(150px,1.5fr)_80px_100px_90px] gap-3 bg-smoke-75 px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wide text-smoke-500">
                    <span>Account</span>
                    <span>Share</span>
                    <span>Chains</span>
                    <span>Paid</span>
                  </div>
                  <div className="divide-y divide-smoke-100">
                    {visibleHolders.map(holder => (
                      <div
                        key={holder.address}
                        className="grid grid-cols-[minmax(150px,1.5fr)_80px_100px_90px] items-center gap-3 px-4 py-3 text-sm"
                      >
                        <span className="min-w-0">
                          <AddressLink
                            address={holder.address}
                            host={etherscanHost}
                          />
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
                              standalone
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
              {pageCount > 1 ? (
                <nav
                  ref={paginationRef}
                  aria-label="Owners table pages"
                  className="mt-2.5 flex flex-wrap items-center justify-center gap-1.5"
                >
                  <OwnerPageButton
                    disabled={page === 0}
                    onClick={() => goToPage(0)}
                  >
                    « First
                  </OwnerPageButton>
                  <OwnerPageButton
                    disabled={page === 0}
                    onClick={() => goToPage(page - 1)}
                  >
                    ‹ Prev
                  </OwnerPageButton>
                  <span
                    aria-live="polite"
                    className="px-1 text-xs text-smoke-500"
                  >
                    {page + 1} / {pageCount}
                  </span>
                  <OwnerPageButton
                    disabled={page === pageCount - 1}
                    onClick={() => goToPage(page + 1)}
                  >
                    Next ›
                  </OwnerPageButton>
                  <OwnerPageButton
                    disabled={page === pageCount - 1}
                    onClick={() => goToPage(pageCount - 1)}
                  >
                    Last »
                  </OwnerPageButton>
                </nav>
              ) : null}
            </div>
          </div>
          <p className="mt-3 text-xs text-smoke-700">
            {holderCountLine} — ranked by balance, as shares of the balances
            tracked here
          </p>
        </>
      )}
    </div>
  )
}

function OwnerPageButton({
  children,
  disabled,
  onClick,
}: {
  children: ReactNode
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="px-2 py-1 text-xs text-smoke-500 transition-colors hover:text-bluebs-600 disabled:cursor-default disabled:opacity-35"
    >
      {children}
    </button>
  )
}

// --------------------------------------------- Reserved / Splits subtab --

/** A split's percentage of all issuance, not merely of the reserved group. */
function effectiveSplitPercent(
  splitPercent: number,
  reservedPercent: number,
): number {
  return (reservedPercent / 100) * (splitPercent / SPLITS_TOTAL_PERCENT)
}

/**
 * The ruleset id for one stage on one chain, from that chain's OWN ruleset
 * history. Ruleset ids are creation timestamps and differ per chain; the
 * stage ORDER is what omnichain deployments share, so the index over the
 * start-sorted list identifies the stage. Null when the chain has no such
 * stage — the caller renders an error state rather than another chain's id.
 */
export function stageRulesetIdOn(
  all: readonly JBRulesetWithMetadata[],
  stageIndex: number,
): number | null {
  const sorted = all.slice().sort((a, b) => a.ruleset.start - b.ruleset.start)
  return sorted[stageIndex]?.ruleset.id ?? null
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
    // Fall back to the latest stage that has already started.
    currentStageIndex = Math.max(
      0,
      stages.findLastIndex(stage => stage.ruleset.start <= now),
    )
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
    return <SplitsCardSkeleton isRevnet={isRevnet} />
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
    <div className="card overflow-hidden p-5">
      <div>
        <span className="field-label">
          {isRevnet ? 'Splits' : 'Reserved tokens'}
        </span>
        <p className="mt-2 text-sm leading-relaxed text-smoke-700">
          A share of every batch of new tokens is set aside for the recipients
          below.
        </p>
      </div>
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
          {fmtPct(reservedPercent / 100)}
        </span>{' '}
        of issuance.
      </p>

      {splitsLoading ? (
        <SkeletonTable rows={4} columns={3} className="mt-5" />
      ) : splitsError ? (
        <p className="mt-4 text-sm text-smoke-700">
          Couldn’t read splits for this stage.
        </p>
      ) : rows.length === 0 && chains.length <= 1 ? (
        <p className="mt-4 text-sm text-smoke-700">
          {isRevnet
            ? 'No splits are configured for this stage — split tokens go to the revnet owner.'
            : 'No reserved recipients are configured — reserved tokens go to the project owner.'}
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <div className="min-w-[600px]">
            <div className="grid grid-cols-[minmax(150px,0.75fr)_minmax(190px,1fr)_minmax(180px,0.9fr)] gap-4 border-y border-smoke-200 px-3 py-2 text-xs text-smoke-500">
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
                  // Splits live per chain under per-chain ruleset ids; the
                  // route chain's rows are only that chain's truth. Peers
                  // read their own (homeRows fast path for the route chain).
                  homeRows={cid === chainId ? rows : null}
                  stageIndex={activeStageIndex}
                  isRevnet={isRevnet}
                  reservedPercent={reservedPercent}
                  isCurrentStage={isCurrentStage}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {isRevnet && isCurrentStage && rulesetId > 0 ? (
        <EditSplitsFlow
          chainId={chainId}
          projectId={projectId}
          groupId={RESERVED_TOKEN_SPLIT_GROUP_ID}
          title="Splits"
          rulesetId={BigInt(rulesetId)}
          isRevnet
        />
      ) : null}
    </div>
  )
}

/** One inline chain table, with that chain's pending balance and action.
 *  Splits are read from THIS chain's JBSplits under THIS chain's ruleset id
 *  for the stage — ruleset ids differ per chain, and split edits land per
 *  chain, so rendering the route chain's rows here would misreport peers.
 *  The route chain passes its already-read rows through `homeRows`. */
function ChainSplitsBlock({
  chainId,
  projectId,
  homeRows,
  stageIndex,
  isRevnet,
  reservedPercent,
  isCurrentStage,
}: {
  chainId: JBChainId
  projectId: number
  /** The route chain's already-read rows (fast path), null for peer chains. */
  homeRows: readonly SplitRow[] | null
  stageIndex: number
  isRevnet: boolean
  reservedPercent: number
  isCurrentStage: boolean
}) {
  const publicClient = usePublicClient({ chainId }) as PublicClient | undefined
  const directoryAddress = jbContractAddress['6'][JBCoreContracts.JBDirectory][
    chainId
  ] as Address

  const { data: controller } = useReadContract({
    abi: jbDirectoryAbi,
    address: directoryAddress,
    functionName: 'controllerOf',
    args: [BigInt(projectId)],
    chainId,
    query: { staleTime: 60_000 },
  })

  const {
    data: chainRows,
    isLoading: chainRowsLoading,
    isError: chainRowsError,
  } = useQuery({
    queryKey: ['chainStageSplits', chainId, projectId, stageIndex, isCurrentStage],
    enabled: homeRows === null && !!publicClient,
    staleTime: 60_000,
    retry: 1,
    queryFn: async (): Promise<readonly SplitRow[]> => {
      const args = { chainId, projectId: BigInt(projectId) }
      // The current stage uses this chain's own currentRulesetOf (it also
      // absorbs cycle rollover); a browsed stage is matched by start order.
      const rid = isCurrentStage
        ? (await getCurrentRuleset(publicClient!, args)).ruleset.id
        : stageRulesetIdOn(
            await getAllRulesets(publicClient!, { ...args, size: 50n }),
            stageIndex,
          )
      if (rid == null) {
        throw new Error('This stage does not exist on this chain.')
      }
      return (await publicClient!.readContract({
        address: jbContractAddress['6'][JBCoreContracts.JBSplits][
          chainId
        ] as Address,
        abi: jbSplitsAbi,
        functionName: 'splitsOf',
        args: [BigInt(projectId), BigInt(rid), RESERVED_TOKEN_SPLIT_GROUP_ID],
      })) as readonly SplitRow[]
    },
  })

  const rows = homeRows ?? chainRows ?? []

  const { data: projectToken } = useProjectTokenSymbol(chainId, projectId)
  const symbol = projectToken?.symbol || 'tokens'

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

  if (homeRows === null && chainRowsLoading) {
    return (
      <section>
        <div className="flex items-center gap-2 text-sm font-medium text-smoke-700">
          <ChainIcon chainId={chainId} size={18} />
          <span>{chainName(chainId)}</span>
        </div>
        <SkeletonTable rows={2} columns={3} className="mt-2" />
      </section>
    )
  }

  if (homeRows === null && chainRowsError) {
    return (
      <section>
        <div className="flex items-center gap-2 text-sm font-medium text-smoke-700">
          <ChainIcon chainId={chainId} size={18} />
          <span>{chainName(chainId)}</span>
        </div>
        <p className="mt-2 text-sm text-smoke-700">
          Couldn’t read this stage’s splits on this chain right now.
        </p>
      </section>
    )
  }

  return (
    <section>
      <div className="flex items-center gap-2 text-sm font-medium text-smoke-700">
        <ChainIcon chainId={chainId} size={18} />
        <span>{chainName(chainId)}</span>
      </div>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-smoke-700">
          {isRevnet
            ? 'No splits are configured for this stage on this chain — split tokens go to the revnet owner.'
            : 'No reserved recipients are configured on this chain — reserved tokens go to the project owner.'}
        </p>
      ) : (
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
              className="grid grid-cols-[minmax(150px,0.75fr)_minmax(190px,1fr)_minmax(180px,0.9fr)] items-center gap-4 border-b border-smoke-100 px-3 py-3 text-sm last:border-b-0"
            >
              <span>
                <SplitRecipient split={split} chainId={chainId} showBurn />
              </span>
              <span>
                <strong className="font-medium text-ink">
                  {fmtPct(
                    effectiveSplitPercent(split.percent, reservedPercent),
                  )}
                </strong>
                <span className="text-smoke-500">
                  {' '}
                  ({fmtPct(fraction * 100)} of limit)
                </span>
              </span>
              <span className="text-ink">
                {pendingLoading && isCurrentStage
                  ? <Skeleton className="inline-block h-4 w-20 rounded align-middle" />
                  : recipientPending > 0n
                    ? `${formatTokenAmount(recipientPending)} ${symbol}`
                    : '—'}
              </span>
            </div>
          )
        })}
      </div>
      )}
      <div className="flex justify-end">
        <DistributeFlow
          chainId={chainId}
          projectId={projectId}
          controller={controller}
          pending={availablePending}
          onDone={() => void refetchPending()}
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
  onDone,
}: {
  chainId: JBChainId
  projectId: number
  controller: Address | undefined
  pending: bigint | undefined
  onDone: () => void
}) {
  const { isConnected, openSignIn } = useWallet()
  const tx = useSafeTx(chainId)

  const busy = tx.busy

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
    tx.send(
      buildSendReservedTokensRequest({
        chainId,
        controller,
        projectId: BigInt(projectId),
      }),
    )
  }

  return (
    <div className="mt-2 flex flex-col items-end">
      <button
        onClick={handleDistribute}
        disabled={busy || !controller || !pending || pending <= 0n}
        className="btn-secondary min-h-[40px] px-4 text-sm"
      >
        {tx.phase === 'success'
          ? 'Distributed'
          : txPhaseLabel(tx.phase, {
              pending: 'Distributing…',
              idle: 'Distribute',
            })}
      </button>
      {tx.phase === 'success' ? (
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
      <TxError
        error={tx.error}
        className="mt-1.5 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700"
      />
    </div>
  )
}
