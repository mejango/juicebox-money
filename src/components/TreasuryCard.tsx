'use client'

import {
  JB_CHAINS,
  JBCoreContracts,
  NATIVE_TOKEN,
  jbContractAddress,
  jbTokensAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import {
  buildPayTx,
  getTokenAddress,
  previewPay,
  resolvePaymentTerminal,
} from '@bananapus/nana-sdk-core/v6'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import {
  BaseError,
  erc20Abi,
  formatUnits,
  parseEther,
  zeroAddress,
  type PublicClient,
} from 'viem'
import {
  usePublicClient,
  useReadContract,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi'
import { useWallet } from '@/hooks/useWallet'
import {
  buildCashOutRequest,
  getCashOutContext,
  getContextCashOutQuote,
  isNativeToken,
  minReclaimedFloor,
} from '@/lib/cashOut'
import { formatTokenAmount, truncateAddress } from '@/lib/format'

type Tab = 'pay' | 'cashOut'

/**
 * The project page's treasury card: a two-tab island for putting funds in
 * ("Pay") and taking your share back out ("Cash out").
 */
export function TreasuryCard({
  chainId,
  projectId,
  projectName,
  accountingToken,
  accountingTokenSymbol,
}: {
  chainId: JBChainId
  projectId: number
  projectName: string
  /** The accounting token's address per bendystraw. */
  accountingToken?: string | null
  /** The accounting token's symbol per bendystraw (e.g. "ETH", "USDC"). */
  accountingTokenSymbol?: string | null
}) {
  const [tab, setTab] = useState<Tab>('pay')

  const tabClass = (active: boolean) =>
    `min-h-[40px] rounded-[3px] font-pixel text-xs uppercase tracking-wider transition-colors ${
      active
        ? 'bg-juice text-bg'
        : 'text-dim hover:text-ink'
    }`

  return (
    <div className="panel-juice p-6">
      <div
        role="tablist"
        aria-label="Treasury actions"
        className="grid grid-cols-2 gap-1 rounded border-2 border-frame bg-well p-1"
      >
        <button
          role="tab"
          aria-selected={tab === 'pay'}
          onClick={() => setTab('pay')}
          className={tabClass(tab === 'pay')}
        >
          Pay
        </button>
        <button
          role="tab"
          aria-selected={tab === 'cashOut'}
          onClick={() => setTab('cashOut')}
          className={tabClass(tab === 'cashOut')}
        >
          Cash out
        </button>
      </div>

      <div className="mt-5">
        {tab === 'pay' ? (
          <PayPanel
            chainId={chainId}
            projectId={projectId}
            projectName={projectName}
          />
        ) : (
          <CashOutPanel
            chainId={chainId}
            projectId={projectId}
            projectName={projectName}
            accountingToken={accountingToken}
            accountingTokenSymbol={accountingTokenSymbol}
            onGoToPay={() => setTab('pay')}
          />
        )}
      </div>
    </div>
  )
}

function PayPanel({
  chainId,
  projectId,
  projectName,
}: {
  chainId: JBChainId
  projectId: number
  projectName: string
}) {
  const { isConnected, address, openSignIn } = useWallet()
  const publicClient = usePublicClient({ chainId }) as
    | PublicClient
    | undefined
  const { switchChainAsync } = useSwitchChain()
  const { writeContractAsync } = useWriteContract()

  const [amount, setAmount] = useState('')
  const [debouncedAmount, setDebouncedAmount] = useState('')
  const [memo, setMemo] = useState('')
  const [showMemo, setShowMemo] = useState(false)
  const [sending, setSending] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>()

  useEffect(() => {
    const t = setTimeout(() => setDebouncedAmount(amount), 400)
    return () => clearTimeout(t)
  }, [amount])

  const amountWei = useMemo(() => {
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

  const { data: terminal } = useQuery({
    queryKey: ['terminal', chainId, projectId],
    enabled: !!publicClient,
    staleTime: 5 * 60_000,
    retry: 1,
    queryFn: () =>
      resolvePaymentTerminal(publicClient!, {
        chainId,
        projectId: BigInt(projectId),
        token: NATIVE_TOKEN,
      }),
  })

  const { data: preview, isFetching: previewLoading } = useQuery({
    queryKey: ['previewPay', chainId, projectId, amountWei.toString()],
    enabled: !!publicClient && !!terminal && amountWei > 0n,
    retry: false,
    queryFn: () =>
      previewPay(publicClient!, {
        chainId,
        terminal: terminal!.address,
        projectId: BigInt(projectId),
        token: NATIVE_TOKEN,
        amount: amountWei,
        beneficiary: address ?? zeroAddress,
      }),
  })

  const receipt = useWaitForTransactionReceipt({ hash: txHash, chainId })
  const mining = !!txHash && receipt.isLoading
  const success = !!txHash && receipt.isSuccess

  const txUrl = txHash
    ? `https://${chainMeta?.etherscanHostname}/tx/${txHash}`
    : null

  const pay = async () => {
    if (!isConnected || !address) {
      openSignIn()
      return
    }
    if (!terminal || amountWei <= 0n || sending) return
    setErrorMsg(null)
    setSending(true)
    try {
      await switchChainAsync({ chainId })
      const request = buildPayTx({
        chainId,
        terminal: terminal.address,
        projectId: BigInt(projectId),
        token: NATIVE_TOKEN,
        amount: amountWei,
        beneficiary: address,
        memo: memo.trim() || undefined,
      })
      const hash = await writeContractAsync(request)
      setTxHash(hash)
    } catch (e) {
      const message =
        e instanceof BaseError
          ? e.shortMessage
          : e instanceof Error
            ? e.message
            : 'Something went wrong.'
      // User rejections don't need a scary error banner.
      setErrorMsg(/reject|denied|cancel/i.test(message) ? null : message)
    } finally {
      setSending(false)
    }
  }

  const reset = () => {
    setTxHash(undefined)
    setAmount('')
    setDebouncedAmount('')
    setMemo('')
    setShowMemo(false)
    setErrorMsg(null)
  }

  if (success) {
    return (
      <div className="flex flex-col items-center py-4 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded border-2 border-lime">
          <svg
            viewBox="0 0 24 24"
            className="h-7 w-7 text-lime"
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
        <h3 className="mt-4 font-display text-lg font-bold">Payment sent!</h3>
        <p className="mt-1 text-sm text-dim">
          Thanks for supporting {projectName}.
        </p>
        <div className="mt-5 flex gap-3 text-sm font-semibold">
          {txUrl ? (
            <a
              href={txUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-juice underline underline-offset-2 hover:text-juice-500"
            >
              View transaction
            </a>
          ) : null}
          <button onClick={reset} className="text-dim hover:text-ink">
            Pay again
          </button>
        </div>
      </div>
    )
  }

  return (
    <div>
      <h3 className="font-display text-lg font-bold">Support this project</h3>
      <label className="mt-4 block">
        <span className="silk-label">Amount</span>
        <div className="input-well mt-1.5 flex items-center px-4">
          <input
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            placeholder="0.01"
            aria-label={`Amount in ${nativeSymbol}`}
            className="min-h-[52px] w-full bg-transparent text-xl font-semibold outline-none placeholder:text-dim/50"
          />
          <span className="ml-2 shrink-0 font-semibold text-dim">
            {nativeSymbol}
          </span>
        </div>
      </label>

      <div className="mt-2 min-h-[20px] text-sm text-dim" aria-live="polite">
        {amountWei > 0n && preview
          ? `You'll get ~${formatTokenAmount(preview.beneficiaryTokenCount, 18, 2)} tokens`
          : amountWei > 0n && previewLoading
            ? 'Getting your quote…'
            : null}
      </div>

      {showMemo ? (
        <label className="mt-2 block">
          <span className="silk-label">Note</span>
          <input
            type="text"
            value={memo}
            onChange={e => setMemo(e.target.value.slice(0, 256))}
            placeholder="Say something nice (onchain, public)"
            className="input-well mt-1.5 min-h-[44px] px-4 text-sm"
          />
        </label>
      ) : (
        <button
          onClick={() => setShowMemo(true)}
          className="mt-1 font-pixel text-[11px] uppercase tracking-wider text-dim hover:text-ink"
        >
          + Add a note
        </button>
      )}

      <button
        onClick={pay}
        disabled={sending || mining || (isConnected && amountWei <= 0n)}
        className="btn-juice mt-5 min-h-[52px] w-full text-sm"
      >
        {sending
          ? 'Confirm in your wallet…'
          : mining
            ? 'Sending…'
            : !isConnected
              ? 'Sign in to pay'
              : amountWei > 0n
                ? `Pay ${debouncedAmount.trim()} ${nativeSymbol}`
                : 'Pay'}
      </button>

      {mining && txUrl ? (
        <p className="mt-3 text-center text-sm text-dim">
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
      {errorMsg ? (
        <p className="mt-3 rounded border-2 border-red-400/40 bg-well px-3 py-2 text-sm text-red-300">
          {errorMsg}
        </p>
      ) : null}
    </div>
  )
}

function CashOutPanel({
  chainId,
  projectId,
  projectName,
  accountingToken,
  accountingTokenSymbol,
  onGoToPay,
}: {
  chainId: JBChainId
  projectId: number
  projectName: string
  accountingToken?: string | null
  accountingTokenSymbol?: string | null
  onGoToPay: () => void
}) {
  const { isConnected, address, openSignIn } = useWallet()
  const publicClient = usePublicClient({ chainId }) as
    | PublicClient
    | undefined
  const { switchChainAsync } = useSwitchChain()
  const { writeContractAsync } = useWriteContract()

  const [amount, setAmount] = useState('')
  const [debouncedAmount, setDebouncedAmount] = useState('')
  const [sending, setSending] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>()

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
  const { data: erc20Symbol } = useQuery({
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
      return publicClient!.readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'symbol',
      })
    },
  })
  const holdingsSymbol = erc20Symbol ?? 'tokens'

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

  const {
    data: quote,
    isFetching: quoteLoading,
    isError: quoteFailed,
  } = useQuery({
    queryKey: ['cashOutQuote', chainId, projectId, cashOutCount.toString()],
    enabled: !!publicClient && !!context && cashOutCount > 0n,
    retry: false,
    queryFn: () =>
      getContextCashOutQuote(publicClient!, {
        chainId,
        projectId: BigInt(projectId),
        cashOutCount,
        context: context!,
      }),
  })

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
    quote !== undefined &&
    quote.reclaimAmountAfterFee <= 0n

  const receipt = useWaitForTransactionReceipt({ hash: txHash, chainId })
  const mining = !!txHash && receipt.isLoading
  const success = !!txHash && receipt.isSuccess

  useEffect(() => {
    if (success) refetchBalance()
  }, [success, refetchBalance])

  const txUrl = txHash
    ? `https://${chainMeta?.etherscanHostname}/tx/${txHash}`
    : null

  const setMax = () => {
    if (balance === undefined || balance <= 0n) return
    const max = formatUnits(balance, 18)
    setAmount(max)
    setDebouncedAmount(max)
  }

  const cashOut = async () => {
    if (!isConnected || !address) {
      openSignIn()
      return
    }
    if (
      !terminal ||
      !context ||
      !quote ||
      quote.reclaimAmountAfterFee <= 0n ||
      cashOutCount <= 0n ||
      exceedsBalance ||
      sending
    )
      return
    setErrorMsg(null)
    setSending(true)
    try {
      await switchChainAsync({ chainId })
      const request = buildCashOutRequest({
        chainId,
        terminal: terminal.address,
        holder: address,
        projectId: BigInt(projectId),
        cashOutCount,
        tokenToReclaim: context.token,
        quote,
        beneficiary: address,
      })
      const hash = await writeContractAsync(request)
      setTxHash(hash)
    } catch (e) {
      const message =
        e instanceof BaseError
          ? e.shortMessage
          : e instanceof Error
            ? e.message
            : 'Something went wrong.'
      // User rejections don't need a scary error banner.
      setErrorMsg(/reject|denied|cancel/i.test(message) ? null : message)
    } finally {
      setSending(false)
    }
  }

  const reset = () => {
    setTxHash(undefined)
    setAmount('')
    setDebouncedAmount('')
    setErrorMsg(null)
  }

  if (success) {
    return (
      <div className="flex flex-col items-center py-4 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded border-2 border-lime">
          <svg
            viewBox="0 0 24 24"
            className="h-7 w-7 text-lime"
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
        <h3 className="mt-4 font-display text-lg font-bold">Cashed out!</h3>
        <p className="mt-1 text-sm text-dim">
          Your share of {projectName}&apos;s treasury is on its way.
        </p>
        <div className="mt-5 flex gap-3 text-sm font-semibold">
          {txUrl ? (
            <a
              href={txUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-juice underline underline-offset-2 hover:text-juice-500"
            >
              View transaction
            </a>
          ) : null}
          <button onClick={reset} className="text-dim hover:text-ink">
            Cash out again
          </button>
        </div>
      </div>
    )
  }

  return (
    <div>
      <h3 className="font-display text-lg font-bold">Cash out your tokens</h3>

      <div className="mt-2 min-h-[20px] text-sm text-dim" aria-live="polite">
        {!isConnected ? (
          'Sign in to see your balance.'
        ) : zeroBalance ? (
          <>
            You don&apos;t hold this project&apos;s tokens yet —{' '}
            <button
              onClick={onGoToPay}
              className="font-semibold text-juice underline underline-offset-2 hover:text-juice-500"
            >
              pay to get some
            </button>
            .
          </>
        ) : balance !== undefined ? (
          <span className="flex items-center gap-2">
            You hold {formatTokenAmount(balance, 18)} {holdingsSymbol}
            <button
              onClick={setMax}
              className="btn-pixel px-2 py-0.5 text-[10px]"
            >
              MAX
            </button>
          </span>
        ) : (
          'Checking your balance…'
        )}
      </div>

      <label className="mt-3 block">
        <span className="silk-label">
          Amount to cash out
        </span>
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
            className="min-h-[52px] w-full bg-transparent text-xl font-semibold outline-none placeholder:text-dim/50 disabled:cursor-not-allowed"
          />
          <span className="ml-2 shrink-0 font-semibold text-dim">
            {holdingsSymbol}
          </span>
        </div>
      </label>

      <div className="mt-2 min-h-[20px] text-sm text-dim" aria-live="polite">
        {exceedsBalance ? (
          <span className="text-red-400">
            That&apos;s more than you hold.
          </span>
        ) : nothingToReclaim ? (
          'This project currently has nothing to reclaim for cash-outs.'
        ) : cashOutCount > 0n && quoteFailed ? (
          'Couldn’t get a quote right now — try again shortly.'
        ) : cashOutCount > 0n && quote && quote.reclaimAmountAfterFee > 0n ? (
          `You'll receive ~${formatTokenAmount(quote.reclaimAmountAfterFee, receiveDecimals)} ${receiveSymbol}`
        ) : cashOutCount > 0n && quoteLoading ? (
          'Getting your quote…'
        ) : null}
      </div>

      <button
        onClick={cashOut}
        disabled={
          sending ||
          mining ||
          (isConnected &&
            (cashOutCount <= 0n ||
              exceedsBalance ||
              !quote ||
              quote.reclaimAmountAfterFee <= 0n))
        }
        className="btn-juice mt-5 min-h-[52px] w-full text-sm"
      >
        {sending
          ? 'Confirm in your wallet…'
          : mining
            ? 'Cashing out…'
            : !isConnected
              ? 'Sign in to cash out'
              : cashOutCount > 0n
                ? `Cash out ${debouncedAmount.trim()} ${holdingsSymbol}`
                : 'Cash out'}
      </button>

      {!exceedsBalance &&
      !nothingToReclaim &&
      cashOutCount > 0n &&
      quote &&
      quote.reclaimAmountAfterFee > 0n ? (
        <p className="mt-3 text-center text-xs text-dim/80">
          You&apos;ll receive at least{' '}
          {formatTokenAmount(minReclaimedFloor(quote), receiveDecimals)}{' '}
          {receiveSymbol}, or the transaction reverts.
        </p>
      ) : null}

      {mining && txUrl ? (
        <p className="mt-3 text-center text-sm text-dim">
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
      {errorMsg ? (
        <p className="mt-3 rounded border-2 border-red-400/40 bg-well px-3 py-2 text-sm text-red-300">
          {errorMsg}
        </p>
      ) : null}
    </div>
  )
}
