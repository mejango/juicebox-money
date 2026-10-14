'use client'

import dynamic from 'next/dynamic'
import { useSyncExternalStore } from 'react'
import { heldWritesSnapshot, subscribeHeldWrites } from '@/lib/held-writes-registry'

const HeldWritesList = dynamic(() => import('@/components/ui/HeldWritesList'), { ssr: false })

/**
 * Writes held outside a flow's own dialog (authority calls, Safe batches),
 * shown app-wide: each with the hold's line and, when a fresh look at the
 * chain offers it, the exit. After the exit the user starts the action again.
 * The list loads only once a write is held.
 */
export function HeldWritesNotice() {
  const held = useSyncExternalStore(subscribeHeldWrites, heldWritesSnapshot, () => [])
  return held.length ? <HeldWritesList /> : null
}
