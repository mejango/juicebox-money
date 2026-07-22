'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { getAccount } from '@wagmi/core'
import { BaseError, type Abi } from 'viem'
import {
  usePublicClient,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi'
import { useWallet } from '@/hooks/useWallet'
import { submitReviewedContractWrite } from '@/lib/contract-write'
import { requestContractTransactionReview } from '@/lib/transaction-review'
import { wagmiConfig } from '@/providers/Providers'

export type TxPhase =
  | 'idle'
  | 'review'
  | 'simulating'
  | 'signing'
  | 'pending'
  | 'success'
  | 'error'

export type TxRequest = {
  chainId: number
  address: `0x${string}`
  abi: Abi
  functionName: string
  args: readonly unknown[]
  value?: bigint
  label?: string
}

/**
 * The shared in-flight button copy: the fixed simulating/signing strings every
 * flow uses, the caller's `pending` progress text, and its `idle` label
 * (any non-in-flight phase falls through to `idle`). `confirm` overrides the
 * signing string for flows with more specific wallet copy.
 */
export function txPhaseLabel(
  phase: TxPhase,
  labels: { idle: string; pending: string; confirm?: string },
): string {
  if (phase === 'simulating') return 'Double-checking the transaction…'
  if (phase === 'signing') return labels.confirm ?? 'Confirm in your wallet…'
  if (phase === 'pending') return labels.pending
  return labels.idle
}

/** A friendly one-line message out of a viem/wagmi error. */
function friendlyTxError(e: unknown): string {
  if (e instanceof BaseError) {
    const short = e.shortMessage || e.message
    if (/user rejected|denied/i.test(short)) return 'Transaction cancelled.'
    return short
  }
  if (e instanceof Error) return e.message
  return 'Something went wrong.'
}

/**
 * The one transaction pipeline every project-page write flow uses
 * (website/ parity: exact review → simulate → send → status):
 *
 * 1. `send(request)` opens the global exact-payload review, then switches
 *    chains if needed and SIMULATES the approved call
 *    (nothing is ever sent that doesn't simulate clean), then requests the
 *    wallet signature and tracks the receipt.
 * 2. Phases drive the caller's UI; `error` carries a friendly message.
 */
export function useSafeTx(chainId: number) {
  const { isConnected, address } = useWallet()
  const publicClient = usePublicClient({ chainId })
  const { writeContractAsync } = useWriteContract()
  const { switchChainAsync } = useSwitchChain()

  const [phase, setPhase] = useState<TxPhase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [hash, setHash] = useState<`0x${string}` | null>(null)
  const inFlightRef = useRef(false)

  const receipt = useWaitForTransactionReceipt({
    hash: hash ?? undefined,
    chainId,
    query: { enabled: !!hash },
  })

  // A successful receipt *query* can still contain an onchain revert. Only the
  // receipt's status is authoritative. A receipt RPC error leaves the already
  // submitted transaction pending/unknown so the UI never invites a duplicate
  // submission merely because confirmation could not be read.
  const receiptReverted =
    phase === 'pending' && receipt.data?.status === 'reverted'
  const effectivePhase: TxPhase =
    phase === 'pending' && receipt.data?.status === 'success'
      ? 'success'
      : receiptReverted
        ? 'error'
        : phase
  const effectiveError = receiptReverted
    ? `Transaction reverted onchain${hash ? ` (${hash})` : ''}.`
    : phase === 'pending' && receipt.isError
      ? `Transaction${hash ? ` ${hash}` : ''} was submitted, but confirmation is temporarily unavailable. Check the explorer and do not submit it again yet.`
    : error

  useEffect(() => {
    if (effectivePhase === 'success' || effectivePhase === 'error') {
      inFlightRef.current = false
    }
  }, [effectivePhase])

  const send = useCallback(
    async (request: TxRequest) => {
      if (inFlightRef.current) return null
      if (!isConnected || !publicClient) {
        setError('Connect a wallet first.')
        setPhase('error')
        return null
      }
      inFlightRef.current = true
      setError(null)
      try {
        const txHash = await submitReviewedContractWrite({
          request,
          expectedAccount: address,
          review: async reviewed => {
            const approved = await requestContractTransactionReview(
              { ...reviewed, account: address },
              { label: reviewed.label },
            )
            if (!approved) throw new TransactionReviewCancelledError()
          },
          switchChain: async reviewedChainId => {
            await switchChainAsync({ chainId: reviewedChainId }).catch(() => {
              throw new Error('Switch your wallet to the right chain to continue.')
            })
          },
          currentAccount: () => getAccount(wagmiConfig).address,
          // Simulation is the safety gate: the exact reviewed call, args, and
          // value must succeed before a signature is requested. Only the
          // simulation result reaches the wallet writer.
          simulate: async reviewed => {
            const { request: simulated } = await publicClient.simulateContract({
              address: reviewed.address,
              abi: reviewed.abi,
              functionName: reviewed.functionName,
              args: reviewed.args as unknown[],
              value: reviewed.value,
              account: address,
            })
            return simulated
          },
          write: simulated => writeContractAsync(simulated),
          onPhase: setPhase,
        })
        setHash(txHash)
        setPhase('pending')
        return txHash
      } catch (e) {
        inFlightRef.current = false
        if (e instanceof TransactionReviewCancelledError) {
          setPhase('idle')
          return null
        }
        setError(friendlyTxError(e))
        setPhase('error')
        return null
      }
    },
    [isConnected, address, publicClient, switchChainAsync, writeContractAsync],
  )

  const reset = useCallback(() => {
    inFlightRef.current = false
    setPhase('idle')
    setError(null)
    setHash(null)
  }, [])

  return {
    phase: effectivePhase,
    /** True while the transaction is in flight: simulating/signing/pending. */
    busy:
      effectivePhase === 'simulating' ||
      effectivePhase === 'signing' ||
      effectivePhase === 'pending',
    error: effectiveError,
    hash,
    receipt: receipt.data ?? null,
    /** The transaction has a hash, but the current RPC could not confirm it. */
    confirmationUncertain: phase === 'pending' && receipt.isError,
    send,
    reset,
  }
}

class TransactionReviewCancelledError extends Error {
  readonly name = 'TransactionReviewCancelledError'
}
