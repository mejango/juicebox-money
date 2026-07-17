'use client'

import { JB_CHAINS, type JBChainId } from '@bananapus/nana-sdk-core'
import {
  buildAutoIssueTx,
  getAmountToAutoIssue,
} from '@bananapus/nana-sdk-core/v6'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import type { Address, PublicClient } from 'viem'
import { usePublicClient } from 'wagmi'
import { useSafeTx } from '@/hooks/useSafeTx'
import { useWallet } from '@/hooks/useWallet'
import type { BsAutoIssuanceEvent } from '@/lib/loans-queries'
import { formatTokenAmount, truncateAddress } from '@/lib/format'

/** A candidate auto-issuance, deduped by (stageId, beneficiary). */
type Candidate = {
  stageId: string
  beneficiary: string
  /** The stored amount from the indexer, 18-dec fixed point. */
  storedCount: bigint
  /** Whether the indexer has seen this one already distributed. */
  everIssued: boolean
}

/**
 * The Auto Issuance subtab (revnet only, website/ parity): a revnet mints
 * pre-configured token amounts to beneficiaries when a stage starts. Anyone
 * can trigger the mint (REVOwner.autoIssueFor, tx #21) once it's available —
 * this table enumerates the candidates from the indexer and gates each
 * Distribute button on the authoritative on-chain remaining amount.
 */
export function AutoIssuanceSection({
  chainId,
  projectId,
}: {
  chainId: JBChainId
  projectId: number
}) {
  const etherscanHost = JB_CHAINS[chainId]?.etherscanHostname

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['autoIssuances', chainId, projectId],
    staleTime: 60_000,
    retry: 1,
    queryFn: async () => {
      const res = await fetch(
        `/api/auto-issuances?chainId=${chainId}&projectId=${projectId}`,
      )
      if (!res.ok) throw new Error('Auto-issuance data unavailable')
      return (await res.json()) as {
        stored: BsAutoIssuanceEvent[]
        issued: BsAutoIssuanceEvent[]
      }
    },
  })

  const key = (stageId: string, beneficiary: string) =>
    `${stageId}:${beneficiary.toLowerCase()}`

  // One candidate per (stage, beneficiary). Events come back newest-first, so
  // the first stored row for a key carries the latest configured amount.
  const candidates: Candidate[] = (() => {
    if (!data) return []
    const issuedKeys = new Set(
      data.issued.map(e => key(e.stageId, e.beneficiary)),
    )
    const byKey = new Map<string, Candidate>()
    for (const e of data.stored) {
      const k = key(e.stageId, e.beneficiary)
      if (byKey.has(k)) continue
      let storedCount = 0n
      try {
        storedCount = BigInt(e.count)
      } catch {
        storedCount = 0n
      }
      byKey.set(k, {
        stageId: e.stageId,
        beneficiary: e.beneficiary,
        storedCount,
        everIssued: issuedKeys.has(k),
      })
    }
    return [...byKey.values()]
  })()

  return (
    <div className="card p-5">
      <span className="field-label">Auto issuance</span>
      <p className="mt-2 text-sm leading-relaxed text-smoke-700">
        When a stage begins, this revnet mints preset token amounts to the
        beneficiaries below. Anyone can trigger a mint once its stage has
        started.
      </p>

      {isLoading ? (
        <p className="mt-3 text-sm text-smoke-500">Loading…</p>
      ) : isError ? (
        <p className="mt-3 text-sm text-smoke-700">
          Auto-issuance data is unavailable right now.
        </p>
      ) : candidates.length === 0 ? (
        <p className="mt-3 text-sm leading-relaxed text-smoke-700">
          This revnet has no auto-issuances on {JB_CHAINS[chainId]?.name ?? 'this chain'}.
        </p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-smoke-500">
                <th className="pb-1.5 font-normal">Stage</th>
                <th className="pb-1.5 font-normal">Beneficiary</th>
                <th className="pb-1.5 text-right font-normal">Amount</th>
                <th className="pb-1.5 text-right font-normal">Status</th>
              </tr>
            </thead>
            <tbody className="text-ink">
              {candidates.map(c => (
                <CandidateRow
                  key={`${c.stageId}:${c.beneficiary}`}
                  chainId={chainId}
                  projectId={projectId}
                  candidate={c}
                  etherscanHost={etherscanHost}
                  onDistributed={refetch}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function CandidateRow({
  chainId,
  projectId,
  candidate,
  etherscanHost,
  onDistributed,
}: {
  chainId: JBChainId
  projectId: number
  candidate: Candidate
  etherscanHost?: string
  onDistributed: () => void
}) {
  const publicClient = usePublicClient({ chainId }) as PublicClient | undefined

  const { data: remaining, refetch } = useQuery({
    queryKey: [
      'autoIssueAmount',
      chainId,
      projectId,
      candidate.stageId,
      candidate.beneficiary,
    ],
    enabled: !!publicClient,
    staleTime: 30_000,
    retry: 1,
    queryFn: () =>
      getAmountToAutoIssue(publicClient!, {
        chainId,
        revnetId: BigInt(projectId),
        stageId: BigInt(candidate.stageId),
        beneficiary: candidate.beneficiary as Address,
      }),
  })

  const available = (remaining ?? 0n) > 0n
  const status = available
    ? 'Available'
    : candidate.everIssued
      ? 'Distributed'
      : 'Not yet available'

  return (
    <>
      <tr className="border-t border-smoke-100">
        <td className="py-1.5 pr-3">#{candidate.stageId}</td>
        <td className="py-1.5 pr-3">
          {etherscanHost ? (
            <a
              href={`https://${etherscanHost}/address/${candidate.beneficiary}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-ink hover:underline"
            >
              {truncateAddress(candidate.beneficiary)}
            </a>
          ) : (
            truncateAddress(candidate.beneficiary)
          )}
        </td>
        <td className="py-1.5 text-right">
          {formatTokenAmount(available ? remaining! : candidate.storedCount)}
        </td>
        <td className="py-1.5 text-right">
          <span
            className={
              available
                ? 'text-ink'
                : status === 'Distributed'
                  ? 'text-smoke-500'
                  : 'text-smoke-700'
            }
          >
            {status}
          </span>
        </td>
      </tr>
      {available ? (
        <tr>
          <td colSpan={4} className="pb-2">
            <DistributeFlow
              chainId={chainId}
              projectId={projectId}
              stageId={candidate.stageId}
              beneficiary={candidate.beneficiary as Address}
              onDone={() => {
                refetch()
                onDistributed()
              }}
            />
          </td>
        </tr>
      ) : null}
    </>
  )
}

/**
 * Distribute one auto-issuance (REVOwner.autoIssueFor). Permissionless, no
 * user inputs — the on-chain amount is re-read at submit and the transaction
 * is aborted if nothing is left, so the useSafeTx simulation plus that
 * re-read are the whole safety gate.
 */
function DistributeFlow({
  chainId,
  projectId,
  stageId,
  beneficiary,
  onDone,
}: {
  chainId: JBChainId
  projectId: number
  stageId: string
  beneficiary: Address
  onDone: () => void
}) {
  const publicClient = usePublicClient({ chainId }) as PublicClient | undefined
  const { isConnected, openSignIn } = useWallet()
  const tx = useSafeTx(chainId)

  const [checking, setChecking] = useState(false)
  const [flowError, setFlowError] = useState<string | null>(null)

  const busy =
    checking ||
    tx.phase === 'simulating' ||
    tx.phase === 'signing' ||
    tx.phase === 'pending'

  const chainMeta = JB_CHAINS[chainId]
  const txUrl = tx.hash
    ? `https://${chainMeta?.etherscanHostname}/tx/${tx.hash}`
    : null

  useEffect(() => {
    if (tx.phase === 'success') onDone()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tx.phase])

  const handleDistribute = async () => {
    if (busy) return
    if (!isConnected) {
      openSignIn()
      return
    }
    if (!publicClient) return
    setFlowError(null)
    setChecking(true)
    try {
      // Authoritative re-read: only send when the mint is still available.
      const amount = await getAmountToAutoIssue(publicClient, {
        chainId,
        revnetId: BigInt(projectId),
        stageId: BigInt(stageId),
        beneficiary,
      })
      if (amount <= 0n) {
        throw new Error('Nothing left to distribute for this stage.')
      }
      const request = buildAutoIssueTx({
        chainId,
        revnetId: BigInt(projectId),
        stageId: BigInt(stageId),
        beneficiary,
      })
      await tx.send(request)
    } catch (e) {
      setFlowError(e instanceof Error ? e.message : 'Something went wrong.')
    } finally {
      setChecking(false)
    }
  }

  if (tx.phase === 'success') {
    return (
      <div className="rounded-lg bg-split-50 px-3.5 py-2.5 text-xs leading-relaxed text-smoke-900">
        Distributed — the tokens were minted to the beneficiary.
        {txUrl ? (
          <>
            {' '}
            <a
              href={txUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-bluebs-600 underline underline-offset-2 hover:text-bluebs-700"
            >
              View transaction
            </a>
          </>
        ) : null}
      </div>
    )
  }

  return (
    <div>
      <button
        onClick={handleDistribute}
        disabled={busy}
        className="btn-secondary min-h-[36px] px-4 text-xs"
      >
        {checking
          ? 'Checking what can be distributed…'
          : tx.phase === 'simulating'
            ? 'Double-checking the transaction…'
            : tx.phase === 'signing'
              ? 'Confirm in your wallet…'
              : tx.phase === 'pending'
                ? 'Distributing…'
                : 'Distribute'}
      </button>
      {tx.phase === 'pending' && txUrl ? (
        <p className="mt-1.5 text-xs text-smoke-700">
          Waiting for confirmation —{' '}
          <a
            href={txUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2"
          >
            view transaction
          </a>
        </p>
      ) : null}
      {flowError || tx.error ? (
        <p className="mt-1.5 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700">
          {flowError ?? tx.error}
        </p>
      ) : null}
    </div>
  )
}
