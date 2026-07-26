'use client'

import { useQuery } from '@tanstack/react-query'
import { isAddress } from 'viem'
import { lookupEnsName } from '@/lib/ens'

/** Resolve an address's primary ENS name on mainnet. */
export function useEnsName(address: string | undefined) {
  return useQuery({
    queryKey: ['ensName', address?.toLowerCase()],
    queryFn: () => lookupEnsName(address!),
    enabled: !!address && isAddress(address),
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    retry: 1,
  })
}
