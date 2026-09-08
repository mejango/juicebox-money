'use client'

import {
  JB_CHAINS,
  JBCoreContracts,
  jbContractAddress,
  jbTokensAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import {
  buildPermit2ApproveTx,
  buildUniswapV4ExactInputSwapTx,
  chooseBestCashOutRoute,
  getHookAwareCashOutQuote,
  getTokenAddress,
  prepareHookAwareCashOut,
  quoteUniswapV4ExactInputSingle,
  resolvePaymentTerminal,
  uniswapV4Deployment,
  uniswapV4SwapDirection,
} from '@bananapus/nana-sdk-core/v6'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import {
  erc20Abi,
  formatUnits,
  parseEther,
  zeroAddress,
  type Abi,
  type Address,
  type PublicClient,
} from 'viem'
import { useReadContract, usePublicClient } from 'wagmi'
import { useSafeTx, type TxRequest } from '@/hooks/useSafeTx'
import { useWallet } from '@/hooks/useWallet'
import { TxConfirmDialog, type TxConfirmRow } from '@/components/ui/TxConfirmDialog'
import { TxError } from '@/components/ui/TxError'
import {
  cashOutExecutionErrorMessage,
  cashOutPoolBufferBps,
  getCashOutContext,
  isNativeToken,
  minimumDropNotice,
} from '@/lib/cashOut'
import { buildErc20ApproveRequest as buildTokenApproval } from '@/lib/transaction-builders'
import { etherscanTxUrl, formatTokenAmount, truncateAddress } from '@/lib/format'
import { resolveMarket } from '@/components/project/MarketSection'
import { swapDeadline } from '@/lib/safe-connector'
import { chainName } from '@/lib/urn'

/** Max-slippage presets in basis points; 1% is the cross-client default. */
const SLIPPAGE_PRESETS_BPS = [50, 100, 300]
const DEFAULT_SLIPPAGE_BPS = 100

/**
 * The reviewed exit, frozen when the dialog opens. A treasury cash-out is
 * prepared from fresh protocol state and sent exactly as frozen; a pool sale
 * freezes the floor it promises and re-quotes once its approvals clear, since
 * the swap's deadline and the pool comparison cannot be locked before them.
 */
type CashOutPlan =
  | {
      kind: 'treasury'
      request: TxRequest
      venue: 'treasury' | 'amm'
      minimumReturn: bigint
      fee: bigint
      reviewNotice: string | undefined
    }
  | { kind: 'pool'; minimumReturn: bigint }

/**
 * The cash-out flow (JBMultiTerminal.cashOutTokensOf), extracted from
 * TreasuryCard so both the treasury card and the Accounts (YOU) card render
 * the same panel. Every write goes through useSafeTx (simulate-first) and the
 * SDK's hook-aware slippage-protected route — a zero floor never sends.
 *
 * Rendered bare (no card chrome): the caller wraps it.
 */
export function CashOutPanel({
  chainId,
  projectId,
  projectName,
  accountingToken,
  accountingTokenSymbol,
  onGoToPay,
  showHeading = true,
}: {
  chainId: JBChainId
  projectId: number
  projectName?: string
  /** The accounting token's address per bendystraw. */
  accountingToken?: string | null
  /** The accounting token's symbol per bendystraw (e.g. "ETH", "USDC"). */
  accountingTokenSymbol?: string | null
  /** Switch to the Pay tab, when the host has one. */
  onGoToPay?: () => void
  /** The modal host supplies the dialog title. */
  showHeading?: boolean
}) {
  const { isConnected, address, openSignIn } = useWallet()
  const publicClient = usePublicClient({ chainId }) as PublicClient | undefined
  const tx = useSafeTx(chainId)
  const approveTx = useSafeTx(chainId)

  const [amount, setAmount] = useState('')
  const [debouncedAmount, setDebouncedAmount] = useState('')
  const [slippageBps, setSlippageBps] = useState(DEFAULT_SLIPPAGE_BPS)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [usedDirectSell, setUsedDirectSell] = useState(false)
  const [plan, setPlan] = useState<CashOutPlan | null>(null)
  const [preparing, setPreparing] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setDebouncedAmount(amount), 400)
    return () => clearTimeout(t)
  }, [amount])

  // Project tokens use fixed-point 18 decimals.
  const cashOutCount = useMemo(() => {
    try {
      const n = Number(debouncedAmount)
      if (!debouncedAmount.trim() || !Number.isFinite(n) || n <= 0) return 0n
      return parseEther(debouncedAmount.trim())
    } catch {
      return 0n
    }
  }, [debouncedAmount])

  const chainMeta = JB_CHAINS[chainId]
  const nativeSymbol = chainMeta?.nativeTokenSymbol ?? 'ETH'

  // The holder's full project-token balance: ERC-20 + internal credits.
  const { data: balance, refetch: refetchBalance } = useReadContract({
    abi: jbTokensAbi,
    address: jbContractAddress['6'][JBCoreContracts.JBTokens][chainId],
    functionName: 'totalBalanceOf',
    args: [address ?? zeroAddress, BigInt(projectId)],
    chainId,
    query: { enabled: !!address },
  })

  // The symbol of the token being cashed out (the project's ERC-20, if any).
  const { data: projectToken } = useQuery({
    queryKey: ['projectTokenSymbol', chainId, projectId],
    enabled: !!publicClient,
    staleTime: 5 * 60_000,
    retry: 1,
    queryFn: async () => {
      const token = await getTokenAddress(publicClient!, {
        chainId,
        projectId: BigInt(projectId),
      })
      if (!token) return null
      const symbol = await publicClient!.readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'symbol',
      })
      return { address: token, symbol }
    },
  })
  const holdingsSymbol = projectToken?.symbol ?? 'tokens'

  // The accounting context: the token reclaimed by cash-outs. Never assume
  // native — USDC-accounting projects exist.
  const { data: context } = useQuery({
    queryKey: ['cashOutContext', chainId, projectId],
    enabled: !!publicClient,
    staleTime: 5 * 60_000,
    retry: 1,
    queryFn: () =>
      getCashOutContext(publicClient!, {
        chainId,
        projectId: BigInt(projectId),
      }),
  })

  const { data: terminal } = useQuery({
    queryKey: ['cashOutTerminal', chainId, projectId, context?.token],
    enabled: !!publicClient && !!context,
    staleTime: 5 * 60_000,
    retry: 1,
    queryFn: () =>
      resolvePaymentTerminal(publicClient!, {
        chainId,
        projectId: BigInt(projectId),
        token: context!.token,
      }),
  })

  // Hook-aware quote: previewCashOutFrom simulates the REAL cash-out path
  // (data hook, buyback routing) and yields a slippage-protected route.
  const {
    data: route,
    isFetching: quoteLoading,
    isError: quoteFailed,
    refetch: refetchCashOutRoute,
  } = useQuery({
    queryKey: [
      'cashOutQuote',
      chainId,
      projectId,
      cashOutCount.toString(),
      address ?? zeroAddress,
      slippageBps,
    ],
    enabled: !!publicClient && !!context && !!terminal && cashOutCount > 0n,
    retry: false,
    queryFn: () =>
      getHookAwareCashOutQuote(publicClient!, {
        chainId,
        projectId: BigInt(projectId),
        holder: address ?? zeroAddress,
        cashOutCount,
        tokenToReclaim: context!.token,
        terminal: terminal!.address,
        slippageBps: BigInt(slippageBps),
      }),
  })

  // Claimed project tokens can be sold directly into the buyback pool. This
  // bypasses the terminal fee, so compare its protected output against the
  // hook-aware terminal route and offer it only when it is strictly better.
  const { data: market } = useQuery({
    queryKey: ['cashOutMarket', chainId, projectId],
    enabled: !!publicClient && !!projectToken,
    staleTime: 30_000,
    retry: false,
    queryFn: () =>
      resolveMarket(publicClient!, chainId, projectId, nativeSymbol),
  })
  const directSellDirection =
    market?.status === 'pool' && projectToken && context
      ? uniswapV4SwapDirection({
          poolKey: market.key,
          tokenIn: projectToken.address,
          tokenOut: context.token,
        })
      : null
  const directSellAvailable = directSellDirection !== null
  const { data: claimedBalance } = useQuery({
    queryKey: ['claimedCashOutBalance', chainId, projectToken?.address, address],
    enabled: !!publicClient && !!projectToken && !!address,
    staleTime: 15_000,
    queryFn: () =>
      publicClient!.readContract({
        address: projectToken!.address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [address!],
      }),
  })
  const { data: directSellQuote, isFetching: directSellLoading } = useQuery({
    queryKey: [
      'directCashOutSell',
      chainId,
      projectId,
      cashOutCount.toString(),
      market?.status === 'pool' ? market.poolId : null,
      context?.token,
      directSellDirection,
    ],
    enabled:
      !!publicClient &&
      directSellAvailable &&
      cashOutCount > 0n &&
      (claimedBalance ?? 0n) >= cashOutCount,
    retry: false,
    queryFn: () => {
      if (market?.status !== 'pool' || !projectToken) {
        throw new Error('No direct sell route is available.')
      }
      return quoteUniswapV4ExactInputSingle(publicClient!, {
        chainId,
        poolKey: market.key,
        zeroForOne: directSellDirection!,
        amountIn: cashOutCount,
      })
    },
  })
  const bestRoute =
    route && market?.status === 'pool'
      ? chooseBestCashOutRoute({
          cashOut: route,
          directSwapQuote: directSellQuote,
          directSwapPoolKey: market.key,
          directSwapZeroForOne: directSellDirection ?? undefined,
          spendableProjectTokenCount: claimedBalance ?? 0n,
          cashOutCount,
          slippageBps: BigInt(slippageBps),
        })
      : route
        ? chooseBestCashOutRoute({ cashOut: route, cashOutCount })
        : null
  const directSellWins = bestRoute?.kind === 'direct-swap'
  const poolBufferBps = cashOutPoolBufferBps(route)

  const swapDeployment = directSellWins
    ? uniswapV4Deployment(chainId)
    : undefined
  const { data: tokenAllowance, refetch: refetchTokenAllowance } = useQuery({
    queryKey: ['cashOutTokenAllowance', chainId, projectToken?.address, swapDeployment?.permit2, address],
    enabled: !!publicClient && directSellWins && !!projectToken && !!swapDeployment?.permit2 && !!address,
    staleTime: 15_000,
    queryFn: () =>
      publicClient!.readContract({
        address: projectToken!.address,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [address!, swapDeployment!.permit2],
      }),
  })
  const { data: permit2Allowance, refetch: refetchPermit2Allowance } = useQuery({
    queryKey: ['cashOutPermit2Allowance', chainId, projectToken?.address, swapDeployment?.universalRouter, address],
    enabled: !!publicClient && directSellWins && !!projectToken && !!swapDeployment?.universalRouter && !!address,
    staleTime: 15_000,
    queryFn: () =>
      publicClient!.readContract({
        address: swapDeployment!.permit2,
        abi: [
          {
            type: 'function',
            name: 'allowance',
            stateMutability: 'view',
            inputs: [{ type: 'address' }, { type: 'address' }, { type: 'address' }],
            outputs: [{ type: 'uint160' }, { type: 'uint48' }, { type: 'uint48' }],
          },
        ],
        functionName: 'allowance',
        args: [address!, projectToken!.address, swapDeployment!.universalRouter as Address],
      }),
  })
  const needsTokenApproval =
    directSellWins && (tokenAllowance ?? 0n) < cashOutCount
  const needsRouterApproval =
    directSellWins &&
    (!permit2Allowance ||
      permit2Allowance[0] < cashOutCount ||
      Number(permit2Allowance[1]) <= Math.floor(Date.now() / 1000) + 1_800)

  useEffect(() => {
    if (approveTx.phase === 'success') {
      void refetchTokenAllowance()
      void refetchPermit2Allowance()
    }
  }, [approveTx.phase, refetchTokenAllowance, refetchPermit2Allowance])

  // A cleared approval stops being "needed", so the queue is built from the
  // approvals this sale ever required — otherwise a finished step disappears
  // instead of ticking over to done.
  const [requiredApprovals, setRequiredApprovals] = useState<
    ('token' | 'router')[]
  >([])
  useEffect(() => {
    setRequiredApprovals(current => {
      const next: ('token' | 'router')[] = directSellWins
        ? [
            ...(needsTokenApproval || current.includes('token')
              ? (['token'] as const)
              : []),
            ...(needsRouterApproval || current.includes('router')
              ? (['router'] as const)
              : []),
          ]
        : []
      return next.join() === current.join() ? current : next
    })
  }, [directSellWins, needsTokenApproval, needsRouterApproval])

  // Only trust bendystraw's symbol when it describes the same token as the
  // on-chain accounting context (projects can register several contexts).
  const receiveSymbol = context
    ? isNativeToken(context.token)
      ? nativeSymbol
      : accountingTokenSymbol &&
          accountingToken?.toLowerCase() === context.token.toLowerCase()
        ? accountingTokenSymbol
        : truncateAddress(context.token)
    : ''
  const receiveDecimals = context?.decimals ?? 18

  const zeroBalance = isConnected && balance === 0n
  const exceedsBalance =
    balance !== undefined && cashOutCount > 0n && cashOutCount > balance
  const nothingToReclaim =
    cashOutCount > 0n &&
    !quoteLoading &&
    route !== undefined &&
    route.expectedReturn <= 0n

  const busy = tx.busy || approveTx.busy
  const success = tx.phase === 'success'

  useEffect(() => {
    if (success) refetchBalance()
  }, [success, refetchBalance])

  const txUrl = tx.hash ? etherscanTxUrl(chainId, tx.hash) : null

  // Each approval is its own wallet prompt and its own click, so the whole
  // queue is named before the first one.
  const cashOutSteps = [
    ...requiredApprovals.map(kind =>
      kind === 'token'
        ? {
            key: 'token',
            title: `Approve ${holdingsSymbol} for the swap router`,
            detail: 'Permit2 cannot move your tokens without this allowance.',
          }
        : {
            key: 'router',
            title: 'Authorize the swap router',
            detail: 'A capped allowance that expires in 30 days.',
          },
    ),
    {
      key: 'cashout',
      title: directSellWins
        ? `Sell ${holdingsSymbol} on the pool`
        : `Cash out ${holdingsSymbol}`,
    },
  ]
  const cashOutActiveIndex = success
    ? cashOutSteps.length
    : needsTokenApproval
      ? requiredApprovals.indexOf('token')
      : needsRouterApproval
        ? requiredApprovals.indexOf('router')
        : requiredApprovals.length

  const setMax = () => {
    if (balance === undefined || balance <= 0n) return
    const max = formatUnits(balance, 18)
    setAmount(max)
    setDebouncedAmount(max)
  }

  const review = async () => {
    if (!isConnected || !address) {
      openSignIn()
      return
    }
    if (
      !terminal ||
      !context ||
      !route ||
      route.expectedReturn <= 0n ||
      cashOutCount <= 0n ||
      exceedsBalance ||
      busy
    )
      return
    setErrorMsg(null)
    // What the panel promised, captured before anything is re-quoted.
    const displayedMinimum = bestRoute?.minimumReturn ?? route.minimumReturn
    if (directSellWins && market?.status === 'pool' && projectToken && swapDeployment) {
      setPlan({ kind: 'pool', minimumReturn: displayedMinimum })
      return
    }
    setPreparing(true)
    try {
      // Quote, lock and build one matching request from fresh protocol state.
      const prepared = await prepareHookAwareCashOut(publicClient!, {
        chainId,
        projectId: BigInt(projectId),
        holder: address,
        cashOutCount,
        tokenToReclaim: context.token,
        terminal: terminal.address,
        beneficiary: address,
        slippageBps: BigInt(slippageBps),
      })
      if (prepared.route.expectedReturn <= 0n) {
        throw new Error(
          'The cash-out quote is no longer available. Review and try again.',
        )
      }
      const request = prepared.transaction
      setPlan({
        kind: 'treasury',
        request: { ...request, abi: request.abi as Abi },
        venue: prepared.route.route,
        minimumReturn: prepared.route.minimumReturn,
        fee: prepared.route.treasuryProtocolFee,
        reviewNotice: minimumDropNotice({
          displayedMinimum,
          freshMinimum: prepared.route.minimumReturn,
          decimals: receiveDecimals,
          symbol: receiveSymbol,
        }),
      })
    } catch (e) {
      setErrorMsg(cashOutExecutionErrorMessage(e))
    } finally {
      setPreparing(false)
    }
  }

  const cashOut = async () => {
    if (!plan || !address || busy) return
    setErrorMsg(null)
    try {
      if (plan.kind === 'pool') {
        if (market?.status !== 'pool' || !projectToken || !swapDeployment) {
          throw new Error('No direct sell route is available.')
        }
        if (needsTokenApproval) {
          await approveTx.send(
            buildTokenApproval({
              chainId,
              token: projectToken.address,
              spender: swapDeployment.permit2,
              amount: cashOutCount,
            }),
          )
          return
        }
        if (needsRouterApproval) {
          const approval = buildPermit2ApproveTx({
            chainId,
            token: projectToken.address,
            amount: cashOutCount,
            expiration: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
          })
          await approveTx.send({
            ...approval,
            args: approval.args as unknown as readonly unknown[],
            label: 'Approve swap router',
          })
          return
        }
        const refreshedCashOut = await refetchCashOutRoute()
        if (
          refreshedCashOut.isError ||
          !refreshedCashOut.data ||
          refreshedCashOut.data.expectedReturn <= 0n
        ) {
          throw new Error(
            'The cash-out quote is no longer available. Review and try again.',
          )
        }
        const freshQuote = await quoteUniswapV4ExactInputSingle(publicClient!, {
          chainId,
          poolKey: market.key,
          zeroForOne: directSellDirection!,
          amountIn: cashOutCount,
        })
        const refreshedBest = chooseBestCashOutRoute({
          cashOut: refreshedCashOut.data,
          directSwapQuote: freshQuote,
          directSwapPoolKey: market.key,
          directSwapZeroForOne: directSellDirection!,
          spendableProjectTokenCount: claimedBalance ?? 0n,
          cashOutCount,
          slippageBps: BigInt(slippageBps),
        })
        if (refreshedBest.kind !== 'direct-swap') {
          throw new Error('The pool no longer beats the project cash-out route. Review the refreshed quote.')
        }
        const request = buildUniswapV4ExactInputSwapTx({
          chainId,
          poolKey: market.key,
          zeroForOne: directSellDirection!,
          amountIn: cashOutCount,
          minimumAmountOut: refreshedBest.minimumReturn,
          recipient: address,
          deadline: swapDeadline(tx.isSafe),
        })
        setUsedDirectSell(true)
        await tx.send(
          {
            ...request,
            args: request.args as unknown as readonly unknown[],
            label:
              'Sell claimed project tokens through the best available pool route',
          },
          {
            reviewNotice: minimumDropNotice({
              displayedMinimum: plan.minimumReturn,
              freshMinimum: refreshedBest.minimumReturn,
              decimals: receiveDecimals,
              symbol: receiveSymbol,
            }),
          },
        )
        return
      }
      // The terminal route is not a pool sale — clear any flag left by an
      // earlier attempt so the success copy names the route actually taken.
      setUsedDirectSell(false)
      await tx.send(plan.request, { reviewNotice: plan.reviewNotice })
    } catch (e) {
      setErrorMsg(cashOutExecutionErrorMessage(e))
    }
  }

  const reset = () => {
    tx.reset()
    setAmount('')
    setDebouncedAmount('')
    setErrorMsg(null)
    setUsedDirectSell(false)
  }

  const closeReview = () => {
    setPlan(null)
    setErrorMsg(null)
    if (success) return
    tx.reset()
    approveTx.reset()
  }

  const confirmDialog = plan ? (
    <TxConfirmDialog
      open
      title={
        success
          ? usedDirectSell
            ? 'Sold on the pool'
            : 'Cashed out'
          : plan.kind === 'pool'
            ? 'Confirm pool sale'
            : 'Confirm cash out'
      }
      rows={(() => {
        const rows: TxConfirmRow[] = [
          {
            label: plan.kind === 'pool' ? 'Sell' : 'Cash out',
            value: `${formatTokenAmount(cashOutCount, 18)} ${holdingsSymbol}`,
            strong: true,
          },
          { label: 'On', value: chainName(chainId) },
          {
            label: 'You get at least',
            value: `${formatTokenAmount(plan.minimumReturn, receiveDecimals)} ${receiveSymbol}`,
            strong: true,
          },
        ]
        if (plan.kind === 'treasury' && plan.venue === 'treasury' && plan.fee > 0n) {
          rows.push({
            label: 'Fee',
            value: `${formatTokenAmount(plan.fee, receiveDecimals)} ${receiveSymbol}`,
          })
        }
        rows.push({
          label: 'Route',
          value:
            plan.kind === 'pool'
              ? 'Direct pool sale'
              : plan.venue === 'amm'
                ? 'Buyback pool via the terminal'
                : 'Project treasury',
        })
        return rows
      })()}
      steps={cashOutSteps}
      activeIndex={cashOutActiveIndex}
      action={
        needsTokenApproval
          ? 'Approve tokens for best execution'
          : needsRouterApproval
            ? 'Authorize the swap router'
            : plan.kind === 'pool'
              ? 'Confirm & sell'
              : 'Confirm & cash out'
      }
      onConfirm={() => void cashOut()}
      busy={busy}
      complete={success}
      status={
        tx.phase === 'pending' && txUrl ? (
          <>
            Waiting for confirmation —{' '}
            <a
              href={txUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2"
            >
              view transaction
            </a>
          </>
        ) : null
      }
      error={errorMsg ?? tx.error ?? approveTx.error}
      onClose={closeReview}
    />
  ) : preparing ? (
    <TxConfirmDialog
      open
      preparing
      title="Confirm cash out"
      steps={[]}
      activeIndex={-1}
      action="Confirm & cash out"
      onConfirm={() => undefined}
      busy
      status="Getting a fresh cash-out quote…"
      onClose={closeReview}
    />
  ) : null

  if (success) {
    return (
      <div className="flex flex-col items-center py-4 text-center">
        {confirmDialog}
        <span className="flex h-14 w-14 items-center justify-center rounded-full bg-melon-400">
          <svg
            viewBox="0 0 24 24"
            className="h-7 w-7 text-ink"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="m5 13 4 4L19 7" />
          </svg>
        </span>
        <h3 className="mt-4 font-agrandir text-lg font-medium">
          {usedDirectSell ? 'Sold on the pool!' : 'Cashed out!'}
        </h3>
        <p className="mt-1 text-sm text-smoke-700">
          {usedDirectSell
            ? `Your claimed ${holdingsSymbol} were sold through the better direct pool route.`
            : `Your share of ${projectName ?? 'the project'}'s treasury is on its way.`}
        </p>
        <div className="mt-5 flex gap-3 text-sm font-semibold">
          {txUrl ? (
            <a
              href={txUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-bluebs-600 underline underline-offset-2 hover:text-bluebs-700"
            >
              View transaction
            </a>
          ) : null}
          <button onClick={reset} className="text-smoke-700 hover:text-ink">
            Cash out again
          </button>
        </div>
      </div>
    )
  }

  return (
    <div>
      {showHeading ? (
        <h3 className="font-agrandir text-lg font-medium">
          Cash out your tokens
        </h3>
      ) : null}

      <div className="mt-2 min-h-[20px] text-sm text-smoke-700" aria-live="polite">
        {!isConnected ? (
          'Sign in to see your balance.'
        ) : zeroBalance ? (
          onGoToPay ? (
            <>
              You don&apos;t hold this project&apos;s tokens yet —{' '}
              <button
                onClick={onGoToPay}
                className="font-medium text-bluebs-600 underline underline-offset-2 hover:text-bluebs-700"
              >
                pay to get some
              </button>
              .
            </>
          ) : (
            "You don't hold this project's tokens yet."
          )
        ) : balance !== undefined ? (
          <span className="flex items-center gap-2">
            You hold {formatTokenAmount(balance, 18)} {holdingsSymbol}
            <button
              onClick={setMax}
              className="btn-secondary px-2.5 py-0.5 text-[11px]"
            >
              MAX
            </button>
          </span>
        ) : (
          'Checking your balance…'
        )}
      </div>

      <label className="mt-3 block">
        <span className="field-label">Amount to cash out</span>
        <div
          className={`input-well mt-1.5 flex items-center px-4 ${
            zeroBalance ? 'opacity-50' : ''
          }`}
        >
          <input
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            placeholder="0"
            disabled={zeroBalance}
            aria-label={`Amount of ${holdingsSymbol} to cash out`}
            className="min-h-[52px] w-full bg-transparent text-xl font-medium outline-none placeholder:text-smoke-500 disabled:cursor-not-allowed"
          />
          <span className="ml-2 shrink-0 font-medium text-smoke-700">
            {holdingsSymbol}
          </span>
        </div>
      </label>

      <div className="mt-2 min-h-[20px] text-sm text-smoke-700" aria-live="polite">
        {exceedsBalance ? (
          <span className="text-red-600">That&apos;s more than you hold.</span>
        ) : nothingToReclaim ? (
          'This project currently has nothing to reclaim for cash-outs.'
        ) : cashOutCount > 0n && quoteFailed ? (
          'Couldn’t get a quote right now — try again shortly.'
        ) : cashOutCount > 0n && route && route.expectedReturn > 0n ? (
          directSellWins
            ? `You'll receive ~${formatTokenAmount(directSellQuote!, receiveDecimals)} ${receiveSymbol} via a direct pool sale, which beats ~${formatTokenAmount(route.expectedReturn, receiveDecimals)} ${receiveSymbol} from cashing out`
            : `You'll receive ~${formatTokenAmount(route.expectedReturn, receiveDecimals)} ${receiveSymbol}`
        ) : cashOutCount > 0n && quoteLoading ? (
          'Getting your quote…'
        ) : null}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="shrink-0 text-xs font-medium text-smoke-700">Max slippage</span>
        {SLIPPAGE_PRESETS_BPS.map(bps => (
          <button
            key={bps}
            onClick={() => setSlippageBps(bps)}
            aria-pressed={slippageBps === bps}
            className={`px-2.5 py-0.5 text-[11px] ${
              slippageBps === bps
                ? 'inline-flex items-center justify-center rounded-lg border border-bluebs-500 bg-bluebs-25 font-medium text-bluebs-700'
                : 'btn-secondary'
            }`}
          >
            {bps / 100}%
          </button>
        ))}
        <label className="input-well !flex !h-7 !w-[76px] shrink-0 items-center px-2 text-[11px] text-smoke-700">
          <span className="sr-only">Custom max slippage percent</span>
          <input
            type="number"
            min="0"
            max="99.99"
            step="0.1"
            inputMode="decimal"
            value={slippageBps / 100}
            onChange={(event) => {
              const percent = Number(event.target.value)
              if (Number.isFinite(percent) && percent >= 0 && percent < 100) {
                setSlippageBps(Math.round(percent * 100))
              }
            }}
            className="min-w-0 flex-1 border-0 bg-transparent p-0 text-right outline-none ring-0 focus:border-0 focus:ring-0"
          />
          <span>%</span>
        </label>
      </div>

      {!directSellWins && poolBufferBps !== null ? (
        <p className="mt-2 text-xs text-smoke-700">
          This pool&apos;s preview already allows about{' '}
          {(poolBufferBps / 100).toFixed(2).replace(/\.00$/, '')}% for its fee
          and price impact. Your {slippageBps / 100}% setting additionally
          covers movement before the transaction lands.
        </p>
      ) : null}

      <div className="mt-5 flex justify-end">
        <button
          onClick={() => void review()}
          disabled={
            busy ||
            preparing ||
            (isConnected &&
              (cashOutCount <= 0n ||
                exceedsBalance ||
                !route ||
                directSellLoading ||
                route.expectedReturn <= 0n))
          }
          className="btn-primary min-h-[44px] px-5 text-sm"
        >
          {!isConnected
            ? 'Sign in to cash out'
            : cashOutCount > 0n
              ? directSellWins
                ? `Sell ${debouncedAmount.trim()} ${holdingsSymbol} on the pool`
                : `Cash out ${debouncedAmount.trim()} ${holdingsSymbol}`
              : 'Cash out'}
        </button>
      </div>

      {!exceedsBalance &&
      !nothingToReclaim &&
      cashOutCount > 0n &&
      route &&
      route.expectedReturn > 0n ? (
        <p className="mt-3 text-center text-xs text-smoke-700">
          You&apos;ll receive at least{' '}
          {formatTokenAmount(
            bestRoute?.minimumReturn ?? route.minimumReturn,
            receiveDecimals,
          )}{' '}
          {receiveSymbol}, or the transaction reverts.
        </p>
      ) : null}

      <TxError error={plan ? null : (errorMsg ?? tx.error)} />
      {confirmDialog}
    </div>
  )
}
