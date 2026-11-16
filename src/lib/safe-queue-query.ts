import { queryOptions } from '@tanstack/react-query'
import type { Address } from 'viem'
import type { JBChainId } from '@bananapus/nana-sdk-core'
import { readSafeQueue } from '@/lib/safe'

/**
 * A Safe's queue as display evidence: the tray, the queue card and the batch
 * dialog read it under this one key and select what they show. Signing and
 * execution read the queue themselves, fresh.
 */
export function safeQueueQueryOptions(chainId: JBChainId, safe: Address) {
  return queryOptions({
    queryKey: ['safeQueue', chainId, safe.toLowerCase()] as const,
    staleTime: 30_000,
    queryFn: () => readSafeQueue(chainId, safe),
  })
}

