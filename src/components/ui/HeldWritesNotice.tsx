'use client'

import dynamic from 'next/dynamic'
import { useAccount } from 'wagmi'

const HeldWritesList = dynamic(() => import('@/components/ui/HeldWritesList'), { ssr: false })

/**
 * Every background write for the connected account, on every chain, in
 * whatever state it is: the SDK's line, its release, and a hash field for one
 * whose wallet reply was lost. Each listed write is followed while
 * it is held, so one whose flow closed still settles. The list loads only
 * once an account is connected.
 */
export function HeldWritesNotice() {
  const { address } = useAccount()
  return address ? <HeldWritesList account={address} /> : null
}
