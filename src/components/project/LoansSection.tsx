'use client'

import {
  JB_CHAINS,
  NATIVE_TOKEN,
  jbContractAddress,
  revLoansAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import {
  buildRepayLoanTx,
  getAccountingContexts,
  getTokenAddress,
  type JBAccountingContext,
} from '@bananapus/nana-sdk-core/v6'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { erc20Abi, type Address, type PublicClient } from 'viem'
import { usePublicClient, useReadContract } from 'wagmi'
import { useSafeTx } from '@/hooks/useSafeTx'
import { useWallet } from '@/hooks/useWallet'
import { formatDate, formatTokenAmount, truncateAddress } from '@/lib/format'
import type { BsLoan } from '@/lib/loans-queries'

export function revLoansAddress(chainId: JBChainId): Address {
  return jbContractAddress['6']['REVLoans'][chainId] as Address
}

/** The loan's source-token symbol/decimals, looked up from the revnet's own
 *  accounting contexts (a loan can only be denominated in one of them). */
export function tokenMeta(
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
 * The Loans subtab (revnet only, website/ parity): DISPLAY-ONLY loan book —
 * the connected holder's own loans (with per-loan repay) and every loan against
 * the revnet. Opening a loan now lives in the Accounts (YOU) card
 * (GetLoanFlow). Repaying re-reads authoritative on-chain state and goes
 * through useSafeTx (simulate-first).
 */
export function LoansSection({
  chainId,
  projectId,
}: {
  chainId: JBChainId
  projectId: number
}) {
  const publicClient = usePublicClient({ chainId }) as PublicClient | undefined

  const { data: contexts } = useQuery({
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
      <LoansTables
        chainId={chainId}
        projectId={projectId}
        contexts={contexts ?? []}
        collateralSymbol={collateralSymbol}
      />
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
        <div>
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
          ) : null}
        </div>
        {!isLoading && !isError && loans.length > 0 ? (
          <LoanTable
            chainId={chainId}
            projectId={projectId}
            loans={loans}
            contexts={contexts}
            collateralSymbol={collateralSymbol}
          />
        ) : null}
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
