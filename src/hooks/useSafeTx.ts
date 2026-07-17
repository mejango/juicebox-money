'use client'

import { useCallback, useState } from 'react'
import { BaseError, type Abi } from 'viem'
import {
  usePublicClient,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi'
import { useWallet } from '@/hooks/useWallet'

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
}

/** A friendly one-line message out of a viem/wagmi error. */
export function friendlyTxError(e: unknown): string {
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
 * (website/ parity: simulate → send → status; the caller renders its own
 * confirm step before calling send()):
 *
 * 1. `send(request)` switches chains if needed, SIMULATES the exact call
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

  const receipt = useWaitForTransactionReceipt({
    hash: hash ?? undefined,
    chainId,
    query: { enabled: !!hash },
  })

  // Fold receipt state into the phase without extra renders downstream.
  const effectivePhase: TxPhase =
    phase === 'pending' && receipt.isSuccess
      ? 'success'
      : phase === 'pending' && receipt.isError
        ? 'error'
        : phase

  const send = useCallback(
    async (request: TxRequest) => {
      if (!isConnected || !publicClient) {
        setError('Connect a wallet first.')
        setPhase('error')
        return null
      }
      setError(null)
      try {
        setPhase('simulating')
        await switchChainAsync({ chainId: request.chainId }).catch(() => {
          throw new Error('Switch your wallet to the right chain to continue.')
        })
        // Simulation is the safety gate: the exact call, args, and value
        // must succeed against live state before a signature is requested.
        await publicClient.simulateContract({
          address: request.address,
          abi: request.abi,
          functionName: request.functionName,
          args: request.args as unknown[],
          value: request.value,
          account: address,
        })
        setPhase('signing')
        const txHash = await writeContractAsync({
          chainId: request.chainId,
          address: request.address,
          abi: request.abi,
          functionName: request.functionName,
          args: request.args as unknown[],
          value: request.value,
        })
        setHash(txHash)
        setPhase('pending')
        return txHash
      } catch (e) {
        setError(friendlyTxError(e))
        setPhase('error')
        return null
      }
    },
    [isConnected, address, publicClient, switchChainAsync, writeContractAsync],
  )

  const reset = useCallback(() => {
    setPhase('idle')
    setError(null)
    setHash(null)
  }, [])

  return {
    phase: effectivePhase,
    error,
    hash,
    receipt: receipt.data ?? null,
    send,
    reset,
  }
}
