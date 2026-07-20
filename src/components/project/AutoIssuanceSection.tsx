'use client'

import { JB_CHAINS, type JBChainId } from '@bananapus/nana-sdk-core'
import {
  buildAutoIssueTx,
  getAllRulesets,
  getAmountToAutoIssue,
  getTokenAddress,
} from '@bananapus/nana-sdk-core/v6'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { erc20Abi, type Address, type PublicClient } from 'viem'
import { usePublicClient } from 'wagmi'
import { ChainIcon } from '@/components/ChainIcon'
import { txPhaseLabel, useSafeTx } from '@/hooks/useSafeTx'
import { useWallet } from '@/hooks/useWallet'
import { TxError } from '@/components/ui/TxError'
import type { BsAutoIssuanceEvent } from '@/lib/loans-queries'
import {
  etherscanTxUrl,
  formatDate,
  formatTokenAmount,
  truncateAddress,
} from '@/lib/format'
import { chainName } from '@/lib/urn'

/** One auto-issuance allocation on a specific chain, deduped by
 *  (chain, stageId, beneficiary). */
type Row = {
  chainId: JBChainId
  projectId: number
  stageId: string
  /** 1-based stage number on that chain, or null if the stage is unknown. */
  stageNumber: number | null
  /** Unix seconds the stage starts (unlock), or null. */
  stageStart: number | null
  beneficiary: string
  /** Stored amount from the indexer, 18-dec fixed point. */
  storedCount: bigint
  /** Whether the indexer has seen this one distributed. */
  everIssued: boolean
}

/**
 * The Auto Issuance subtab (revnet only, website/ parity: renderAutoIssuance).
 * A revnet mints preset token amounts to beneficiaries when a stage starts;
 * anyone can trigger the mint (REVOwner.autoIssueFor). This enumerates every
 * allocation across ALL chains and stages, matches each to its stage for the
 * unlock date, and gates each Distribute on the authoritative on-chain
 * remaining amount.
 */
export function AutoIssuanceSection({
  chains,
  tokenSymbol = 'tokens',
}: {
  /** [chainId, projectId] pairs across the sucker group. */
  chains: [number, number][]
  tokenSymbol?: string
}) {
  const primaryClient = usePublicClient({
    chainId: chains[0]?.[0] as JBChainId,
  }) as PublicClient | undefined

  // The project's OWN token symbol (the passed prop is bendystraw's ACCOUNTING
  // symbol, e.g. "ETH" — the amounts are project tokens, e.g. MARKEE). Same
  // everywhere (omnichain ERC-20), so resolve it once on the primary chain.
  const { data: resolvedSym } = useQuery({
    queryKey: ['autoIssueSymbol', chains[0]?.join(':')],
    enabled: !!primaryClient && chains.length > 0,
    staleTime: 5 * 60_000,
    retry: 1,
    queryFn: async (): Promise<string | null> => {
      const token = await getTokenAddress(primaryClient!, {
        chainId: chains[0][0] as JBChainId,
        projectId: BigInt(chains[0][1]),
      })
      if (!token) return null
      return (await primaryClient!.readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'symbol',
      })) as string
    },
  })
  const sym = resolvedSym || (tokenSymbol !== 'tokens' ? tokenSymbol : '')

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['autoIssuancesAll', chains.map(c => c.join(':')).join(',')],
    staleTime: 60_000,
    retry: 1,
    queryFn: async (): Promise<Row[]> => {
      const perChain = await Promise.all(
        chains.map(async ([cid, pid]) => {
          const res = await fetch(
            `/api/auto-issuances?chainId=${cid}&projectId=${pid}`,
          )
          if (!res.ok) throw new Error('Auto-issuance data unavailable')
          const json = (await res.json()) as {
            stored: BsAutoIssuanceEvent[]
            issued: BsAutoIssuanceEvent[]
          }
          return { cid: cid as JBChainId, pid, ...json }
        }),
      )

      const rows: Row[] = []
      for (const { cid, pid, stored, issued } of perChain) {
        const issuedKeys = new Set(
          issued.map(e => `${e.stageId}:${e.beneficiary.toLowerCase()}`),
        )
        // Newest-first: the first stored row per key carries the latest amount.
        const seen = new Set<string>()
        for (const e of stored) {
          const k = `${e.stageId}:${e.beneficiary.toLowerCase()}`
          if (seen.has(k)) continue
          seen.add(k)
          let storedCount = 0n
          try {
            storedCount = BigInt(e.count)
          } catch {
            storedCount = 0n
          }
          if (storedCount === 0n) continue
          rows.push({
            chainId: cid,
            projectId: pid,
            stageId: e.stageId,
            stageNumber: null,
            stageStart: null,
            beneficiary: e.beneficiary,
            storedCount,
            everIssued: issuedKeys.has(k),
          })
        }
      }
      return rows
    },
  })

  const rows = data ?? []

  return (
    <div className="card p-5">
      <div>
        <span className="field-label">Auto issuance</span>
        <p className="mt-2 text-sm leading-relaxed text-smoke-700">
          When a stage begins, this revnet mints preset token amounts to the
          beneficiaries below. Anyone can trigger a mint once its stage has
          started.
        </p>
      </div>
      {isLoading ? (
        <p className="mt-3 text-sm text-smoke-500">Loading…</p>
      ) : isError ? (
        <p className="mt-3 text-sm text-smoke-700">
          Auto-issuance data is unavailable right now.
        </p>
      ) : rows.length === 0 ? (
        <p className="mt-3 text-sm leading-relaxed text-smoke-700">
          This revnet has no auto-issuances configured.
        </p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[620px] text-sm">
            <thead>
              <tr className="text-left text-xs text-smoke-500">
                <th className="pb-1.5 font-normal">Chain</th>
                <th className="pb-1.5 font-normal">Stage</th>
                <th className="pb-1.5 font-normal">Account</th>
                <th className="pb-1.5 text-right font-normal">
                  Amount{sym ? ` (${sym})` : ''}
                </th>
                <th className="pb-1.5 text-right font-normal">Unlock date</th>
                <th className="pb-1.5 text-right font-normal">Distribute</th>
              </tr>
            </thead>
            <tbody className="text-ink">
              {rows.map(row => (
                <AutoIssueRow
                  key={`${row.chainId}:${row.stageId}:${row.beneficiary}`}
                  row={row}
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

function AutoIssueRow({
  row,
  onDistributed,
}: {
  row: Row
  onDistributed: () => void
}) {
  const { chainId, projectId } = row
  const etherscanHost = JB_CHAINS[chainId]?.etherscanHostname
  const publicClient = usePublicClient({ chainId }) as PublicClient | undefined

  // The stage this allocation belongs to (for the stage number + unlock date),
  // matched by stored stageId against the chain's queued rulesets.
  const { data: stage } = useQuery({
    queryKey: ['autoIssueStage', chainId, projectId, row.stageId],
    enabled: !!publicClient,
    staleTime: 5 * 60_000,
    retry: 1,
    queryFn: async () => {
      const all = await getAllRulesets(publicClient!, {
        chainId,
        projectId: BigInt(projectId),
        size: 50n,
      })
      const sorted = [...all].sort((a, b) => a.ruleset.start - b.ruleset.start)
      const idx = sorted.findIndex(
        s => String(s.ruleset.id) === String(row.stageId),
      )
      return idx >= 0
        ? { number: idx + 1, start: sorted[idx].ruleset.start }
        : null
    },
  })

  const { data: remaining, refetch } = useQuery({
    queryKey: [
      'autoIssueAmount',
      chainId,
      projectId,
      row.stageId,
      row.beneficiary,
    ],
    enabled: !!publicClient,
    staleTime: 30_000,
    retry: 1,
    queryFn: () =>
      getAmountToAutoIssue(publicClient!, {
        chainId,
        revnetId: BigInt(projectId),
        stageId: BigInt(row.stageId),
        beneficiary: row.beneficiary as Address,
      }),
  })

  const available = (remaining ?? 0n) > 0n
  const status = available
    ? 'Available'
    : row.everIssued
      ? 'Distributed'
      : 'Not yet available'

  return (
    <tr className="border-t border-smoke-100 align-top">
      <td className="py-2 pr-3">
        <span className="flex items-center gap-1.5 whitespace-nowrap">
          <ChainIcon chainId={chainId} size={16} />
          {chainName(chainId)}
        </span>
      </td>
      <td className="py-2 pr-3 whitespace-nowrap">
        {stage ? `Stage ${stage.number}` : `#${row.stageId}`}
      </td>
      <td className="py-2 pr-3">
        {etherscanHost ? (
          <a
            href={`https://${etherscanHost}/address/${row.beneficiary}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-ink hover:underline"
          >
            {truncateAddress(row.beneficiary)}
          </a>
        ) : (
          truncateAddress(row.beneficiary)
        )}
      </td>
      <td className="py-2 text-right tabular-nums">
        {formatTokenAmount(available ? remaining! : row.storedCount)}
      </td>
      <td className="py-2 text-right whitespace-nowrap text-smoke-700">
        {stage?.start ? formatDate(stage.start) : '—'}
      </td>
      <td className="py-2 text-right">
        {available ? (
          <DistributeFlow
            chainId={chainId}
            projectId={projectId}
            stageId={row.stageId}
            beneficiary={row.beneficiary as Address}
            onDone={() => {
              refetch()
              onDistributed()
            }}
          />
        ) : (
          <span
            className={
              status === 'Distributed' ? 'text-smoke-500' : 'text-smoke-700'
            }
          >
            {status}
          </span>
        )}
      </td>
    </tr>
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

  const busy = checking || tx.busy

  const txUrl = tx.hash ? etherscanTxUrl(chainId, tx.hash) : null

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
    return <span className="text-xs text-emerald-600">Distributed</span>
  }

  return (
    <div className="flex flex-col items-end gap-0.5">
      <button
        onClick={handleDistribute}
        disabled={busy}
        className="text-xs font-medium text-bluebs-600 hover:text-bluebs-700 disabled:opacity-50"
      >
        {checking
          ? 'Checking…'
          : tx.phase === 'simulating'
            ? 'Double-checking…'
            : txPhaseLabel(tx.phase, {
                idle: 'Distribute',
                pending: 'Distributing…',
                confirm: 'Confirm in wallet…',
              })}
      </button>
      {tx.phase === 'pending' && txUrl ? (
        <a
          href={txUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[11px] text-smoke-500 underline underline-offset-2"
        >
          view transaction
        </a>
      ) : null}
      <TxError
        error={flowError ?? tx.error}
        className="max-w-[180px] text-[11px] leading-tight text-red-600"
      />
    </div>
  )
}
