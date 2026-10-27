'use client'

import { legacyRepayKey } from '@/lib/legacy-intents'
import { approvalIntent, loanIntent } from '@bananapus/nana-sdk-core/review'

import { useKeptQuery } from '@/hooks/useKeptQuery'

import {
  NATIVE_TOKEN,
  jbV6ContractAddress,
  jbMultiTerminalAbi,
  revLoansAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import {
  buildRepayLoanTx,
  type JBAccountingContext,
} from '@bananapus/nana-sdk-core/v6'
import { useQuery } from '@tanstack/react-query'
import { knownTokenSymbol, tokenSymbol } from '@/lib/token-symbol'
import { useEffect, useState } from 'react'
import { erc20Abi, type Address, type PublicClient } from 'viem'
import { usePublicClient } from 'wagmi'
import { liveStep, reachedLastStep, reviewedCall, useReviewedAction } from '@/hooks/useReviewedAction'
import { planShown, sequenceCalls } from '@/lib/reviewed-send'
import { useWallet } from '@/hooks/useWallet'
import { useViewedAccount } from '@/hooks/useViewedAccount'
import { contextRows, TxProgress } from '@/components/ui/TxProgress'
import { TxError } from '@/components/ui/TxError'
import { SkeletonTable } from '@/components/ui/Skeleton'
import {
  etherscanTxUrl,
  formatDate,
  formatTokenAmount,
  truncateAddress,
} from '@/lib/format'
import type { BsLoan } from '@/lib/loans-queries'
import { buildErc20ApproveRequest } from '@/lib/transaction-builders'
import { PERSIST } from '@/lib/query-persist'
import { accountingContextsQuery } from '@/lib/project-display-queries'
import { projectTokenQuery } from '@/lib/project-token-query'
import { Revalidating } from '@/components/ui/Revalidating'
import { explorerTokenUrl } from '@/lib/chainDisplay'
import { chainName } from '@/lib/urn'
import { ConceptTerm } from '@/components/project/ConceptTerm'
import { PROTOCOL_CONCEPTS } from '@/lib/protocol-concepts'

export function revLoansAddress(chainId: JBChainId): Address {
  return jbV6ContractAddress['REVLoans'][chainId] as Address
}

type LoanTokenMeta = { symbol: string; decimals: number }

/** The loan's source-token units, from its context or verified canonical identity. */
export function tokenMeta(
  contexts: readonly JBAccountingContext[],
  token: string,
  chainId: JBChainId,
  /** Resolved ERC-20 symbols keyed by lowercased address. Without it an ERC-20 falls back to
   *  a truncated address, which is a correct label for nothing anyone recognises. */
  symbols?: Record<string, string>,
): LoanTokenMeta | null {
  const ctx = contexts.find(c => c.token.toLowerCase() === token.toLowerCase())
  const known = knownTokenSymbol(token, { chainId })
  const decimals = known
    ? token.toLowerCase() === NATIVE_TOKEN.toLowerCase() ? 18 : 6
    : ctx?.decimals
  if (decimals == null || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) return null
  return {
    symbol: known ?? symbols?.[token.toLowerCase()] ?? truncateAddress(token),
    decimals,
  }
}

/**
 * The Loans subtab (revnet only, website/ parity): DISPLAY-ONLY loan book —
 * the connected holder's own loans (with per-loan repay) and every loan against
 * the revnet. Opening a loan now lives in the Accounts (YOU) card
 * (GetLoanFlow). Repaying re-reads authoritative on-chain state and goes
 * through the reviewed send (simulate-first).
 */
export function LoansSection({
  chainId,
  projectId,
}: {
  chainId: JBChainId
  projectId: number
}) {
  const publicClient = usePublicClient({ chainId }) as PublicClient | undefined

  const { data: contexts, isFetching: contextsFetching, refetch: retryContexts } = useQuery({
    ...accountingContextsQuery(publicClient!, { chainId, projectId: BigInt(projectId) }),
    enabled: !!publicClient,
  })

  // Resolved here rather than at render, because reading `symbol()` is async and `tokenMeta`
  // is called from render paths — which is why it fell back to a truncated address and showed
  // a USDC loan as "0x1c7D…".
  const { data: symbols } = useQuery({
    queryKey: ['loanTokenSymbols', chainId, contexts?.map(c => c.token).join(',')],
    enabled: !!publicClient && !!contexts?.length,
    staleTime: 5 * 60_000,
    retry: 1,
    queryFn: async () =>
      Object.fromEntries(
        await Promise.all(
          contexts!.map(async ctx => [
            ctx.token.toLowerCase(),
            await tokenSymbol(publicClient!, ctx.token as Address, { chainId }),
          ]),
        ),
      ) as Record<string, string>,
  })

  // The project token symbol, for the collateral copy.
  const { data: collateralToken } = useKeptQuery({
    ...projectTokenQuery(publicClient!, chainId, projectId),
    enabled: !!publicClient,
  })
  const collateralSymbol = collateralToken?.symbol ?? 'tokens'

  return (
    <div className="space-y-5">
      <LoansTables
        chainId={chainId}
        projectId={projectId}
        contexts={contexts ?? []}
        symbols={symbols}
        collateralSymbol={collateralSymbol}
        contextsFetching={contextsFetching}
        retryContexts={() => void retryContexts()}
      />
    </div>
  )
}

// ------------------------------------------------------------- loan book --

function LoansTables({
  chainId,
  projectId,
  contexts,
  symbols,
  collateralSymbol,
  contextsFetching,
  retryContexts,
}: {
  chainId: JBChainId
  projectId: number
  contexts: readonly JBAccountingContext[]
  symbols?: Record<string, string>
  collateralSymbol: string
  contextsFetching: boolean
  retryContexts: () => void
}) {
  const { address } = useViewedAccount()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const { data, isLoading, isError, isFetching, refetch } = useKeptQuery({
    queryKey: ['loans', chainId, projectId],
    meta: PERSIST,
    staleTime: 30_000,
    retry: 1,
    queryFn: async () => {
      const res = await fetch(
        `/api/loans?chainId=${chainId}&projectId=${projectId}`,
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
      {loans.some(loan => !tokenMeta(contexts, loan.token, chainId, symbols)) ? (
        <p className="text-sm text-smoke-700" role="status">
          Some loan amounts are unavailable until their token units can be read.{' '}
          <button type="button" className="underline" disabled={contextsFetching} onClick={retryContexts}>
            {contextsFetching ? 'Reading token units…' : 'Retry token data'}
          </button>
        </p>
      ) : null}
      {mounted && address && yourLoans.length > 0 ? (
        <div className="card p-5">
          <span className="field-label">Your loans</span>
          <LoanTable
            chainId={chainId}
            loans={yourLoans}
            contexts={contexts}
            symbols={symbols}
            collateralSymbol={collateralSymbol}
            holder={address}
            onRepaid={refetch}
          />
        </div>
      ) : null}

      <div className="card p-5">
        <div>
          <span className="field-label">All loans</span>
          {isLoading ? (
            <SkeletonTable rows={4} columns={5} className="mt-5" />
          ) : isError ? (
            <p className="mt-2 text-sm text-smoke-700">
              Loan data is unavailable right now.
            </p>
          ) : loans.length === 0 ? (
            <p className="mt-2 text-sm leading-relaxed text-smoke-700">
              No one has taken a loan against this revnet yet.
            </p>
          ) : null}
        </div>
        {!isLoading && !isError && loans.length > 0 ? (
          <Revalidating as="div" pending={isFetching}>
            <LoanTable
              chainId={chainId}
              loans={loans}
              contexts={contexts}
              symbols={symbols}
              collateralSymbol={collateralSymbol}
            />
          </Revalidating>
        ) : null}
      </div>
    </>
  )
}

function LoanTable({
  chainId,
  loans,
  contexts,
  symbols,
  collateralSymbol,
  holder,
  onRepaid,
}: {
  chainId: JBChainId
  loans: BsLoan[]
  contexts: readonly JBAccountingContext[]
  symbols?: Record<string, string>
  collateralSymbol: string
  /** When set, a Repay column is shown (the connected holder's own loans). */
  holder?: Address
  onRepaid?: () => void
}) {
  return (
    <div className="mt-2 overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-smoke-500">
            <th className="pb-1.5 font-normal">Borrowed</th>
            <th className="pb-1.5 text-right font-normal">Collateral</th>
            <th className="pb-1.5 text-right font-normal">
              <ConceptTerm note={PROTOCOL_CONCEPTS.prepaidFee}>Prepaid fee</ConceptTerm>
            </th>
            <th className="pb-1.5 text-right font-normal">Opened</th>
            {holder ? <th className="pb-1.5 text-right font-normal" /> : null}
          </tr>
        </thead>
        <tbody className="text-ink">
          {loans.map(loan => {
            const meta = tokenMeta(contexts, loan.token, chainId, symbols)
            const isNative =
              loan.token.toLowerCase() === NATIVE_TOKEN.toLowerCase()
            return (
              <tr key={loan.id} className="border-t border-smoke-100">
                <td className="py-1.5 pr-3">
                  {!meta ? "Unavailable" : explorerTokenUrl(chainId, loan.token) && !isNative ? (
                    <a
                      href={explorerTokenUrl(chainId, loan.token)!}
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
                      loan={loan}
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

/** A reviewed repayment: read fresh when Repay is pressed and frozen until
 *  the dialog closes, so what the holder confirms is what gets sent. */
type RepayPlan = {
  /** The holder it repays from and returns collateral to: only it may send it. */
  account: Address
  request: ReturnType<typeof buildRepayLoanTx>
  amount: bigint
  /** Units and identity read for the fresh loan, frozen with this repayment. */
  sourceToken: Address
  meta: LoanTokenMeta
  maxRepay: bigint
  collateral: bigint
  isNative: boolean
  /** The ERC-20 approval prompt, when the allowance doesn't already cover the cap. */
  approve: ReturnType<typeof buildErc20ApproveRequest> | null
  /** Its cap re-reads the fee on a fresh review: the write hold keys of the loan the user repays. */
  intents: { repay: string; approve: string }
  /** The keys the last release built for these (legacy-intents). */
  legacy: { repay: string[] }
}

function RepayFlow({
  chainId,
  loan,
  collateralSymbol,
  holder,
  onRepaid,
}: {
  chainId: JBChainId
  loan: BsLoan
  collateralSymbol: string
  holder: Address
  onRepaid?: () => void
}) {
  const publicClient = usePublicClient({ chainId }) as PublicClient | undefined
  const { address } = useWallet()
  const tx = useReviewedAction(chainId)
  /** The repayment reached the wallet: only then does a settled run mean the loan is repaid, not just approved. */
  const [repaySent, setRepaySent] = useState(false)
  const [runStep, setRunStep] = useState(0)
  /** Each run call's dialog step. */
  const [runShown, setRunShown] = useState<number[] | null>(null)

  const [checking, setChecking] = useState(false)
  const [flowError, setFlowError] = useState<string | null>(null)
  const [plan, setPlan] = useState<RepayPlan | null>(null)

  const loans = revLoansAddress(chainId)

  const busy = tx.busy
  const repaid = tx.phase === 'success' && repaySent
  /** A Safe executed the approval alone: the repayment is next. */
  const approvalOnly = (tx.phase === 'success' && !repaySent) || tx.settledStep != null

  const repayTxUrl = repaid && tx.hash
    ? etherscanTxUrl(chainId, tx.hash)
    : null

  useEffect(() => {
    if (repaid) onRepaid?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repaid])

  const handleRepay = async () => {
    if (!publicClient || checking || busy) return
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
      // Canonical token units are established by chain/address. A custom loan
      // needs its own terminal context, never the indexer's possibly stale token.
      let meta = tokenMeta([], fresh.sourceToken, chainId)
      if (!meta) {
        try {
          const [terminal, revnetId] = await Promise.all([
            publicClient.readContract({ abi: revLoansAbi, address: loans, functionName: 'TERMINAL' }),
            publicClient.readContract({ abi: revLoansAbi, address: loans, functionName: 'revnetIdOfLoanWith', args: [BigInt(loan.id)] }),
          ])
          const context = await publicClient.readContract({
            abi: jbMultiTerminalAbi, address: terminal, functionName: 'accountingContextForTokenOf',
            args: [revnetId, fresh.sourceToken],
          })
          if (context.token.toLowerCase() !== fresh.sourceToken.toLowerCase()) throw new Error('Mismatched loan token')
          const symbol = await tokenSymbol(publicClient, fresh.sourceToken, { chainId })
          meta = tokenMeta([context], fresh.sourceToken, chainId, { [fresh.sourceToken.toLowerCase()]: symbol })
          if (!meta) throw new Error('Unknown loan token units')
        } catch {
          throw new Error("Couldn't read this loan's token units. Try Repay again.")
        }
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

      // ERC-20 source: approve REVLoans for the cap first (a step of the one
      // review), then repay. Skip when the allowance already covers it.
      const allowance = isNative
        ? maxRepay
        : ((await publicClient.readContract({
            abi: erc20Abi,
            address: fresh.sourceToken,
            functionName: 'allowance',
            args: [holder, loans],
          })) as bigint)
      setPlan({
        account: holder,
        request,
        amount: fresh.amount,
        sourceToken: fresh.sourceToken,
        meta,
        maxRepay,
        collateral: fresh.collateral,
        isNative,
        intents: {
          repay: loanIntent({ chainId, loanId: BigInt(loan.id) }),
          approve: approvalIntent(loanIntent({ chainId, loanId: BigInt(loan.id) }), { step: 'repay-approval', token: fresh.sourceToken, spender: loans }),
        },
        // The keys the last release built: an attempt it left unresolved still holds these.
        legacy: {
          repay: [legacyRepayKey({ chainId, loanId: loan.id, holder })],
        },
        approve:
          allowance >= maxRepay
            ? null
            : buildErc20ApproveRequest({
                chainId,
                token: fresh.sourceToken,
                spender: loans,
                amount: maxRepay,
              }),
      })
    } catch (e) {
      setFlowError(e instanceof Error ? e.message : 'Something went wrong.')
    } finally {
      setChecking(false)
    }
  }

  /** The plan's summary: shown on its progress, and in its one review. */
  const repayRows = (current: RepayPlan) => [
    { label: 'Loan', value: `${formatTokenAmount(current.amount, current.meta.decimals)} ${current.meta.symbol}` },
    { label: 'Repay up to', value: `${formatTokenAmount(current.maxRepay, current.meta.decimals)} ${current.meta.symbol}`, strong: true },
    { label: 'Collateral returned', value: `${formatTokenAmount(current.collateral)} ${collateralSymbol}` },
    { label: 'On', value: chainName(chainId) },
  ]

  // One review: the approval when one is needed, then the repayment on the block it landed in.
  const handleConfirm = async () => {
    if (!plan || busy) return
    setFlowError(null)
    // After an approval a Safe executed alone, the repayment follows on its block.
    const approved = approvalOnly ? tx.receipt?.blockNumber : undefined
    const approve = plan.approve && approved === undefined ? plan.approve : null
    const repay = reviewedCall(plan.request, {
      intent: plan.intents.repay,
      legacy: plan.legacy.repay,
      ...(approve ? { dependsOnPrior: true } : approved !== undefined ? { simulationBlockNumber: approved } : {}),
    })
    const fresh = approve ? [reviewedCall(approve, { intent: plan.intents.approve }), repay] : [repay]
    const scope = `jbm:repay:${chainId}:${loan.id}`
    const { calls, saved, scope: runScope } = await sequenceCalls(scope, plan.account, fresh)
    // The dialog's steps: a held sequence resumes as saved, and a continued one is the repayment alone.
    const total = plan.approve ? 2 : 1
    const shown = (step: number) => Math.max(0, total - calls.length + step)
    setRepaySent(false)
    setRunStep(shown(0))
    setRunShown(calls.map((_, step) => shown(step)))
    const ended = await tx.run({
      account: plan.account,
      scope: runScope,
      calls,
      ...planShown(saved, { context: contextRows(repayRows(plan)) }),
      onSubmitted: (_call, step) => {
        setRunStep(shown(step))
        if (shown(step) === total - 1) setRepaySent(true)
      },
    })
    if (reachedLastStep(ended, calls.length)) setRepaySent(true)
  }

  const closeDialog = () => {
    if (busy) return
    setPlan(null)
    setFlowError(null)
    if (!repaid) tx.dismiss()
  }

  const activeIndex = tx.phase !== 'idle' ? liveStep(tx, runShown, runStep) : -1
  const error = flowError ?? tx.error

  const dialog = plan || checking ? (
    <TxProgress
      open
      preparing={!plan}
      title={repaid ? 'Loan repaid' : 'Confirm repayment'}
      rows={plan ? repayRows(plan) : []}
      steps={plan ? [
        ...(plan.approve
          ? [
              {
                key: 'approve',
                title: `Approve ${plan.meta.symbol} for REVLoans`,
                detail: 'Covers the amount borrowed plus the current repayment cost.',
              },
            ]
          : []),
        { key: 'repay', title: 'Repay and reclaim your collateral' },
      ] : []}
      activeIndex={activeIndex}
      busy={checking || busy}
      complete={tx.settled && !approvalOnly}
      status={
        !plan
          ? 'Reading the loan and its current fee…'
          : approvalOnly
            ? 'Approval confirmed. Continue to the repayment.'
            : (tx.notice ?? tx.safeNonceGuidance)
      }
      error={error}
      onClose={closeDialog}
      start={() => void handleConfirm()}
      next={(!!error || approvalOnly) && !busy ? { label: approvalOnly ? 'Continue' : 'Retry', onClick: () => void handleConfirm() } : null}
    >
      <p className="text-xs leading-relaxed text-smoke-700">
        The limit covers the amount borrowed plus the current repayment cost in {plan?.meta.symbol ?? 'the loan token'},
        with room for changes before confirmation. Anything unused is refunded.
      </p>
    </TxProgress>
  ) : null

  if (repaid) {
    return (
      <>
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
        {dialog}
      </>
    )
  }

  return (
    <>
      <button
        onClick={handleRepay}
        disabled={checking || busy}
        className="btn-secondary min-h-[32px] px-3 text-xs"
      >
        Repay
      </button>
      {!plan ? (
        <TxError
          error={flowError}
          className="mt-1.5 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-left text-xs text-red-700"
        />
      ) : null}
      {dialog}
    </>
  )
}
