'use client'

import type { JBChainId } from '@bananapus/nana-sdk-core'
import { useState } from 'react'
import { ChainIcon } from '@/components/ChainIcon'
import { SafeBatchDialog } from '@/components/project/SafeBatchDialog'
import { SafeBatchPresetDialog } from '@/components/project/SafeBatchPresetDialog'
import { useSafeBatch } from '@/components/project/SafeBatchProvider'
import { clientFor } from '@/lib/authority'
import { mirrorBatch, upsertStep } from '@/lib/safe-batch'
import { presetInfraAvailable, resolveMirrorValues } from '@/lib/safe-batch-presets'
import { chainName } from '@/lib/urn'

/**
 * The compact strip at the top of the Owner/Operator tab: one chip per chain
 * with queued steps, presets, mirroring, and clear. Nothing here sends.
 */
export function SafeBatchTray({ chainId }: { chainId: JBChainId }) {
  const batch = useSafeBatch()
  const [openChain, setOpenChain] = useState<JBChainId | null>(null)
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

  const source =
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
    <section className="card p-4" aria-label="Batch tray">
      <div className="flex flex-wrap items-center gap-2">
        <span className="field-label">Batch</span>
        {queuedChains.map(deployment => {
          const count = batch.stepsOn(deployment.chainId).length
          return (
            <button
              key={deployment.chainId}
              type="button"
              onClick={() => setOpenChain(deployment.chainId)}
              className="chip gap-1.5 bg-bluebs-50 text-bluebs-700 hover:bg-bluebs-100"
            >
              <ChainIcon chainId={deployment.chainId} size={14} />
              {count} queued · {chainName(deployment.chainId)}
            </button>
          )
        })}
        {!queuedChains.length ? (
          <span className="text-xs text-smoke-500">
            Nothing queued. Add owner actions with “Add to batch” or start from a preset.
          </span>
        ) : null}
        <span className="ml-auto flex flex-wrap items-center gap-2">
          {presetsAvailable ? (
            <button
              type="button"
              onClick={() => setPresetsOpen(true)}
              className="btn-secondary min-h-[32px] px-3 text-xs"
            >
              Presets
            </button>
          ) : null}
          {canMirror ? (
            <button
              type="button"
              onClick={() => void mirror()}
              disabled={mirroring}
              className="btn-secondary min-h-[32px] px-3 text-xs"
            >
              {mirroring ? 'Mirroring…' : 'Same on every chain'}
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
              Clear
            </button>
          ) : null}
        </span>
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
