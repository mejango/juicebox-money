'use client'

import Image from 'next/image'
import { useEffect, type ReactNode } from 'react'
import transactionPending from '@/assets/illustrations/transaction-pending.webp'

let transactionAnimationPreloadStarted = false

/** Warm the animation before a transaction enters its pending state. */
export function usePreloadTransactionAnimation(enabled = true) {
  useEffect(() => {
    if (!enabled || transactionAnimationPreloadStarted) return
    transactionAnimationPreloadStarted = true
    const image = new window.Image()
    image.decoding = 'async'
    image.src = transactionPending.src
    image.onerror = () => {
      transactionAnimationPreloadStarted = false
    }
  }, [enabled])
}

export function TransactionProgressImage({
  className = 'h-12 w-12',
}: {
  className?: string
}) {
  return (
    <Image
      src={transactionPending}
      alt=""
      unoptimized
      aria-hidden
      className={`shrink-0 object-contain ${className}`}
    />
  )
}

export function TransactionInProgress({
  children,
  className = '',
}: {
  children?: ReactNode
  className?: string
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex items-center gap-3 rounded-xl border border-bluebs-100 bg-bluebs-25 px-3.5 py-3 ${className}`}
    >
      <TransactionProgressImage />
      <div className="min-w-0 text-sm leading-relaxed text-smoke-700">
        {children ?? 'Transaction submitted — waiting for confirmation.'}
      </div>
    </div>
  )
}
