'use client'

import { getAccount, type Config } from '@wagmi/core'
import type { Address } from 'viem'
import { assertNoViewAs } from '@/lib/viewAs'

/** Capture the reviewed connector before preparation; check live authority
 * synchronously after the last await, immediately before signing or sending. */
export function captureWalletContext(
  config: Config,
  { account, chainId, message = 'Connected wallet changed. Review the transaction again.' }: {
    account: Address | undefined
    chainId: number
    message?: string
  },
): () => void {
  const connectorUid = getAccount(config).connector?.uid
  return () => {
    assertNoViewAs()
    const live = getAccount(config)
    if (!account || !live.address || live.address.toLowerCase() !== account.toLowerCase() ||
        live.chainId !== chainId || live.connector?.uid !== connectorUid) {
      throw new Error(message)
    }
  }
}
