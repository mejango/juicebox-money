'use client'

import { getAccount } from '@wagmi/core'
import { useCallback } from 'react'
import { useConfig, useSignTypedData, useSwitchChain } from 'wagmi'
import {
  permit2TypedData,
  type Permit2SignatureAuthorization,
} from '@/lib/permit2-swap'
import { requireTransactionReview } from '@/lib/transaction-review'
import { getViewAs, VIEW_AS_WRITE_BLOCKED } from '@/lib/viewAs'
import type { Address } from 'viem'

export function useReviewedPermit2Signature(options?: {
  reviewedInParent?: boolean
}) {
  const config = useConfig()
  const { signTypedDataAsync } = useSignTypedData()
  const { switchChainAsync } = useSwitchChain()

  const signPermit2Async = useCallback(
    async ({
      authorization,
      expectedAccount,
    }: {
      authorization: Permit2SignatureAuthorization
      expectedAccount: Address
    }) => {
      if (getViewAs()) throw new Error(VIEW_AS_WRITE_BLOCKED)
      const typedData = permit2TypedData(authorization)
      if (!options?.reviewedInParent) {
        await requireTransactionReview({
          title: 'Sign the swap authorization',
          calls: [],
          kind: 'authorization',
          authorization: typedData,
        })
      }
      let current = getAccount(config)
      if (
        !current.address ||
        current.address.toLowerCase() !== expectedAccount.toLowerCase()
      ) {
        throw new Error('Connected account changed. Review the payment again.')
      }
      if (current.chainId !== authorization.chainId) {
        await switchChainAsync({ chainId: authorization.chainId })
      }
      current = getAccount(config)
      if (
        !current.address ||
        current.address.toLowerCase() !== expectedAccount.toLowerCase() ||
        current.chainId !== authorization.chainId
      ) {
        throw new Error('Wallet account or network changed. Review the payment again.')
      }
      const signature = await signTypedDataAsync({
        account: expectedAccount,
        ...typedData,
      })
      const after = getAccount(config)
      if (
        !after.address ||
        after.address.toLowerCase() !== expectedAccount.toLowerCase() ||
        after.chainId !== authorization.chainId
      ) {
        throw new Error('Wallet account or network changed after signing. Nothing was sent.')
      }
      return signature
    },
    [config, options?.reviewedInParent, signTypedDataAsync, switchChainAsync],
  )

  return { signPermit2Async }
}
