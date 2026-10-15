'use client'

import dynamic from 'next/dynamic'
import { useAccount } from 'wagmi'

const HeldWritesList = dynamic(() => import('@/components/ui/HeldWritesList'), { ssr: false })

/**
 * Every write held for the connected account that needs the user, on every
 * chain: the SDK's line and its release. Each listed write is followed while
 * it is held, so one whose flow closed still settles. The list loads only
 * once an account is connected.
 */
export function HeldWritesNotice() {
  const { address } = useAccount()
  return address ? <HeldWritesList account={address} /> : null
}
