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
import { getViewAs, VIEW_AS_WRITE_BLOCKED } from '@/lib/viewAs'
import { requestContractTransactionReview } from '@/lib/transaction-review'
import { wagmiConfig } from '@/providers/Providers'
import {
  isSafeConnection,
  SAFE_NONCE_GUIDANCE,
  waitForSafeExecutionHash,
} from '@/lib/safe-connector'

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

export type TxSendOptions = {
  reverify?: (request: TxRequest) => Promise<unknown>
  /**
   * The exact request was already rendered in a parent confirmation surface.
   * This skips only the second app-owned review; account checks, revalidation,
   * simulation, duplicate protection, and the wallet confirmation still run.
   */
  reviewedInParent?: boolean
  /**
   * Simulate against a confirmed prerequisite block instead of a load
   * balancer's potentially lagging `latest` view. This is required when the
   * reviewed write immediately follows an ERC-20 or Permit2 approval.
   */
  simulationBlockNumber?: bigint
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
  const [safeProposalHash, setSafeProposalHash] = useState<`0x${string}` | null>(
    null,
  )
  const inFlightRef = useRef(false)

  const receipt = useWaitForTransactionReceipt({
    hash: hash ?? undefined,
    chainId,
    query: { enabled: !!hash && !safeProposalHash },
  })

  useEffect(() => {
    if (!safeProposalHash) return
    const controller = new AbortController()
    void waitForSafeExecutionHash(chainId, safeProposalHash, {
      signal: controller.signal,
    })
      .then(executionHash => {
        setHash(executionHash)
        setSafeProposalHash(null)
      })
      .catch(reason => {
        if (reason instanceof DOMException && reason.name === 'AbortError') return
        setError(friendlyTxError(reason))
        setPhase('error')
      })
    return () => controller.abort()
  }, [chainId, safeProposalHash])

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
    async (
      request: TxRequest,
      options?: TxSendOptions,
    ) => {
      if (inFlightRef.current) return null
      if (getViewAs()) {
        setError(VIEW_AS_WRITE_BLOCKED)
        setPhase('error')
        return null
      }
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
            if (options?.reviewedInParent) return
            const approved = await requestContractTransactionReview(
              { ...reviewed, account: address },
              {
                label: reviewed.label,
                ...(isSafeConnection(wagmiConfig)
                  ? {
                      description: SAFE_NONCE_GUIDANCE,
                      confirmLabel: 'Agree & continue to Safe',
                    }
                  : {}),
              },
            )
            if (!approved) throw new TransactionReviewCancelledError()
          },
          switchChain: async reviewedChainId => {
            await switchChainAsync({ chainId: reviewedChainId }).catch(() => {
              throw new Error('Switch your wallet to the right chain to continue.')
            })
          },
          currentAccount: () => getAccount(wagmiConfig).address,
          reverify: options?.reverify,
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
              ...(options?.simulationBlockNumber !== undefined
                ? { blockNumber: options.simulationBlockNumber }
                : {}),
            })
            return simulated
          },
          write: simulated => writeContractAsync(simulated),
          onPhase: setPhase,
        })
        setHash(txHash)
        if (isSafeConnection(wagmiConfig)) setSafeProposalHash(txHash)
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
    setSafeProposalHash(null)
  }, [])

  return {
    phase: effectivePhase,
    /** True while the transaction is in flight: simulating/signing/pending. */
    busy:
      effectivePhase === 'simulating' ||
      effectivePhase === 'signing' ||
      effectivePhase === 'pending',
    /** Whether the connected writer is a Safe connector. */
    isSafe: isSafeConnection(wagmiConfig),
    error: effectiveError,
    hash,
    safeProposalHash,
    safeNonceGuidance: safeProposalHash ? SAFE_NONCE_GUIDANCE : null,
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
