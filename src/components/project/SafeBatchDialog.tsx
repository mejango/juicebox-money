'use client'

import type { JBChainId } from '@bananapus/nana-sdk-core'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { type Abi, type AbiFunction, type Hex } from 'viem'
import { useSafeBatch } from '@/components/project/SafeBatchProvider'
import { TxConfirmDialog, type TxConfirmRow } from '@/components/ui/TxConfirmDialog'
import { clientFor, readAuthorityOf } from '@/lib/authority'
import { truncateAddress } from '@/lib/format'
import {
  checkBatchOrder,
  moveStep,
  removeStep,
  type BatchStep,
} from '@/lib/safe-batch'
import {
  batchActionLabel,
  resolveSafeBatchRoute,
  submitSafeBatch,
  type SafeBatchRoute,
} from '@/lib/safe-batch-submit'
import { chainName } from '@/lib/urn'

function routeDescription(route: SafeBatchRoute, count: number): string {
  if (route.kind === 'safe-app') return 'One MultiSend proposal from the Safe app'
  if (route.kind === 'safe-owner') return 'One MultiSend proposal signed by a Safe owner'
  if (route.kind === 'eoa') {
    return `${count} direct transaction${count === 1 ? '' : 's'} in order`
  }
  return route.reason
}

function authorityTag(route: SafeBatchRoute): string {
  if (route.authorityKind === 'safe') return 'Safe'
  if (route.authorityKind === 'eoa') return 'EOA'
  return route.authorityKind === 'contract' ? 'Contract' : 'Unknown'
}

function argumentText(value: unknown): string {
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return `[${value.map(argumentText).join(', ')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .map(([key, entry]) => `${key}: ${argumentText(entry)}`)
      .join(', ')}}`
  }
  return String(value)
}

/** The decoded call: `name(types)` and one row per named argument. */
function DecodedCall({ step }: { step: BatchStep }) {
  const fn = (step.abi as Abi).find(
    (item): item is AbiFunction =>
      item.type === 'function' && item.name === step.functionName,
  )
  return (
    <div className="mt-2 rounded-lg bg-grey-25 px-3 py-2">
      <p className="break-all font-mono text-xs text-ink">
        {step.contractName}.{step.functionName}(
        {fn?.inputs.map(input => input.type).join(', ') ?? ''})
      </p>
      {fn ? (
        <dl className="mt-1 space-y-0.5">
          {fn.inputs.map((input, index) => (
            <div key={`${input.name ?? 'arg'}-${index}`} className="flex gap-2 text-xs">
              <dt className="shrink-0 text-smoke-500">{input.name || `arg${index}`}</dt>
              <dd className="min-w-0 break-all font-mono text-ink">
                {argumentText(step.args[index])}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="mt-1 break-all font-mono text-[11px] text-smoke-500">
          {step.data}
        </p>
      )}
    </div>
  )
}

/**
 * The batch for one chain in the standard confirm dialog: who sends, how it
 * routes, the ordered steps with move/remove controls and decoded calldata,
 * and one primary action whose label follows the route.
 */
export function SafeBatchDialog({
  chainId,
  onClose,
}: {
  chainId: JBChainId
  onClose: () => void
}) {
  const batch = useSafeBatch()
  const deployment = batch?.deployments.find(
    candidate => candidate.chainId === chainId,
  )
  const liveSteps = batch?.stepsOn(chainId) ?? []
  const [frozen, setFrozen] = useState<BatchStep[] | null>(null)
  const steps = frozen ?? liveSteps
  const [busy, setBusy] = useState(false)
  const [complete, setComplete] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [proposalHash, setProposalHash] = useState<Hex | null>(null)

  const routeQuery = useQuery({
    queryKey: [
      'safeBatchRoute',
      chainId,
      deployment?.projectId ?? 0,
      deployment?.indexedAuthority ?? '',
      batch?.isRevnet ?? false,
    ],
    enabled: !!deployment,
    staleTime: 15_000,
    queryFn: async () => {
      if (!deployment) throw new Error('Unknown chain.')
      const authority = await readAuthorityOf(clientFor(chainId), deployment, {
        indexedOnly: batch?.isRevnet ?? false,
      })
      if (!authority) throw new Error('Could not resolve the project authority.')
      const route = await resolveSafeBatchRoute({ chainId, authority })
      return { authority, route }
    },
  })

  const order = checkBatchOrder(steps)
  const route = routeQuery.data?.route ?? null
  const authority = routeQuery.data?.authority ?? null
  const count = steps.length
  const preparing = routeQuery.isLoading

  const rows: TxConfirmRow[] = [
    { label: 'On', value: chainName(chainId) },
    {
      label: 'From',
      value: authority
        ? `${truncateAddress(authority)} (${route ? authorityTag(route) : '…'})`
        : routeQuery.isError
          ? 'Unknown'
          : '…',
      mono: true,
    },
    {
      label: 'Route',
      value: route ? routeDescription(route, count) : routeQuery.isError ? 'Unavailable' : '…',
    },
  ]

  const walletSteps =
    route?.kind === 'eoa'
      ? steps.map(step => ({ key: step.id, title: `${step.label} on ${chainName(chainId)}` }))
      : [{ key: 'proposal', title: `Propose batch of ${count} call${count === 1 ? '' : 's'} to Safe` }]

  const update = (next: BatchStep[]) => {
    if (!batch || busy || complete) return
    batch.replace(chainId, next)
  }

  const submit = async () => {
    if (!batch || !route || !authority || busy || complete) return
    if (route.kind === 'unavailable' || !order.ok || !count) return
    setBusy(true)
    setError(null)
    setFrozen(steps)
    try {
      const outcome = await submitSafeBatch({
        chainId,
        authority,
        steps,
        route,
        onProgress: setStatus,
        onStep: setActiveIndex,
        onProposed: hash => {
          setProposalHash(hash)
          batch.clear(chainId)
          setStatus(`Proposed to Safe as one batch of ${count} call${count === 1 ? '' : 's'}.`)
          setComplete(true)
        },
      })
      if (outcome.kind === 'eoa') {
        batch.clear(chainId)
        setActiveIndex(count)
        setStatus(`Sent ${count} transaction${count === 1 ? '' : 's'}.`)
        setComplete(true)
      } else if (outcome.kind === 'safe-app') {
        setStatus(
          `Proposed to Safe as one batch of ${count} calls and executed (tx ${truncateAddress(outcome.executionHash)}).`,
        )
        setComplete(true)
      } else if (outcome.result.status !== 'queued') {
        const result = outcome.result
        setStatus(
          result.status === 'executed'
            ? `Batch of ${count} calls executed (tx ${truncateAddress(result.transactionHash ?? '')}).`
            : result.status === 'waiting'
              ? `Batch of ${count} calls approved onchain; it executes once the Safe has enough approvals.`
              : `Batch of ${count} calls submitted; awaiting confirmation.`,
        )
        setComplete(true)
      }
    } catch (submitError) {
      setError(
        submitError instanceof Error ? submitError.message : 'Could not submit the batch.',
      )
      if (!proposalHash) setFrozen(null)
    } finally {
      setBusy(false)
    }
  }

  // Once a Safe proposal exists the queue is the record; waiting for its
  // execution must not hold the dialog hostage for days of co-signing.
  const locked = busy && !proposalHash
  const close = () => {
    if (locked) return
    onClose()
  }

  return (
    <TxConfirmDialog
      open
      eyebrow="Batch"
      title={complete ? `Batch on ${chainName(chainId)} submitted` : `Batch on ${chainName(chainId)}`}
      rows={rows}
      steps={walletSteps}
      activeIndex={busy ? Math.max(activeIndex, 0) : activeIndex}
      stepsIntro={
        route?.kind === 'eoa'
          ? undefined
          : 'Your wallet will ask for one action: the whole batch is one Safe proposal.'
      }
      preparing={preparing}
      status={preparing ? 'Checking the authority and route…' : status}
      error={error ?? (routeQuery.isError ? 'Could not verify the authority on this chain.' : null)}
      busy={locked}
      complete={complete}
      action={route ? batchActionLabel(route, count) : 'Submit batch'}
      actionDisabled={!route || route.kind === 'unavailable' || !order.ok || !count}
      onConfirm={() => void submit()}
      onClose={close}
    >
      {count ? (
        <ol className="space-y-2" aria-label="Batch steps">
          {steps.map((step, index) => {
            const problem = order.problems.find(entry => entry.index === index)
            return (
              <li
                key={step.id}
                className={`rounded-xl border px-3 py-2.5 ${
                  problem ? 'border-red-300 bg-red-50' : 'border-smoke-200 bg-white'
                }`}
              >
                <div className="flex items-start gap-2">
                  <span
                    aria-hidden="true"
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-smoke-300 text-xs text-smoke-600"
                  >
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-ink">{step.label}</p>
                    <p className="text-xs text-smoke-600">{step.detail}</p>
                    {step.note ? (
                      <p className="mt-1 text-xs text-amber-700">{step.note}</p>
                    ) : null}
                  </div>
                  {!complete ? (
                    <span className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        aria-label={`Move step ${index + 1} up`}
                        disabled={busy || index === 0}
                        onClick={() => update(moveStep(steps, index, index - 1))}
                        className="icon-button h-7 w-7 text-xs disabled:opacity-30"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        aria-label={`Move step ${index + 1} down`}
                        disabled={busy || index === steps.length - 1}
                        onClick={() => update(moveStep(steps, index, index + 1))}
                        className="icon-button h-7 w-7 text-xs disabled:opacity-30"
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        aria-label={`Remove step ${index + 1}`}
                        disabled={busy}
                        onClick={() => update(removeStep(steps, index))}
                        className="icon-button h-7 w-7 text-xs disabled:opacity-30"
                      >
                        ✕
                      </button>
                    </span>
                  ) : null}
                </div>
                <DecodedCall step={step} />
                {problem ? (
                  <p className="mt-2 text-xs text-red-700" role="alert">
                    {problem.message}
                  </p>
                ) : null}
              </li>
            )
          })}
        </ol>
      ) : (
        <p className="text-sm text-smoke-600">Nothing is queued on this chain.</p>
      )}
    </TxConfirmDialog>
  )
}
