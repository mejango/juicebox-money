'use client'

import {
  JBCoreContracts,
  jbContractAddress,
  jbTokensAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import {
  buildBorrowTx,
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
import { FormFieldsSkeleton } from '@/components/LoadingSkeletons'
import { useEffect, useMemo, useState } from 'react'
import {
  erc20Abi,
  formatUnits,
  parseUnits,
  type Address,
  type PublicClient,
} from 'viem'
import { usePublicClient, useReadContract } from 'wagmi'
import { txPhaseLabel, useSafeTx } from '@/hooks/useSafeTx'
import { useWallet } from '@/hooks/useWallet'
import { revLoansAddress, tokenMeta } from '@/components/project/LoansSection'
import { TxError } from '@/components/ui/TxError'
import { etherscanTxUrl, formatDate, formatTokenAmount } from '@/lib/format'

const BURN_TOKENS = JBPermissionIdsV6.BURN_TOKENS

/** Prepaid-fee choices, out of 1000. Prepaying more buys more fee-free time
 *  before the repayment cost starts to grow (see the SDK MIN_PREPAID_FEE_PERCENT
 *  docstring). 25 (2.5%) is the on-chain minimum — 0 reverts. */
const PREPAID_OPTIONS = [
  { value: 25, label: '2.5%' },
  { value: 50, label: '5%' },
  { value: 100, label: '10%' },
] as const

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

/**
 * The "Get a loan" flow (revnet only), extracted from LoansSection so the
 * Accounts (YOU) card can render it inline. Borrow against your revnet tokens
 * (REVLoans.borrowFrom, tx #8) without selling: the tokens are held as
 * collateral and returned when you repay. Every write re-reads authoritative
 * on-chain state and goes through useSafeTx (simulate-first). Loans are locked
 * while a revnet's cash-out delay is active — borrowable reads 0 then, and the
 * flow aborts rather than send.
 *
 * Rendered bare (no card chrome): the caller wraps it in a panel.
 */
export function GetLoanFlow({
  chainId,
  projectId,
  collateralSymbol = 'tokens',
}: {
  chainId: JBChainId
  projectId: number
  /** The project's OWN token symbol (the collateral), resolved on-chain. */
  collateralSymbol?: string
}) {
  const publicClient = usePublicClient({ chainId }) as PublicClient | undefined
  const { isConnected, address, openSignIn } = useWallet()

  // Wallet state is client-only; keep SSR + first client render identical.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

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
  const ctxs: readonly JBAccountingContext[] = contexts ?? []

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
    ctxs.find(c => c.token === ctxToken) ?? ctxs[0] ?? undefined
  const meta = ctx
    ? tokenMeta(ctxs, ctx.token, chainId)
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

  const busy = quoting || permTx.busy || borrowTx.busy

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
    ? etherscanTxUrl(chainId, borrowTx.hash)
    : null

  if (borrowTx.phase === 'success') {
    return (
      <div className="rounded-xl border border-smoke-200 p-4">
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
    )
  }

  return (
    <div>
      <p className="text-sm leading-relaxed text-smoke-700">
        Borrow against your {collateralSymbol} without selling. Your tokens are
        held as collateral and returned when you repay.
      </p>

      {contextsLoading ? (
        <FormFieldsSkeleton rows={3} label="Loading loan terms" />
      ) : ctxs.length === 0 ? (
        <p className="mt-3 text-sm leading-relaxed text-smoke-700">
          This revnet doesn’t accept a token to borrow on this chain.
        </p>
      ) : delayActive ? (
        <p className="callout callout-warning mt-3 text-xs">
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

          {ctxs.length > 1 ? (
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
                {ctxs.map(c => (
                  <option key={c.token} value={c.token}>
                    {tokenMeta(ctxs, c.token, chainId).symbol}
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
            <div className="callout callout-info text-xs">
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
                  : txPhaseLabel(borrowTx.phase, {
                      idle: !isConnected
                        ? 'Sign in to continue'
                        : review
                          ? 'Confirm loan'
                          : 'Review',
                      pending: 'Opening your loan…',
                      confirm: 'Confirm the loan in your wallet…',
                    })}
          </button>

          <TxError
            error={flowError ?? permTx.error ?? borrowTx.error}
            className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700"
          />
        </div>
      )}
    </div>
  )
}
