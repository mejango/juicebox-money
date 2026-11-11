'use client'

import type { JBChainId } from '@bananapus/nana-sdk-core'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { type Abi, type AbiFunction, type Hex } from 'viem'
import { useSafeBatch } from '@/components/project/SafeBatchProvider'
import { useUnmountSignal } from '@/hooks/useUnmountSignal'
import { useWallet } from '@/hooks/useWallet'
import { TxProgress, type TxConfirmRow } from '@/components/ui/TxProgress'
import { withFailedStep } from '@/components/ui/TxSteps'
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
import { hasSafeService } from '@bananapus/nana-sdk-core/safe-service'
import { chainName } from '@/lib/urn'

/**
 * One submit of the batch: `signing` until the Safe proposal (or the direct
 * sends) exists, `proposed` while its execution is awaited, then `done` or
 * `failed`. A failure after the proposal keeps the proposed steps: the queue
 * holds them now.
 */
type SafeBatchRun =
  | { status: 'idle' }
  | { status: 'signing'; steps: BatchStep[]; step: number; line: string | null }
  | { status: 'proposed' | 'done'; steps: BatchStep[]; step: number; line: string | null; hash: Hex | null }
  | { status: 'failed'; steps: BatchStep[]; step: number; line: string | null; hash: Hex | null; error: string }

function routeDescription(route: SafeBatchRoute, count: number, chainId: JBChainId): string {
  if (route.kind === 'safe-app') return 'One MultiSend proposal from the Safe app'
  if (route.kind === 'safe-owner') {
    // No hosted Safe service on this chain: each signer approves the SafeTx hash onchain.
    return hasSafeService(chainId)
      ? 'One MultiSend proposal signed by a Safe owner'
      : 'One MultiSend batch approved onchain by each Safe owner'
  }
  if (route.kind === 'eoa') {
    return `${count} direct transaction${count === 1 ? '' : 's'} in order`
  }
  return route.reason
}

function authorityTag(route: SafeBatchRoute): string {
  if (route.authorityKind === 'safe') return 'Safe'
  if (route.authorityKind === 'eoa') return 'Wallet'
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
    <div className="mt-2 border-t border-smoke-100 pt-2">
      <p className="break-all font-mono text-xs text-ink">
        {step.contractName}.{step.functionName}(
        {fn?.inputs.map(input => input.type).join(', ') ?? ''})
      </p>
      {fn ? (
        <dl className="mt-1.5 space-y-1.5">
          {fn.inputs.map((input, index) => (
            <div key={`${input.name ?? 'arg'}-${index}`} className="text-xs">
              <dt className="text-smoke-500">{input.name || `arg${index}`}</dt>
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
  const queryClient = useQueryClient()
  const batch = useSafeBatch()
  const deployment = batch?.deployments.find(
    candidate => candidate.chainId === chainId,
  )
  const liveSteps = batch?.stepsOn(chainId) ?? []
  const [run, setRun] = useState<SafeBatchRun>({ status: 'idle' })
  const proposalHash = 'hash' in run ? run.hash : null
  const steps = run.status === 'idle' || (run.status === 'failed' && !proposalHash) ? liveSteps : run.steps
  const busy = run.status === 'signing' || run.status === 'proposed'
  const complete = run.status === 'proposed' || run.status === 'done' || (run.status === 'failed' && !!proposalHash)
  const status = run.status === 'idle' ? null : run.line
  const error = run.status === 'failed' ? run.error : null
  const activeIndex = run.status === 'idle' ? -1 : run.step
  const progress = (change: { step?: number; line?: string | null }) =>
    setRun(current => current.status === 'signing' || current.status === 'proposed' ? { ...current, ...change } : current)
  const { address: connected } = useWallet()
  // Closing the dialog ends its wait for the Safe to execute the batch; the
  // proposal stays queued, and Pending multisig transactions shows it.
  const flowSignal = useUnmountSignal()

  const routeQuery = useQuery({
    queryKey: [
      'safeBatchRoute',
      chainId,
      deployment?.projectId ?? 0,
      deployment?.indexedAuthority ?? '',
      batch?.isRevnet ?? false,
      // The route depends on who is connected: re-resolve on an account switch.
      connected ?? '',
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
      value: route ? routeDescription(route, count, chainId) : routeQuery.isError ? 'Unavailable' : '…',
    },
  ]

  const onchainApproval = route?.kind === 'safe-owner' && !hasSafeService(chainId)
  const submittedSteps =
    route?.kind === 'eoa'
      ? steps.map(step => ({ key: step.id, title: `${step.label} on ${chainName(chainId)}` }))
      : onchainApproval
        ? [{ key: 'proposal', title: `Approve batch of ${count} call${count === 1 ? '' : 's'} onchain` }]
        : [{ key: 'proposal', title: `Propose batch of ${count} call${count === 1 ? '' : 's'} to Safe` }]
  // A submit that stopped on an error names the step it stopped on.
  const walletSteps = withFailedStep(submittedSteps, activeIndex, !!error && !busy && !complete && activeIndex >= 0)

  const update = (next: BatchStep[]) => {
    if (!batch || busy || complete) return
    batch.replace(chainId, next)
  }

  const submit = async () => {
    if (!batch || !route || !authority || busy || complete) return
    if (route.kind === 'unavailable' || !order.ok || !count) return
    setRun(current => ({ status: 'signing', steps, step: activeIndex, line: current.status === 'idle' ? null : current.line }))
    try {
      const outcome = await submitSafeBatch({
        chainId,
        authority,
        steps,
        route,
        onProgress: line => progress({ line }),
        onStep: step => progress({ step }),
        signal: flowSignal(),
        onProposed: hash => {
          // The queue card does not poll; show the new proposal there now.
          void queryClient.invalidateQueries({ queryKey: ['safeQueues'] })
          batch.clear(chainId)
          const line = `Proposed to Safe as one batch of ${count} call${count === 1 ? '' : 's'}.`
          setRun(current => current.status === 'idle'
            ? current
            : current.status === 'signing' ? { ...current, status: 'proposed', hash, line } : { ...current, hash, line })
        },
      })
      let line: string | null = null
      let step: number | undefined
      if (outcome.kind === 'eoa') {
        batch.clear(chainId)
        step = count
        line = `Sent ${count} transaction${count === 1 ? '' : 's'}.`
      } else if (outcome.kind === 'safe-app') {
        line = `Proposed to Safe as one batch of ${count} calls and executed (tx ${truncateAddress(outcome.executionHash)}).`
      } else if (outcome.result.status !== 'queued') {
        const result = outcome.result
        line = result.status === 'executed'
          ? `Batch of ${count} calls executed (tx ${truncateAddress(result.transactionHash ?? '')}).`
          : result.status === 'waiting'
            ? `Batch of ${count} calls approved onchain; it executes once the Safe has enough approvals.`
            : `Batch of ${count} calls submitted; awaiting confirmation.`
      }
      setRun(current => current.status === 'signing' || current.status === 'proposed'
        ? { status: 'done', steps: current.steps, step: step ?? current.step, line: line ?? current.line, hash: 'hash' in current ? current.hash : null }
        : current)
    } catch (submitError) {
      const message = submitError instanceof Error ? submitError.message : 'Could not submit the batch.'
      setRun(current => current.status === 'signing' || current.status === 'proposed'
        ? { ...current, status: 'failed', hash: 'hash' in current ? current.hash : null, error: message }
        : current)
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
    <TxProgress
      open
      eyebrow="Batch"
      title={complete ? `Batch on ${chainName(chainId)} submitted` : `Batch on ${chainName(chainId)}`}
      rows={rows}
      steps={walletSteps}
      activeIndex={busy ? Math.max(activeIndex, 0) : activeIndex}
      stepsIntro={
        route?.kind === 'eoa'
          ? undefined
          : onchainApproval
            ? `${chainName(chainId)} has no Safe transaction service, so your wallet will send one transaction: an onchain approval of the whole batch as one Safe transaction. It executes once enough owners have approved.`
            : 'Your wallet will ask for one action: the whole batch is one Safe proposal.'
      }
      preparing={preparing}
      status={preparing ? 'Checking the authority and route…' : status}
      error={
        error ??
        (routeQuery.isError
          ? 'Could not verify the authority on this chain.'
          : route?.kind === 'unavailable'
            ? route.reason
            : null)
      }
      busy={locked}
      complete={complete}
      onClose={close}
      next={{ label: route ? batchActionLabel(route, count, chainId) : 'Submit batch', onClick: () => void submit(), disabled: !route || route.kind === 'unavailable' || !order.ok || !count }}
    >
      {count ? (
        <ol className="space-y-2" aria-label="Batch steps">
          {steps.map((step, index) => {
            const problem = order.problems.find(entry => entry.index === index)
            return (
              <li
                key={step.id}
                className={`rounded-xl border px-3 py-2.5 ${
                  problem ? 'border-red-300' : 'border-smoke-200'
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
    </TxProgress>
  )
}
