'use client'

import {
  JBCoreContracts,
  jbContractAddress,
  jbDirectoryAbi,
  jbTokensAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import { useMemo, useState } from 'react'
import { formatUnits, parseEther, zeroAddress, type Address } from 'viem'
import { useReadContract } from 'wagmi'
import { TxError } from '@/components/ui/TxError'
import { txPhaseLabel, useSafeTx } from '@/hooks/useSafeTx'
import { useWallet } from '@/hooks/useWallet'
import { buildBurnTokensRequest } from '@/lib/burnTokens'
import { formatTokenAmount } from '@/lib/format'

export function BurnTokensFlow({
  chainId,
  projectId,
  tokenSymbol = 'tokens',
  showHeading = true,
}: {
  chainId: JBChainId
  projectId: number
  tokenSymbol?: string
  /** The modal host supplies the dialog title. */
  showHeading?: boolean
}) {
  const { address, isConnected, openSignIn } = useWallet()
  const tx = useSafeTx(chainId)
  const [amount, setAmount] = useState('')
  const [memo, setMemo] = useState('')
  const [error, setError] = useState<string | null>(null)
  const tokenCount = useMemo(() => {
    try {
      return amount.trim() ? parseEther(amount.trim()) : 0n
    } catch {
      return 0n
    }
  }, [amount])
  const { data: balance, refetch } = useReadContract({
    abi: jbTokensAbi,
    address: jbContractAddress['6'][JBCoreContracts.JBTokens][chainId],
    functionName: 'totalBalanceOf',
    args: [address ?? zeroAddress, BigInt(projectId)],
    chainId,
    query: { enabled: !!address },
  })
  const { data: controller, refetch: refetchController } = useReadContract({
    abi: jbDirectoryAbi,
    address: jbContractAddress['6'][JBCoreContracts.JBDirectory][chainId],
    functionName: 'controllerOf',
    args: [BigInt(projectId)],
    chainId,
  })
  const exceedsBalance = balance !== undefined && tokenCount > balance

  async function burn() {
    if (!isConnected) return openSignIn()
    if (!address || !controller || tokenCount <= 0n || exceedsBalance) return
    setError(null)
    try {
      const [freshBalanceResult, freshControllerResult] = await Promise.all([
        refetch(),
        refetchController(),
      ])
      const freshBalance = freshBalanceResult.data
      const freshController = freshControllerResult.data
      if (freshBalance === undefined || tokenCount > freshBalance) {
        throw new Error('Your token balance changed. Review the amount.')
      }
      if (!freshController || freshController === zeroAddress) {
        throw new Error('The project has no active controller.')
      }
      const request = buildBurnTokensRequest({
          chainId,
          controller: freshController as Address,
          holder: address,
          projectId: BigInt(projectId),
          tokenCount,
          memo,
      })
      await tx.send(
        {
          ...request,
          label: `Permanently burn ${formatTokenAmount(tokenCount, 18)} ${tokenSymbol}`,
        },
        {
          reverify: async reviewed => {
            const [latestBalanceResult, latestControllerResult] =
              await Promise.all([refetch(), refetchController()])
            const latestBalance = latestBalanceResult.data
            const latestController = latestControllerResult.data
            if (latestBalance === undefined || tokenCount > latestBalance) {
              throw new Error('Your token balance changed. Review the amount.')
            }
            if (
              !latestController ||
              latestController === zeroAddress ||
              latestController.toLowerCase() !== reviewed.address.toLowerCase()
            ) {
              throw new Error('The project controller changed. Review again.')
            }
          },
        },
      )
      await refetch()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Burn failed.')
    }
  }

  return (
    <div>
      {showHeading ? (
        <h3 className="font-agrandir text-lg font-medium">Burn tokens</h3>
      ) : null}
      <p className="mt-1 text-sm text-smoke-700">
        Permanently remove tokens from supply without receiving treasury funds.
        Internal credits are burned before claimed ERC-20 tokens.
      </p>
      <p className="mt-2 text-sm text-smoke-700">
        {balance === undefined
          ? 'Checking your balance…'
          : `You hold ${formatTokenAmount(balance, 18)} ${tokenSymbol}.`}
      </p>
      <label className="mt-3 block">
        <span className="field-label">Amount to burn</span>
        <input
          className="field mt-1.5 w-full"
          inputMode="decimal"
          value={amount}
          onChange={event => setAmount(event.target.value)}
          placeholder="0"
        />
      </label>
      <button
        type="button"
        className="btn-secondary mt-2 text-xs"
        disabled={balance === undefined || balance === 0n}
        onClick={() => setAmount(balance ? formatUnits(balance, 18) : '')}
      >
        Use max
      </button>
      <label className="mt-3 block">
        <span className="field-label">Memo (optional)</span>
        <input
          className="field mt-1.5 w-full"
          value={memo}
          onChange={event => setMemo(event.target.value)}
          maxLength={256}
        />
      </label>
      {exceedsBalance ? (
        <p className="mt-2 text-sm text-red-600">That is more than you hold.</p>
      ) : null}
      <TxError error={error} />
      <div className="mt-4 flex justify-end">
        <button
          type="button"
          className="btn-primary min-h-[44px] px-5 text-sm"
          disabled={
            tx.busy ||
            (isConnected && (!controller || tokenCount <= 0n || exceedsBalance))
          }
          onClick={burn}
        >
          {txPhaseLabel(tx.phase, {
            idle: isConnected ? 'Burn tokens permanently' : 'Sign in to burn',
            pending: 'Burning tokens…',
          })}
        </button>
      </div>
    </div>
  )
}
