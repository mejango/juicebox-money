'use client'

import {
  JB_CHAINS,
  JBCoreContracts,
  NATIVE_TOKEN,
  jbContractAddress,
  jbTokensAbi,
  revLoansAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import {
  buildBorrowTx,
  buildRepayLoanTx,
  buildSetPermissionsTx,
  getAccountingContexts,
  getBorrowableAmount,
  getCashOutDelay,
  getTokenAddress,
  hasPermissions,
  JBPermissionIdsV6,
  type JBAccountingContext,
} from '@bananapus/nana-sdk-core/v6'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import {
  erc20Abi,
  formatUnits,
  parseUnits,
  type Address,
  type PublicClient,
} from 'viem'
import { usePublicClient, useReadContract } from 'wagmi'
import { useSafeTx } from '@/hooks/useSafeTx'
import { useWallet } from '@/hooks/useWallet'
import { formatDate, formatTokenAmount, truncateAddress } from '@/lib/format'
import type { BsLoan } from '@/lib/loans-queries'

const BURN_TOKENS = JBPermissionIdsV6.BURN_TOKENS

/** Prepaid-fee choices, out of 1000. Prepaying more buys more fee-free time
 *  before the repayment cost starts to grow (see the SDK MIN_PREPAID_FEE_PERCENT
 *  docstring). 25 (2.5%) is the on-chain minimum — 0 reverts. */
const PREPAID_OPTIONS = [
  { value: 25, label: '2.5%' },
  { value: 50, label: '5%' },
  { value: 100, label: '10%' },
] as const

function revLoansAddress(chainId: JBChainId): Address {
  return jbContractAddress['6']['REVLoans'][chainId] as Address
}

/** The loan's source-token symbol/decimals, looked up from the revnet's own
 *  accounting contexts (a loan can only be denominated in one of them). */
function tokenMeta(
  contexts: readonly JBAccountingContext[],
  token: string,
  chainId: JBChainId,
): { symbol: string; decimals: number } {
  const ctx = contexts.find(
    c => c.token.toLowerCase() === token.toLowerCase(),
  )
  const isNative = token.toLowerCase() === NATIVE_TOKEN.toLowerCase()
  if (isNative) {
    return {
      symbol: JB_CHAINS[chainId]?.nativeTokenSymbol ?? 'ETH',
      decimals: ctx?.decimals ?? 18,
    }
  }
  return { symbol: truncateAddress(token), decimals: ctx?.decimals ?? 18 }
}

/**
 * The Loans subtab (revnet only, website/ parity): open a loan against your
 * revnet tokens (REVLoans.borrowFrom, tx #8), repay one to reclaim your
 * collateral (REVLoans.repayLoan, tx #9), plus the project's loan book. Every
 * write re-reads authoritative on-chain state and goes through useSafeTx
 * (simulate-first). Loans are locked while a revnet's cash-out delay is
 * active — borrowable reads 0 then, and the flows abort rather than send.
 */
export function LoansSection({
  chainId,
  projectId,
}: {
  chainId: JBChainId
  projectId: number
}) {
  const publicClient = usePublicClient({ chainId }) as PublicClient | undefined

  const { data: contexts, isLoading: contextsLoading } = useQuery({
    queryKey: ['accountingContexts', chainId, projectId],
    enabled: !!publicClient,
    staleTime: 60_000,
    retry: 1,
    queryFn: () =>
      getAccountingContexts(publicClient!, {
        chainId,
        projectId: BigInt(projectId),
      }),
  })

  // The project token symbol, for the collateral copy.
  const { data: collateralToken } = useQuery({
    queryKey: ['projectToken', chainId, projectId],
    enabled: !!publicClient,
    staleTime: 5 * 60_000,
    retry: 1,
    queryFn: () =>
      getTokenAddress(publicClient!, { chainId, projectId: BigInt(projectId) }),
  })
  const { data: collateralSymbolRaw } = useReadContract({
    abi: erc20Abi,
    address: collateralToken ?? undefined,
    functionName: 'symbol',
    chainId,
    query: { enabled: !!collateralToken, staleTime: 5 * 60_000 },
  })
  const collateralSymbol = collateralSymbolRaw ?? 'tokens'

  return (
    <div className="space-y-5">
      <GetLoanCard
        chainId={chainId}
        projectId={projectId}
        contexts={contexts ?? []}
        contextsLoading={contextsLoading}
        collateralSymbol={collateralSymbol}
      />
      <LoansTables
        chainId={chainId}
        projectId={projectId}
        contexts={contexts ?? []}
        collateralSymbol={collateralSymbol}
      />
    </div>
  )
}

// ------------------------------------------------------------ Get a loan --

/** A reviewed borrow: the inputs are frozen so what the user confirms is what
 *  gets sent (the min is re-quoted fresh at submit). */
type ReviewedBorrow = {
  collateral: bigint
  prepaid: number
  /** The borrowable quote shown at review time, in the token's decimals. */
  quote: bigint
  ctxToken: Address
  account: Address
}

function GetLoanCard({
  chainId,
  projectId,
  contexts,
  contextsLoading,
  collateralSymbol,
}: {
  chainId: JBChainId
  projectId: number
  contexts: readonly JBAccountingContext[]
  contextsLoading: boolean
  collateralSymbol: string
}) {
  const publicClient = usePublicClient({ chainId }) as PublicClient | undefined
  const { isConnected, address, openSignIn } = useWallet()

  // Wallet state is client-only; keep SSR + first client render identical.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const [amount, setAmount] = useState('')
  const [ctxToken, setCtxToken] = useState<Address | null>(null)
  const [prepaid, setPrepaid] = useState<number>(PREPAID_OPTIONS[0].value)
  const [review, setReview] = useState<ReviewedBorrow | null>(null)
  const [flowError, setFlowError] = useState<string | null>(null)
  const [quoting, setQuoting] = useState(false)
  const [awaitingBorrow, setAwaitingBorrow] = useState(false)

  const permTx = useSafeTx(chainId)
  const borrowTx = useSafeTx(chainId)

  const ctx =
    contexts.find(c => c.token === ctxToken) ?? contexts[0] ?? undefined
  const meta = ctx
    ? tokenMeta(contexts, ctx.token, chainId)
    : { symbol: 'ETH', decimals: 18 }

  const collateral = useMemo(() => {
    try {
      const t = amount.trim()
      if (!t || !Number.isFinite(Number(t)) || Number(t) <= 0) return 0n
      return parseUnits(t, 18)
    } catch {
      return 0n
    }
  }, [amount])

  // The holder's token balance, to cap the collateral input.
  const { data: balance } = useReadContract({
    abi: jbTokensAbi,
    address: jbContractAddress['6'][JBCoreContracts.JBTokens][chainId] as Address,
    functionName: 'totalBalanceOf',
    args: address ? [address, BigInt(projectId)] : undefined,
    chainId,
    query: { enabled: !!address, staleTime: 30_000 },
  })

  // The cash-out delay, so we can say WHY loans are locked when they are.
  const { data: cashOutDelay } = useQuery({
    queryKey: ['cashOutDelay', chainId, projectId],
    enabled: !!publicClient,
    staleTime: 60_000,
    retry: 1,
    queryFn: () =>
      getCashOutDelay(publicClient!, { chainId, revnetId: BigInt(projectId) }),
  })
  const nowSec = Math.floor(Date.now() / 1000)
  const delayActive = !!cashOutDelay && cashOutDelay > BigInt(nowSec)

  // Live "you can borrow up to X" for the entered collateral.
  const { data: borrowable, isFetching: borrowableFetching } = useQuery({
    queryKey: [
      'borrowable',
      chainId,
      projectId,
      ctx?.token,
      collateral.toString(),
    ],
    enabled: !!publicClient && !!ctx && collateral > 0n,
    staleTime: 15_000,
    retry: 1,
    queryFn: () =>
      getBorrowableAmount(publicClient!, {
        chainId,
        revnetId: BigInt(projectId),
        collateralCount: collateral,
        decimals: BigInt(ctx!.decimals),
        currency: BigInt(ctx!.currency),
      }),
  })
  const borrowableNow = borrowable?.borrowableNow

  const chainMeta = JB_CHAINS[chainId]
  const busy =
    quoting ||
    permTx.phase === 'simulating' ||
    permTx.phase === 'signing' ||
    permTx.phase === 'pending' ||
    borrowTx.phase === 'simulating' ||
    borrowTx.phase === 'signing' ||
    borrowTx.phase === 'pending'

  const resetInputs = () => {
    setReview(null)
    setFlowError(null)
  }

  // Send the borrow once permission is in place — always re-quoting the min
  // against a FRESH borrowable read so a stale review can't underprice it.
  const sendBorrow = async (r: ReviewedBorrow) => {
    if (!publicClient || !ctx) return
    setQuoting(true)
    try {
      const fresh = await getBorrowableAmount(publicClient, {
        chainId,
        revnetId: BigInt(projectId),
        collateralCount: r.collateral,
        decimals: BigInt(ctx.decimals),
        currency: BigInt(ctx.currency),
      })
      if (fresh.borrowableNow <= 0n) {
        throw new Error(
          'Loans are locked until this revnet’s cash-out delay passes — nothing was sent.',
        )
      }
      const minBorrow = (fresh.borrowableNow * 99n) / 100n
      const request = buildBorrowTx({
        chainId,
        revnetId: BigInt(projectId),
        token: r.ctxToken,
        minBorrowAmount: minBorrow,
        collateralCount: r.collateral,
        beneficiary: r.account,
        prepaidFeePercent: BigInt(r.prepaid),
        holder: r.account,
      })
      await borrowTx.send(request)
    } catch (e) {
      setFlowError(e instanceof Error ? e.message : 'Something went wrong.')
    } finally {
      setQuoting(false)
    }
  }

  // Step machine: check the collateral-burn permission, granting it first when
  // missing (step 1 of 2), then borrow.
  const beginBorrow = async (r: ReviewedBorrow) => {
    if (!publicClient) return
    setFlowError(null)
    setQuoting(true)
    try {
      const has = await hasPermissions(publicClient, {
        chainId,
        operator: revLoansAddress(chainId),
        account: r.account,
        projectId: BigInt(projectId),
        permissionIds: [BURN_TOKENS],
      })
      if (has) {
        setQuoting(false)
        await sendBorrow(r)
        return
      }
      // Grant BURN_TOKENS to REVLoans so it can burn the collateral, then borrow.
      const permReq = buildSetPermissionsTx({
        chainId,
        account: r.account,
        operator: revLoansAddress(chainId),
        projectId: BigInt(projectId),
        permissionIds: [BURN_TOKENS],
      })
      setAwaitingBorrow(true)
      setQuoting(false)
      await permTx.send(permReq)
    } catch (e) {
      setFlowError(e instanceof Error ? e.message : 'Something went wrong.')
      setQuoting(false)
    }
  }

  // Once the approval lands, continue to the borrow (fresh min re-quoted).
  useEffect(() => {
    if (permTx.phase === 'success' && awaitingBorrow && review) {
      setAwaitingBorrow(false)
      sendBorrow(review)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permTx.phase])

  const handleReview = async () => {
    if (!isConnected || !address) {
      openSignIn()
      return
    }
    if (!publicClient || !ctx || collateral <= 0n || busy) return
    setFlowError(null)
    setQuoting(true)
    try {
      if (balance !== undefined && collateral > balance) {
        throw new Error('That’s more than your token balance on this chain.')
      }
      const fresh = await getBorrowableAmount(publicClient, {
        chainId,
        revnetId: BigInt(projectId),
        collateralCount: collateral,
        decimals: BigInt(ctx.decimals),
        currency: BigInt(ctx.currency),
      })
      if (fresh.borrowableNow <= 0n) {
        throw new Error(
          'Loans are locked until this revnet’s cash-out delay passes.',
        )
      }
      setReview({
        collateral,
        prepaid,
        quote: fresh.borrowableNow,
        ctxToken: ctx.token,
        account: address,
      })
    } catch (e) {
      setFlowError(e instanceof Error ? e.message : 'Something went wrong.')
    } finally {
      setQuoting(false)
    }
  }

  const handleConfirm = () => {
    if (!review || busy) return
    // Account-unchanged recheck: the frozen args borrow FOR this holder.
    if (address?.toLowerCase() !== review.account.toLowerCase()) {
      setReview(null)
      setFlowError('Your connected account changed — review the loan again.')
      return
    }
    beginBorrow(review)
  }

  const borrowTxUrl = borrowTx.hash
    ? `https://${chainMeta?.etherscanHostname}/tx/${borrowTx.hash}`
    : null

  if (borrowTx.phase === 'success') {
    return (
      <div className="card p-5">
        <span className="field-label">Get a loan</span>
        <div className="mt-3 rounded-xl border border-smoke-200 p-4">
          <p className="text-sm font-medium text-ink">
            Loan opened — the funds are in your wallet, and your collateral is
            held until you repay.
          </p>
          <div className="mt-2 flex gap-3 text-sm font-semibold">
            {borrowTxUrl ? (
              <a
                href={borrowTxUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-bluebs-600 underline underline-offset-2 hover:text-bluebs-700"
              >
                View transaction
              </a>
            ) : null}
            <button
              onClick={() => {
                setAmount('')
                resetInputs()
                permTx.reset()
                borrowTx.reset()
              }}
              className="text-smoke-700 hover:text-ink"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="card p-5">
      <span className="field-label">Get a loan</span>
      <p className="mt-2 text-sm leading-relaxed text-smoke-700">
        Borrow against your {collateralSymbol} without selling. Your tokens are
        held as collateral and returned when you repay.
      </p>

      {contextsLoading ? (
        <p className="mt-3 text-sm text-smoke-500">Loading…</p>
      ) : contexts.length === 0 ? (
        <p className="mt-3 text-sm leading-relaxed text-smoke-700">
          This revnet doesn’t accept a token to borrow on this chain.
        </p>
      ) : delayActive ? (
        <p className="mt-3 rounded-lg bg-split-50 px-3.5 py-2.5 text-xs leading-relaxed text-smoke-900">
          Loans are locked until this revnet’s cash-out delay passes
          {cashOutDelay ? ` (${formatDate(Number(cashOutDelay))})` : ''}.
        </p>
      ) : (
        <div className="mt-4 space-y-4">
          <label className="block">
            <span className="field-label">Collateral</span>
            <div className="input-well mt-1.5 flex items-center px-4">
              <input
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={amount}
                onChange={e => {
                  setAmount(e.target.value)
                  resetInputs()
                }}
                placeholder="0"
                disabled={busy}
                aria-label={`Collateral in ${collateralSymbol}`}
                className="min-h-[44px] w-full bg-transparent text-lg font-medium outline-none placeholder:text-smoke-500 disabled:cursor-not-allowed"
              />
              <span className="ml-2 shrink-0 text-sm font-medium text-smoke-700">
                {collateralSymbol}
              </span>
              {mounted && balance !== undefined ? (
                <button
                  onClick={() => {
                    setAmount(formatUnits(balance, 18))
                    resetInputs()
                  }}
                  disabled={busy}
                  className="btn-secondary ml-3 px-2.5 py-0.5 text-[11px]"
                >
                  MAX
                </button>
              ) : null}
            </div>
            {mounted && balance !== undefined ? (
              <span className="mt-1 block text-xs text-smoke-700">
                You hold {formatTokenAmount(balance)} {collateralSymbol} here.
              </span>
            ) : null}
          </label>

          {contexts.length > 1 ? (
            <label className="block">
              <span className="field-label">Borrow token</span>
              <select
                value={ctx?.token}
                disabled={busy}
                onChange={e => {
                  setCtxToken(e.target.value as Address)
                  resetInputs()
                }}
                className="input-well mt-1.5 min-h-[40px] w-full px-3 text-sm"
              >
                {contexts.map(c => (
                  <option key={c.token} value={c.token}>
                    {tokenMeta(contexts, c.token, chainId).symbol}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {collateral > 0n ? (
            <p className="text-xs text-smoke-700">
              {borrowableFetching
                ? 'Checking how much you can borrow…'
                : borrowableNow === undefined
                  ? 'Could not read the live loan quote — try again shortly.'
                  : borrowableNow > 0n
                    ? `You can borrow up to ~${formatTokenAmount(borrowableNow, meta.decimals)} ${meta.symbol}.`
                    : 'Loans are locked until this revnet’s cash-out delay passes.'}
            </p>
          ) : null}

          <label className="block">
            <span className="field-label">Prepaid fee</span>
            <select
              value={prepaid}
              disabled={busy}
              onChange={e => {
                setPrepaid(Number(e.target.value))
                resetInputs()
              }}
              className="input-well mt-1.5 min-h-[40px] w-full px-3 text-sm"
            >
              {PREPAID_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-xs text-smoke-700">
              Paid upfront when the loan opens. Prepaying more buys more fee-free
              time before the repayment cost starts to grow.
            </span>
          </label>

          {review ? (
            <div className="rounded-lg bg-split-50 px-3.5 py-2.5 text-xs leading-relaxed text-smoke-900">
              <p>
                Borrowing ~{formatTokenAmount(review.quote, meta.decimals)}{' '}
                {meta.symbol} against {formatTokenAmount(review.collateral)}{' '}
                {collateralSymbol}.
              </p>
              <p className="mt-1">
                A 2.5% protocol fee, a 1% revnet fee, and your{' '}
                {(review.prepaid / 10).toString()}% prepaid fee come out of the
                loan. At least 99% of the live quote must be borrowed or the
                transaction reverts.
              </p>
              <p className="mt-1 text-smoke-700">
                Your {collateralSymbol} is held as collateral and returned when
                you repay. Unrepaid loans are liquidated after 10 years. A
                first-time loan needs a one-off approval first.
              </p>
            </div>
          ) : null}

          <button
            onClick={review ? handleConfirm : handleReview}
            disabled={busy || (isConnected && collateral <= 0n)}
            className="btn-primary min-h-[44px] w-full text-sm"
          >
            {quoting
              ? 'Checking the live quote…'
              : permTx.phase === 'simulating' || permTx.phase === 'signing'
                ? 'Step 1 of 2 — approve in your wallet…'
                : permTx.phase === 'pending'
                  ? 'Step 1 of 2 — approving…'
                  : borrowTx.phase === 'simulating'
                    ? 'Double-checking the transaction…'
                    : borrowTx.phase === 'signing'
                      ? 'Confirm the loan in your wallet…'
                      : borrowTx.phase === 'pending'
                        ? 'Opening your loan…'
                        : !isConnected
                          ? 'Sign in to continue'
                          : review
                            ? 'Confirm loan'
                            : 'Review'}
          </button>

          {flowError || permTx.error || borrowTx.error ? (
            <p className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
              {flowError ?? permTx.error ?? borrowTx.error}
            </p>
          ) : null}
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------- loan book --

function LoansTables({
  chainId,
  projectId,
  contexts,
  collateralSymbol,
}: {
  chainId: JBChainId
  projectId: number
  contexts: readonly JBAccountingContext[]
  collateralSymbol: string
}) {
  const { address } = useWallet()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['loans', chainId, projectId],
    staleTime: 30_000,
    retry: 1,
    queryFn: async () => {
      const res = await fetch(
        `/api/loans?projectId=${projectId}&chainIds=${chainId}`,
      )
      if (!res.ok) throw new Error('Loan data unavailable')
      return (await res.json()) as { items: BsLoan[]; totalCount: number }
    },
  })

  const loans = data?.items ?? []
  const yourLoans =
    mounted && address
      ? loans.filter(l => l.owner.toLowerCase() === address.toLowerCase())
      : []

  return (
    <>
      {mounted && address && yourLoans.length > 0 ? (
        <div className="card p-5">
          <span className="field-label">Your loans</span>
          <LoanTable
            chainId={chainId}
            projectId={projectId}
            loans={yourLoans}
            contexts={contexts}
            collateralSymbol={collateralSymbol}
            holder={address}
            onRepaid={refetch}
          />
        </div>
      ) : null}

      <div className="card p-5">
        <span className="field-label">All loans</span>
        {isLoading ? (
          <p className="mt-2 text-sm text-smoke-500">Loading…</p>
        ) : isError ? (
          <p className="mt-2 text-sm text-smoke-700">
            Loan data is unavailable right now.
          </p>
        ) : loans.length === 0 ? (
          <p className="mt-2 text-sm leading-relaxed text-smoke-700">
            No one has taken a loan against this revnet yet.
          </p>
        ) : (
          <LoanTable
            chainId={chainId}
            projectId={projectId}
            loans={loans}
            contexts={contexts}
            collateralSymbol={collateralSymbol}
          />
        )}
      </div>
    </>
  )
}

function LoanTable({
  chainId,
  projectId,
  loans,
  contexts,
  collateralSymbol,
  holder,
  onRepaid,
}: {
  chainId: JBChainId
  projectId: number
  loans: BsLoan[]
  contexts: readonly JBAccountingContext[]
  collateralSymbol: string
  /** When set, a Repay column is shown (the connected holder's own loans). */
  holder?: Address
  onRepaid?: () => void
}) {
  const etherscanHost = JB_CHAINS[chainId]?.etherscanHostname
  return (
    <div className="mt-2 overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-smoke-500">
            <th className="pb-1.5 font-normal">Borrowed</th>
            <th className="pb-1.5 text-right font-normal">Collateral</th>
            <th className="pb-1.5 text-right font-normal">Prepaid fee</th>
            <th className="pb-1.5 text-right font-normal">Opened</th>
            {holder ? <th className="pb-1.5 text-right font-normal" /> : null}
          </tr>
        </thead>
        <tbody className="text-ink">
          {loans.map(loan => {
            const meta = tokenMeta(contexts, loan.token, chainId)
            const isNative =
              loan.token.toLowerCase() === NATIVE_TOKEN.toLowerCase()
            return (
              <tr key={loan.id} className="border-t border-smoke-100">
                <td className="py-1.5 pr-3">
                  {etherscanHost && !isNative ? (
                    <a
                      href={`https://${etherscanHost}/token/${loan.token}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-ink hover:underline"
                    >
                      {formatTokenAmount(loan.borrowAmount, meta.decimals)}{' '}
                      {meta.symbol}
                    </a>
                  ) : (
                    `${formatTokenAmount(loan.borrowAmount, meta.decimals)} ${meta.symbol}`
                  )}
                </td>
                <td className="py-1.5 text-right">
                  {formatTokenAmount(loan.collateral)} {collateralSymbol}
                </td>
                <td className="py-1.5 text-right">
                  {(loan.prepaidFeePercent / 10).toString()}%
                </td>
                <td className="py-1.5 text-right text-smoke-700">
                  {formatDate(loan.createdAt)}
                </td>
                {holder ? (
                  <td className="py-1.5 text-right">
                    <RepayFlow
                      chainId={chainId}
                      projectId={projectId}
                      loan={loan}
                      contexts={contexts}
                      collateralSymbol={collateralSymbol}
                      holder={holder}
                      onRepaid={onRepaid}
                    />
                  </td>
                ) : null}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ---------------------------------------------------------------- repay --

/** The on-chain REVLoan struct returned by loanOf. */
type OnChainLoan = {
  amount: bigint
  collateral: bigint
  createdAt: number
  prepaidFeePercent: number
  prepaidDuration: number
  sourceToken: Address
}

function RepayFlow({
  chainId,
  projectId,
  loan,
  contexts,
  collateralSymbol,
  holder,
  onRepaid,
}: {
  chainId: JBChainId
  projectId: number
  loan: BsLoan
  contexts: readonly JBAccountingContext[]
  collateralSymbol: string
  holder: Address
  onRepaid?: () => void
}) {
  const publicClient = usePublicClient({ chainId }) as PublicClient | undefined
  const { address } = useWallet()
  const approveTx = useSafeTx(chainId)
  const repayTx = useSafeTx(chainId)

  const [open, setOpen] = useState(false)
  const [checking, setChecking] = useState(false)
  const [flowError, setFlowError] = useState<string | null>(null)
  const [pendingRepay, setPendingRepay] = useState<{
    chainId: JBChainId
    address: Address
    abi: typeof revLoansAbi
    functionName: 'repayLoan'
    args: readonly unknown[]
    value: bigint
  } | null>(null)

  const loans = revLoansAddress(chainId)
  const meta = tokenMeta(contexts, loan.token, chainId)

  const busy =
    checking ||
    approveTx.phase === 'simulating' ||
    approveTx.phase === 'signing' ||
    approveTx.phase === 'pending' ||
    repayTx.phase === 'simulating' ||
    repayTx.phase === 'signing' ||
    repayTx.phase === 'pending'

  const chainMeta = JB_CHAINS[chainId]
  const repayTxUrl = repayTx.hash
    ? `https://${chainMeta?.etherscanHostname}/tx/${repayTx.hash}`
    : null

  useEffect(() => {
    if (repayTx.phase === 'success') onRepaid?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repayTx.phase])

  // Once the ERC-20 approval lands, send the repayment held in state.
  useEffect(() => {
    if (approveTx.phase === 'success' && pendingRepay) {
      const req = pendingRepay
      setPendingRepay(null)
      repayTx.send(req)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approveTx.phase])

  const handleRepay = async () => {
    if (!publicClient || busy) return
    if (address?.toLowerCase() !== holder.toLowerCase()) {
      setFlowError('Your connected account changed — reopen the loan to repay.')
      return
    }
    setFlowError(null)
    setChecking(true)
    try {
      // Re-read the loan itself: a partial repayment replaces the loan id, so
      // the indexer row could be stale.
      const fresh = (await publicClient.readContract({
        abi: revLoansAbi,
        address: loans,
        functionName: 'loanOf',
        args: [BigInt(loan.id)],
      })) as OnChainLoan
      if (fresh.createdAt === 0 || fresh.amount === 0n) {
        throw new Error(
          'This loan is no longer open. Refresh the project and try again.',
        )
      }
      const fee = (await publicClient.readContract({
        abi: revLoansAbi,
        address: loans,
        functionName: 'determineSourceFeeAmount',
        args: [fresh, fresh.amount],
      })) as bigint
      // maxRepay caps the repayment; a small fee/50 buffer covers the
      // per-second drift of the source fee between now and inclusion. Excess
      // is refunded by REVLoans.
      const maxRepay = fresh.amount + fee + fee / 50n
      const isNative =
        fresh.sourceToken.toLowerCase() === NATIVE_TOKEN.toLowerCase()

      const request = buildRepayLoanTx({
        chainId,
        loanId: BigInt(loan.id),
        maxRepayBorrowAmount: maxRepay,
        collateralCountToReturn: fresh.collateral,
        beneficiary: holder,
        value: isNative ? maxRepay : 0n,
      })

      if (isNative) {
        await repayTx.send(request)
        return
      }

      // ERC-20 source: approve REVLoans for the cap first (its own reviewed
      // step), then repay. Skip when the allowance already covers it.
      const allowance = (await publicClient.readContract({
        abi: erc20Abi,
        address: fresh.sourceToken,
        functionName: 'allowance',
        args: [holder, loans],
      })) as bigint
      if (allowance >= maxRepay) {
        await repayTx.send(request)
        return
      }
      setPendingRepay(request)
      await approveTx.send({
        chainId,
        address: fresh.sourceToken,
        abi: erc20Abi,
        functionName: 'approve',
        args: [loans, maxRepay],
      })
    } catch (e) {
      setFlowError(e instanceof Error ? e.message : 'Something went wrong.')
    } finally {
      setChecking(false)
    }
  }

  if (repayTx.phase === 'success') {
    return (
      <span className="text-xs text-smoke-700">
        Repaid
        {repayTxUrl ? (
          <>
            {' — '}
            <a
              href={repayTxUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-bluebs-600 underline underline-offset-2 hover:text-bluebs-700"
            >
              view
            </a>
          </>
        ) : null}
      </span>
    )
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="btn-secondary min-h-[32px] px-3 text-xs"
      >
        Repay
      </button>
    )
  }

  return (
    <div className="text-left">
      <p className="text-xs leading-relaxed text-smoke-700">
        Repays the principal plus the current fee in {meta.symbol} and returns
        your {formatTokenAmount(loan.collateral)} {collateralSymbol} collateral.
      </p>
      <button
        onClick={handleRepay}
        disabled={busy}
        className="btn-primary mt-2 min-h-[36px] px-4 text-xs"
      >
        {checking
          ? 'Reading the loan…'
          : approveTx.phase === 'simulating' || approveTx.phase === 'signing'
            ? 'Approve the repayment…'
            : approveTx.phase === 'pending'
              ? 'Approving…'
              : repayTx.phase === 'simulating'
                ? 'Double-checking…'
                : repayTx.phase === 'signing'
                  ? 'Confirm in your wallet…'
                  : repayTx.phase === 'pending'
                    ? 'Repaying…'
                    : 'Confirm repayment'}
      </button>
      {flowError || approveTx.error || repayTx.error ? (
        <p className="mt-1.5 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700">
          {flowError ?? approveTx.error ?? repayTx.error}
        </p>
      ) : null}
    </div>
  )
}
