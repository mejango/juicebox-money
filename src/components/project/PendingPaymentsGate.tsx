'use client'

import dynamic from 'next/dynamic'
import { useEffect, useState, useSyncExternalStore, type ComponentProps } from 'react'
import { useAccount } from 'wagmi'
import {
  hasSavedProjectBatch,
  LEGACY_PENDING_PAYMENT_ACTION,
  PENDING_PAYMENT_ACTION,
} from '@/lib/project-batch-keys'
import type { PendingPayments as Panel } from './PendingPayments'

const PendingPayments = dynamic(
  () => import('./PendingPayments').then(module => module.PendingPayments),
  { ssr: false },
)

const ACTIONS = [PENDING_PAYMENT_ACTION, LEGACY_PENDING_PAYMENT_ACTION]
const subscribe = (onChange: () => void) => {
  window.addEventListener('storage', onChange)
  return () => window.removeEventListener('storage', onChange)
}

/**
 * The pending-payments panel (its review, Relayr and recovery code) loads for
 * a connected wallet, or for a batch this browser saved, which must stay
 * resumable without a wallet. Once shown it stays mounted, so a disconnect
 * mid-flow keeps its state.
 */
export function PendingPaymentsGate(props: ComponentProps<typeof Panel>) {
  const { isConnected } = useAccount()
  const saved = useSyncExternalStore(subscribe, () => hasSavedProjectBatch(ACTIONS), () => false)
  const show = isConnected || saved
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (show) setShown(true)
  }, [show])
  return show || shown ? <PendingPayments {...props} /> : null
}
