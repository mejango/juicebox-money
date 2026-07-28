'use client'

import type { Address } from 'viem'
import { useWallet } from '@/hooks/useWallet'
import { useViewAs } from '@/lib/viewAs'

/**
 * The account the site should render account-scoped READS for: the "View as"
 * address when the mode is active, otherwise the connected wallet.
 *
 * Never feed `address` into a transaction path — writes must keep using
 * `useWallet()` (the seams refuse to transact while view-as is active).
 */
export function useViewedAccount(): {
  address: Address | undefined
  connectedAddress: Address | undefined
  isViewAs: boolean
} {
  const { address: connectedAddress } = useWallet()
  const { viewAs, isViewAs } = useViewAs()
  return {
    address: viewAs ?? connectedAddress,
    connectedAddress,
    isViewAs,
  }
}
