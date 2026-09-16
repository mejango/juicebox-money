'use client'

import type { JBChainId } from '@bananapus/nana-sdk-core'
import { useState } from 'react'
import { SafeBatchDialog } from '@/components/project/SafeBatchDialog'
import { SafeBatchPresetDialog } from '@/components/project/SafeBatchPresetDialog'
import { useSafeBatch } from '@/components/project/SafeBatchProvider'
import { TabShell } from '@/components/project/Tabs'
import { clientFor } from '@/lib/authority'
import { mirrorBatch, upsertStep } from '@/lib/safe-batch'
import { presetInfraAvailable, resolveMirrorValues } from '@/lib/safe-batch-presets'
import { chainName } from '@/lib/urn'

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
                    <button
                      type="button"
                      onClick={() => setOpenChain(deployment.chainId)}
                      className="btn-primary mt-3 min-h-[36px] px-4 text-sm"
                    >
                      Review and propose on {chainName(deployment.chainId)}
                    </button>
                  </>
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
