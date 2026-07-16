'use client'

import {
  JB_CHAINS,
  NATIVE_TOKEN,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import {
  buildPayTx,
  previewPay,
  resolvePaymentTerminal,
} from '@bananapus/nana-sdk-core/v6'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import {
  BaseError,
  parseEther,
  zeroAddress,
  type PublicClient,
} from 'viem'
import {
  usePublicClient,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi'
import { useWallet } from '@/hooks/useWallet'
import { formatTokenAmount } from '@/lib/format'

export function PayCard({
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
      <div className="rounded-3xl border border-ink/10 bg-white p-6 shadow-sm">
        <div className="flex flex-col items-center py-4 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100">
            <svg
              viewBox="0 0 24 24"
              className="h-7 w-7 text-emerald-600"
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
          <h3 className="mt-4 text-lg font-bold">Payment sent!</h3>
          <p className="mt-1 text-sm text-ink/60">
            Thanks for supporting {projectName}.
          </p>
          <div className="mt-5 flex gap-3 text-sm font-semibold">
            {txUrl ? (
              <a
                href={txUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-juice-600 underline underline-offset-2 hover:text-juice-500"
              >
                View transaction
              </a>
            ) : null}
            <button onClick={reset} className="text-ink/60 hover:text-ink">
              Pay again
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-3xl border border-ink/10 bg-white p-6 shadow-sm">
      <h3 className="text-lg font-bold">Support this project</h3>
      <label className="mt-4 block">
        <span className="text-sm font-medium text-ink/60">Amount</span>
        <div className="mt-1.5 flex items-center rounded-2xl border border-ink/15 bg-cream/60 px-4 transition-colors focus-within:border-juice-500 focus-within:ring-2 focus-within:ring-juice-400/30">
          <input
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            placeholder="0.01"
            aria-label={`Amount in ${nativeSymbol}`}
            className="min-h-[52px] w-full bg-transparent text-xl font-semibold outline-none placeholder:text-ink/30"
          />
          <span className="ml-2 shrink-0 font-semibold text-ink/50">
            {nativeSymbol}
          </span>
        </div>
      </label>

      <div className="mt-2 min-h-[20px] text-sm text-ink/50" aria-live="polite">
        {amountWei > 0n && preview
          ? `You'll get ~${formatTokenAmount(preview.beneficiaryTokenCount, 18, 2)} tokens`
          : amountWei > 0n && previewLoading
            ? 'Getting your quote…'
            : null}
      </div>

      {showMemo ? (
        <label className="mt-2 block">
          <span className="text-sm font-medium text-ink/60">Note</span>
          <input
            type="text"
            value={memo}
            onChange={e => setMemo(e.target.value.slice(0, 256))}
            placeholder="Say something nice (onchain, public)"
            className="mt-1.5 min-h-[44px] w-full rounded-2xl border border-ink/15 bg-cream/60 px-4 text-sm outline-none transition-colors placeholder:text-ink/30 focus:border-juice-500 focus:ring-2 focus:ring-juice-400/30"
          />
        </label>
      ) : (
        <button
          onClick={() => setShowMemo(true)}
          className="mt-1 text-sm font-medium text-ink/50 hover:text-ink"
        >
          + Add a note
        </button>
      )}

      <button
        onClick={pay}
        disabled={sending || mining || (isConnected && amountWei <= 0n)}
        className="mt-5 min-h-[52px] w-full rounded-2xl bg-juice-500 text-base font-bold text-ink transition-colors hover:bg-juice-600 disabled:cursor-not-allowed disabled:opacity-50"
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
        <p className="mt-3 text-center text-sm text-ink/50">
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
        <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">
          {errorMsg}
        </p>
      ) : null}
    </div>
  )
}
