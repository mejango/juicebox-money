'use client'

import type { JBChainId } from '@bananapus/nana-sdk-core'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { zeroAddress, type Address } from 'viem'
import { SafeBatchDialog } from '@/components/project/SafeBatchDialog'
import { SafeBatchPresetDialog } from '@/components/project/SafeBatchPresetDialog'
import { useSafeBatch } from '@/components/project/SafeBatchProvider'
import { TabShell } from '@/components/project/Tabs'
import { clientFor } from '@/lib/authority'
import { readSafeQueue } from '@/lib/safe'
import { safeAccountQueryOptions } from '@/lib/safe-account-query'
import { multiSendCallsOf } from '@bananapus/nana-sdk-core/safe'
import {
  hasSafeService,
  safeTransactionMatchesCall,
  safeTransactionUrl,
  usableSafeConfirmations,
  type SafeQueuedTransaction,
} from '@bananapus/nana-sdk-core/safe-service'
import { composeBatch, mirrorBatch, upsertStep, type BatchCall, type BatchStep } from '@/lib/safe-batch'
import { presetInfraAvailable, resolveMirrorValues } from '@/lib/safe-batch-presets'
import { chainName } from '@/lib/urn'

/** The calls as an order-free key, so a reordered tray still matches its proposal. */
function callsKey(calls: readonly BatchCall[]): string {
  return calls
    .map(call => `${call.to.toLowerCase()}:${call.data.toLowerCase()}:${call.value}`)
    .sort()
    .join('|')
}

/**
 * The pending zero-refund Safe proposal whose MultiSend holds exactly these
 * queued calls, with the Safe's live policy, if one is already queued: a
 * DELEGATECALL into any MultiSendCallOnly the SDK recognizes, since
 * Safe{Wallet} batches a 1.4.1 Safe through 1.4.1's. Only a Safe on a chain
 * with Safe's transaction service has a queue to read.
 */
function useProposedBatch(chainId: JBChainId, authority: Address | null, steps: BatchStep[]) {
  const key = steps.length ? callsKey(composeBatch(steps).calls) : null
  const account = useQuery({
    ...safeAccountQueryOptions(chainId, authority ?? zeroAddress),
    enabled: !!authority && !!key && hasSafeService(chainId),
    select: account => account.safe,
  })
  const info = account.isError ? null : account.data
  const tx = useQuery({
    queryKey: ['safeBatchProposed', chainId, authority, key],
    enabled: !!info,
    staleTime: 15_000,
    refetchInterval: 15_000,
    queryFn: async (): Promise<SafeQueuedTransaction | null> => {
      const { pending } = await readSafeQueue(chainId, authority!)
      return (
        pending.find(candidate => {
          // multiSendCallsOf reads only a recognized MultiSendCallOnly.
          const calls = multiSendCallsOf(candidate)
          return (
            !!calls &&
            callsKey(calls) === key &&
            safeTransactionMatchesCall(candidate, {
              to: candidate.to,
              data: candidate.data ?? '0x',
              operation: 1,
            })
          )
        }) ?? null
      )
    },
  }).data
  return info && tx ? { tx, info } : null
}

function QueuedChainPanel({
  chainId,
  authority,
  steps,
  onReview,
  onRemove,
}: {
  chainId: JBChainId
  authority: Address | null
  steps: BatchStep[]
  onReview: () => void
  onRemove: () => void
}) {
  const proposed = useProposedBatch(chainId, authority, steps)
  const link = proposed && authority && proposed.tx.safeTxHash
    ? safeTransactionUrl(chainId, authority, proposed.tx.safeTxHash)
    : null
  return (
    <>
      <div className="overflow-x-auto rounded-xl border border-smoke-200">
        <table className="w-full text-sm">
          <thead className="bg-smoke-50">
            <tr className="border-b border-smoke-200 text-left text-xs text-smoke-500">
              <th className="w-8 px-4 py-3 font-normal">#</th>
              <th className="whitespace-nowrap px-4 py-3 font-normal">Action</th>
              <th className="px-4 py-3 font-normal">Detail</th>
            </tr>
          </thead>
          <tbody>
            {steps.map((step, index) => (
              <tr key={step.id} className="border-b border-smoke-100 last:border-b-0">
                <td className="px-4 py-3 text-smoke-500">{index + 1}</td>
                <td className="whitespace-nowrap px-4 py-3 text-ink">{step.label}</td>
                <td className="px-4 py-3 text-smoke-700">{step.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {proposed ? (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm" role="status">
          <span className="text-bluebs-700">
            Already proposed on {chainName(chainId)} as Safe transaction #{proposed.tx.nonce}
            {` (${usableSafeConfirmations(proposed.tx, proposed.info.owners).length}/${proposed.info.threshold} signatures)`}
            . Sign or execute it under Pending multisig transactions.
          </span>
          {link ? (
            <a href={link} target="_blank" rel="noreferrer" className="text-bluebs-700 underline">
              Open in Safe ↗
            </a>
          ) : null}
          <button type="button" onClick={onRemove} className="text-smoke-700 underline">
            Remove from the batch
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={onReview}
          className="btn-primary mt-3 min-h-[36px] px-4 text-sm"
        >
          Review and propose on {chainName(chainId)}
        </button>
      )}
    </>
  )
}

/**
 * The batch card at the top of the Owner/Operator tab: one tab per chain with
 * queued steps, presets, mirroring, and clear. Nothing here sends.
 */
export function SafeBatchTray({ chainId }: { chainId: JBChainId }) {
  const batch = useSafeBatch()
  const [openChain, setOpenChain] = useState<JBChainId | null>(null)
  const [activeChainId, setActiveChainId] = useState<JBChainId | null>(null)
  const [presetsOpen, setPresetsOpen] = useState(false)
  const [mirroring, setMirroring] = useState(false)
  const [report, setReport] = useState<string | null>(null)
  if (!batch) return null

  const queuedChains = batch.deployments.filter(
    deployment => batch.stepsOn(deployment.chainId).length > 0,
  )
  const presetsAvailable = batch.deployments.some(deployment =>
    presetInfraAvailable(deployment.chainId),
  )
  if (!queuedChains.length && !presetsAvailable) return null

  // The batch shown in the active tab is the one mirrored to the other chains.
  const source =
    queuedChains.find(deployment => deployment.chainId === activeChainId) ??
    queuedChains.find(deployment => deployment.chainId === chainId) ??
    queuedChains[0] ??
    null
  const canMirror = !!source && batch.deployments.length > 1

  const mirror = async () => {
    if (!source || mirroring) return
    setMirroring(true)
    setReport(null)
    const lines: string[] = []
    try {
      const steps = batch.stepsOn(source.chainId)
      for (const deployment of batch.deployments) {
        if (deployment.chainId === source.chainId) continue
        const name = chainName(deployment.chainId)
        try {
          const result = await mirrorBatch(steps, deployment, (step, to) =>
            resolveMirrorValues(step, { ...to, client: clientFor(to.chainId) }),
          )
          if (result.steps.length) {
            let next = batch.stepsOn(deployment.chainId)
            for (const step of result.steps) next = upsertStep(next, step)
            batch.replace(deployment.chainId, next)
          }
          const skipped = result.skipped.map(
            entry => `${entry.step.label} skipped (${entry.reason})`,
          )
          lines.push(
            `${name}: ${result.steps.length} mirrored${
              skipped.length ? ` | ${skipped.join(' | ')}` : ''
            }`,
          )
        } catch (error) {
          lines.push(
            `${name}: could not mirror (${
              error instanceof Error ? error.message : 'unknown error'
            })`,
          )
        }
      }
      setReport(
        `Mirrored the ${chainName(source.chainId)} batch. ${lines.join('. ')}.`,
      )
    } finally {
      setMirroring(false)
    }
  }

  return (
    <section className="card p-5" aria-label="Batch tray">
      <span className="field-label">Batch</span>
      <p className="mt-2 text-sm leading-relaxed text-smoke-700">
        Actions you add with “Add to batch” queue here, one Safe proposal per
        chain. Nothing is sent until you review a chain’s batch.
      </p>

      {queuedChains.length ? (
        <div className="mt-4">
          <TabShell
            ariaLabel="Queued chains"
            tabs={queuedChains.map(deployment => {
              const steps = batch.stepsOn(deployment.chainId)
              return {
                label: `${chainName(deployment.chainId)} (${steps.length})`,
                content: (
                  <QueuedChainPanel
                    chainId={deployment.chainId}
                    authority={deployment.indexedAuthority}
                    steps={steps}
                    onReview={() => setOpenChain(deployment.chainId)}
                    onRemove={() => batch.clear(deployment.chainId)}
                  />
                ),
              }
            })}
            active={Math.max(
              0,
              queuedChains.findIndex(d => d.chainId === source?.chainId),
            )}
            onSelect={i => setActiveChainId(queuedChains[i].chainId)}
            listClassName="scrollbar-none flex gap-6 overflow-x-auto border-b border-smoke-200"
            buttonClassName="min-h-[40px] shrink-0 whitespace-nowrap border-b-2 px-1 font-agrandir text-sm font-medium transition-colors"
            panelClassName="pt-4"
          />
        </div>
      ) : (
        <p className="mt-4 text-xs text-smoke-500">
          Nothing queued. Add owner actions with “Add to batch” or start from a preset.
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {presetsAvailable ? (
          <button
            type="button"
            onClick={() => setPresetsOpen(true)}
            className="btn-secondary min-h-[32px] px-3 text-xs"
          >
            Start from a preset
          </button>
        ) : null}
        {canMirror && source ? (
          <button
            type="button"
            onClick={() => void mirror()}
            disabled={mirroring}
            className="btn-secondary min-h-[32px] px-3 text-xs"
          >
            {mirroring
              ? 'Copying…'
              : `Copy the ${chainName(source.chainId)} batch to every chain`}
          </button>
        ) : null}
        {queuedChains.length ? (
          <button
            type="button"
            onClick={() => {
              batch.clear()
              setReport(null)
            }}
            className="btn-secondary min-h-[32px] px-3 text-xs"
          >
            Clear all
          </button>
        ) : null}
      </div>
      {batch.notice ? (
        <p className="mt-2 text-xs text-bluebs-700" role="status">
          {batch.notice}
        </p>
      ) : null}
      {report ? (
        <p className="mt-2 text-xs text-smoke-700" role="status">
          {report}
        </p>
      ) : null}
      {openChain !== null ? (
        <SafeBatchDialog chainId={openChain} onClose={() => setOpenChain(null)} />
      ) : null}
      {presetsOpen ? (
        <SafeBatchPresetDialog onClose={() => setPresetsOpen(false)} />
      ) : null}
    </section>
  )
}
