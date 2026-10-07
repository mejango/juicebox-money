'use client'

import type { JBChainId } from '@bananapus/nana-sdk-core'
import { queryOptions } from '@tanstack/react-query'
import type { Address } from 'viem'
import type { SafeInfo } from '@/lib/safe'

/** Shared display reads only. Transaction boundaries still read fresh Safe policy. */
export function safeAccountQueryOptions(chainId: JBChainId, address: Address) {
  return queryOptions({
    queryKey: ['safeAccount', chainId, address.toLowerCase()] as const,
    staleTime: 30_000,
    retry: false,
    queryFn: async (): Promise<{ safe: SafeInfo | null; accountType: 'Safe Multisig' | 'EOA' | 'Contract' }> => {
      const [{ readAuthorityIdentity }, { publicClient }] = await Promise.all([
        import('@bananapus/nana-sdk-core/safe'),
        import('@/lib/wallet-core'),
      ])
      const identity = await readAuthorityIdentity(publicClient(chainId), address)
      if (!identity) throw new Error('Could not verify this account. Retry the check.')
      return identity.kind === 'safe'
        ? { safe: { owners: identity.owners, threshold: identity.threshold }, accountType: 'Safe Multisig' }
        : { safe: null, accountType: identity.kind === 'eoa' ? 'EOA' : 'Contract' }
    },
  })
}
