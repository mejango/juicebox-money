'use client'

import { projectDisplayQuery } from '@/lib/project-display-queries'
import {
  JB_CHAINS,
  JBCoreContracts,
  jbV6ContractAddress,
  jbTokensAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import {
  buildPermit2ApproveTx,
  buildUniswapV4ExactInputSwapTx,
  chooseBestCashOutRoute,
  getCashOutDelay,
  getHookAwareCashOutQuote,
  getTokenAddress,
  prepareHookAwareCashOut,
  quoteUniswapV4ExactInputSingle,
  resolvePaymentTerminal,
  uniswapV4Deployment,
  uniswapV4SwapDirection,
} from '@bananapus/nana-sdk-core/v6'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
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
import { reviewedCall, useReviewedAction, type TxRequest } from '@/hooks/useReviewedAction'
import { useStepRun, type StepRunAction } from '@/hooks/useStepRun'
import { useViewedAccount } from '@/hooks/useViewedAccount'
import { useWallet } from '@/hooks/useWallet'
import { contextRows, TxProgress, type TxConfirmRow } from '@/components/ui/TxProgress'
import { TxError } from '@/components/ui/TxError'
import {
  cashOutExecutionErrorMessage,
  cashOutPoolBufferBps,
  getCashOutContext,
  minimumDropNotice,
} from '@/lib/cashOut'
import { buildErc20ApproveRequest as buildTokenApproval } from '@/lib/transaction-builders'
import { approvalIntent, cashOutIntent } from '@bananapus/nana-sdk-core/review'
import { legacyCashOutKeys } from '@/lib/legacy-intents'
import { formatDate, etherscanTxUrl, formatTokenAmount } from '@/lib/format'
import { tokenSymbol } from '@/lib/token-symbol'
import { resolveMarket } from '@/components/project/MarketSection'
import { AllowedDecreaseField } from '@/components/project/AllowedDecreaseField'
import { swapDeadline } from '@/lib/safe-connector'
import { chainName } from '@/lib/urn'

const DEFAULT_SLIPPAGE_BPS = 100

/**
 * The reviewed exit, frozen when the dialog opens. A treasury cash-out is
 * prepared from fresh protocol state and sent exactly as frozen; a pool sale
 * freezes the floor it promises and re-quotes once its approvals clear, since
 * the swap's deadline and the pool comparison cannot be locked before them.
 * Either way it spends `account`'s tokens and pays `account`, so only that
 * account may send it.
 */
type CashOutPlan = { account: Address; minimumReturn: bigint } & (
  | {
      kind: 'treasury'
      request: TxRequest
      venue: 'treasury' | 'amm'
      fee: bigint
      reviewNotice: string | undefined
    }
  | { kind: 'pool' }
)

/**
 * The cash-out flow (JBMultiTerminal.cashOutTokensOf), extracted from
 * TreasuryCard so both the treasury card and the Accounts (YOU) card render
 * the same panel. Every write goes through the reviewed send (simulate-first) and the
 * SDK's hook-aware slippage-protected route — a zero floor never sends.
 *
 * Rendered bare (no card chrome): the caller wraps it.
 */
export function CashOutPanel({
  chainId,
  projectId,
  projectName,
  onGoToPay,
  showHeading = true,
}: {
  chainId: JBChainId
  projectId: number
  projectName?: string
  /** Switch to the Pay tab, when the host has one. */
  onGoToPay?: () => void
  /** The modal host supplies the dialog title. */
  showHeading?: boolean
}) {
  const { isConnected, address, openSignIn } = useWallet()
  // Balance and quote read for the account on screen; every send stays with the connected wallet.
  const { address: viewed, isViewAs } = useViewedAccount()
  const publicClient = usePublicClient({ chainId }) as PublicClient | undefined
  const queryClient = useQueryClient()
  const tx = useReviewedAction(chainId)
  /** The pool sale's calls, built from a fresh quote when it starts. */
  const runCalls = useRef<StepRunAction | null>(null)
  // Each approval the pool sale needs, then the sale.
  const run = useStepRun<string>({ tx, send: tx.run, action: () => runCalls.current, onFinish: () => {} })

  const [amount, setAmount] = useState('')
  const [debouncedAmount, setDebouncedAmount] = useState('')
  const [slippageBps, setSlippageBps] = useState(DEFAULT_SLIPPAGE_BPS)
  const [customSlippage, setCustomSlippage] = useState(false)
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
    address: jbV6ContractAddress[JBCoreContracts.JBTokens][chainId],
    functionName: 'totalBalanceOf',
    args: [viewed ?? zeroAddress, BigInt(projectId)],
    chainId,
    query: { enabled: !!viewed },
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
      viewed ?? zeroAddress,
      slippageBps,
    ],
    enabled: !!publicClient && !!context && !!terminal && cashOutCount > 0n,
    retry: false,
    queryFn: () =>
      getHookAwareCashOutQuote(publicClient!, {
        chainId,
        projectId: BigInt(projectId),
        holder: viewed ?? zeroAddress,
        cashOutCount,
        tokenToReclaim: context!.token,
        terminal: terminal!.address,
        slippageBps: BigInt(slippageBps),
      }),
  })

  // Claimed project tokens can be sold directly into the buyback pool. This
  // bypasses the terminal fee, so compare its protected output against the
  // hook-aware terminal route and offer it only when it is strictly better.
  const { data: market } = useQuery(projectDisplayQuery(queryClient, {
    staleTime: 30000,
    queryKey: ['cashOutMarket', chainId, projectId],
    enabled: !!publicClient && !!projectToken,

    retry: false,
    queryFn: (reader) =>
      resolveMarket(publicClient!, chainId, projectId, nativeSymbol, reader),
  }))
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
    queryKey: ['claimedCashOutBalance', chainId, projectToken?.address, viewed],
    enabled: !!publicClient && !!projectToken && !!viewed,
    staleTime: 15_000,
    queryFn: () =>
      publicClient!.readContract({
        address: projectToken!.address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [viewed!],
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

  // A revnet's cash out delay makes the terminal quote fail; say why instead of "try again shortly".
  const { data: cashOutDelay } = useQuery({
    queryKey: ['cashOutDelay', chainId, projectId],
    enabled: !!publicClient,
    staleTime: 60_000,
    retry: 1,
    queryFn: () => getCashOutDelay(publicClient!, { chainId, revnetId: BigInt(projectId) }),
  })
  const delayActive = !!cashOutDelay && cashOutDelay > BigInt(Math.floor(Date.now() / 1000))
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
  /** The pool sale's approvals these allowances leave to send: the token's for Permit2, then Permit2's for the router. */
  const approvalsNeeded = (token: bigint | undefined, permit2: typeof permit2Allowance) => ({
    token: directSellWins && (token ?? 0n) < cashOutCount,
    router:
      directSellWins &&
      (!permit2 ||
        permit2[0] < cashOutCount ||
        Number(permit2[1]) <= Math.floor(Date.now() / 1000) + 1_800),
  })
  const { token: needsTokenApproval, router: needsRouterApproval } = approvalsNeeded(tokenAllowance, permit2Allowance)

  useEffect(() => {
    if (tx.phase === 'done') {
      void refetchTokenAllowance()
      void refetchPermit2Allowance()
    }
  }, [tx.phase, refetchTokenAllowance, refetchPermit2Allowance])

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

  const { data: receiveSymbolRead } = useQuery({
    queryKey: ['cashOutReceiveSymbol', chainId, context?.token],
    enabled: !!publicClient && !!context,
    staleTime: 5 * 60_000,
    queryFn: () => tokenSymbol(publicClient!, context!.token as Address, { chainId, nativeSymbol }),
  })
  const receiveSymbol = receiveSymbolRead ?? ''
  const receiveDecimals = context?.decimals ?? 18
  const minimumLine = route
    ? `${formatTokenAmount(bestRoute?.minimumReturn ?? route.minimumReturn, receiveDecimals)} ${receiveSymbol}`
    : ''

  const zeroBalance = !!viewed && balance === 0n
  const exceedsBalance =
    balance !== undefined && cashOutCount > 0n && cashOutCount > balance
  const nothingToReclaim =
    cashOutCount > 0n &&
    !quoteLoading &&
    route !== undefined &&
    route.expectedReturn <= 0n

  const busy = run.running || tx.busy
  const finalSent = tx.lastStepSent
  const success = tx.phase === 'done' && finalSent
  /** A Safe executed an approval it was proposed: the sale is reviewed next. */
  const approvalOnly = (tx.phase === 'done' && !finalSent) || tx.settledStep != null

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
            detail: 'Let Permit2, the token approval contract, move this amount for the sale.',
          }
        : {
            key: 'router',
            title: 'Authorize the swap router',
            detail: 'Let the trading contract spend up to this amount for 30 days.',
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
    : run.steps
      ? run.index
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
    if (isViewAs) return
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
      setPlan({ kind: 'pool', minimumReturn: displayedMinimum, account: address })
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
        account: address,
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

  /** What the cash-out's review shows above its calls. */
  const reviewRows = (plan: CashOutPlan): TxConfirmRow[] => {
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
          ? 'Sell on the market'
          : plan.venue === 'amm'
            ? 'Market trade through the payment contract'
            : 'Project balance',
    })
    return rows
  }

  const cashOut = async () => {
    if (!plan || !address || busy) return
    setErrorMsg(null)
    const reviewedAccount = plan.account
    // One cash-out of what the user typed, whatever venue (pool or terminal) serves it.
    const cashOutKey = cashOutIntent({ chainId, project: projectId, holder: reviewedAccount, beneficiary: reviewedAccount })
    // The last release's keys for this cash-out: an attempt it left unresolved still holds it.
    const cashOutLegacy = legacyCashOutKeys({ chainId, projectId, amount, beneficiary: reviewedAccount })
    try {
      if (plan.kind === 'pool') {
        if (market?.status !== 'pool' || !projectToken || !swapDeployment) {
          throw new Error('No direct sell route is available.')
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
          recipient: reviewedAccount,
          deadline: swapDeadline(tx.isSafe),
        })
        // The allowances as the chain shows them now: an approval an earlier attempt confirmed is not asked for again.
        const [tokenNow, permit2Now] = await Promise.all([refetchTokenAllowance(), refetchPermit2Allowance()])
        const needed = approvalsNeeded(tokenNow.data ?? tokenAllowance, permit2Now.data ?? permit2Allowance)
        // Each approval the sale needs, then the sale: one review and one run, each step simulated where the one before it landed.
        const routerApproval = buildPermit2ApproveTx({
          chainId,
          token: projectToken.address,
          amount: cashOutCount,
          expiration: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
        })
        const approvals = [
          ...(needed.token ? [reviewedCall(
            buildTokenApproval({
              chainId,
              token: projectToken.address,
              spender: swapDeployment.permit2,
              amount: cashOutCount,
            }),
            { intent: approvalIntent(cashOutKey, { step: 'token-approval', token: projectToken.address, spender: swapDeployment.permit2 }) },
          )] : []),
          ...(needed.router ? [reviewedCall(
            {
              ...routerApproval,
              args: routerApproval.args as unknown as readonly unknown[],
              label: 'Approve swap router',
            },
            { intent: approvalIntent(cashOutKey, { step: 'router-approval', token: projectToken.address, spender: routerApproval.args[1] as string }) },
          )] : []),
        ]
        const sale = reviewedCall(
          {
            ...request,
            args: request.args as unknown as readonly unknown[],
            label:
              'Sell claimed project tokens through the best available pool route',
          },
          {
            // Its deadline and minimum regenerate on retry: held by what the user chose.
            intent: cashOutKey,
            legacy: cashOutLegacy,
          },
        )
        runCalls.current = {
          account: reviewedAccount,
          calls: [...approvals, sale],
          scope: `jbm:cash-out:${chainId}:${projectId}`,
          context: contextRows(reviewRows(plan)),
          description: minimumDropNotice({
            displayedMinimum: plan.minimumReturn,
            freshMinimum: refreshedBest.minimumReturn,
            decimals: receiveDecimals,
            symbol: receiveSymbol,
          }),
        }
        setUsedDirectSell(true)
        // The sale is always the queue's last step.
        await run.start(cashOutSteps.map(step => step.key))
        return
      }
      // The terminal route is not a pool sale — clear any flag left by an
      // earlier attempt so the success copy names the route actually taken.
      setUsedDirectSell(false)
      await tx.run({
        account: reviewedAccount,
        // Its minimum re-quotes on retry: held by what the user chose.
        calls: [reviewedCall(plan.request, { intent: cashOutKey, legacy: cashOutLegacy })],
        context: contextRows(reviewRows(plan)),
        description: plan.reviewNotice,
      })
    } catch (e) {
      setErrorMsg(cashOutExecutionErrorMessage(e))
    }
  }

  const reset = () => {
    run.clear()
    setAmount('')
    setDebouncedAmount('')
    setErrorMsg(null)
    setUsedDirectSell(false)
  }

  const closeReview = () => {
    setPlan(null)
    setErrorMsg(null)
    if (success) return
    run.clear()
  }

  const confirmDialog = plan ? (
    <TxProgress
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
      rows={reviewRows(plan)}
      steps={cashOutSteps}
      activeIndex={cashOutActiveIndex}
      busy={busy}
      complete={success || tx.phase === 'proposed' || tx.phase === 'held'}
      status={
        approvalOnly ? 'Approval confirmed. Continue to the sale.'
        : tx.notice ? (
          tx.notice
        ) : tx.phase === 'receipt' && txUrl ? (
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
      error={errorMsg ?? tx.error}
      onClose={closeReview}
      start={() => void cashOut()}
      next={!busy && !success && (approvalOnly || !!(errorMsg ?? tx.error)) ? { label: approvalOnly ? 'Continue' : 'Try again', onClick: () => void cashOut() } : null}
    />
  ) : preparing ? (
    <TxProgress
      open
      preparing
      title="Confirm cash out"
      steps={[]}
      activeIndex={-1}
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
            ? `Your ${holdingsSymbol} were sold on the market.`
            : `Your cash out from ${projectName ?? 'the project'} is confirmed.`}
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
          {balance !== undefined && balance > 0n ? (
            <button
              type="button"
              onClick={setMax}
              className="btn-secondary ml-3 px-2.5 py-0.5 text-[11px]"
            >
              Max
            </button>
          ) : null}
        </div>
      </label>

      <div className="mt-2 min-h-[20px] text-xs text-smoke-700" aria-live="polite">
        {!viewed ? (
          'Sign in to see your balance.'
        ) : zeroBalance ? (
          onGoToPay ? (
            <>
              You don&apos;t hold this project&apos;s tokens yet.{' '}
              <button
                onClick={onGoToPay}
                className="font-medium text-bluebs-600 underline underline-offset-2 hover:text-bluebs-700"
              >
                Pay to get some
              </button>
            </>
          ) : (
            "You don't hold this project's tokens yet."
          )
        ) : balance !== undefined ? (
          `You hold ${formatTokenAmount(balance, 18)} ${holdingsSymbol}.`
        ) : (
          'Checking your balance…'
        )}
      </div>

      <div className="mt-3 text-xs text-smoke-700">
        <label className="flex min-h-[28px] cursor-pointer items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            checked={customSlippage}
            onChange={event => {
              if (!event.target.checked) setSlippageBps(DEFAULT_SLIPPAGE_BPS)
              setCustomSlippage(event.target.checked)
            }}
          />
          Change the allowed decrease ({slippageBps / 100}%)
        </label>
        {customSlippage ? <AllowedDecreaseField bps={slippageBps} onChange={setSlippageBps} hideLabel /> : null}
        {!directSellWins && poolBufferBps !== null ? (
          <p className="mt-2">
            This quote already allows about{' '}
            {(poolBufferBps / 100).toFixed(2).replace(/\.00$/, '')}% for the pool&apos;s fee and price change.
          </p>
        ) : null}
      </div>

      <div className="mt-4 min-h-[20px] text-sm text-smoke-700" aria-live="polite">
        {exceedsBalance ? (
          <span className="text-red-600">That&apos;s more than you hold.</span>
        ) : nothingToReclaim ? (
          'The current cash-out quote returns no funds.'
        ) : cashOutCount > 0n && quoteFailed && delayActive ? (
          `Cash outs are locked until this revnet’s cash out delay passes (${formatDate(Number(cashOutDelay))}).`
        ) : cashOutCount > 0n && quoteFailed ? (
          'Couldn’t get a quote right now. Try again shortly.'
        ) : cashOutCount > 0n && route && route.expectedReturn > 0n ? (
          directSellWins
            ? `Selling on the market: ~${formatTokenAmount(directSellQuote!, receiveDecimals)} ${receiveSymbol}, at least ${minimumLine}. Cashing out: ~${formatTokenAmount(route.expectedReturn, receiveDecimals)} ${receiveSymbol}.`
            : `You'll receive ~${formatTokenAmount(route.expectedReturn, receiveDecimals)} ${receiveSymbol}${route.route === 'treasury' ? ' after fees' : ''}, at least ${minimumLine}.`
        ) : cashOutCount > 0n && quoteLoading ? (
          'Getting your quote…'
        ) : null}
      </div>

      <div className="mt-3 flex justify-end">
        <button
          onClick={() => void review()}
          disabled={
            busy ||
            preparing ||
            isViewAs ||
            (isConnected &&
              (cashOutCount <= 0n ||
                exceedsBalance ||
                !route ||
                directSellLoading ||
                route.expectedReturn <= 0n))
          }
          className="btn-primary min-h-[44px] px-5 text-sm"
        >
          {isViewAs
            ? 'Exit View as to cash out'
            : !isConnected
            ? 'Sign in to cash out'
            : cashOutCount > 0n
              ? directSellWins
                ? `Sell ${debouncedAmount.trim()} ${holdingsSymbol} on the pool`
                : `Cash out ${debouncedAmount.trim()} ${holdingsSymbol}`
              : 'Cash out'}
        </button>
      </div>

      <TxError error={plan ? null : (errorMsg ?? tx.error)} />
      {confirmDialog}
    </div>
  )
}
