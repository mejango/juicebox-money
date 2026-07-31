'use client'

import Image from 'next/image'
import { useEffect } from 'react';
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
