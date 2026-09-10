'use client'

import type { JBChainId } from '@bananapus/nana-sdk-core'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { ChainIcon } from '@/components/ChainIcon'
import { useSafeBatch } from '@/components/project/SafeBatchProvider'
import { ModalShell } from '@/components/ui/ModalShell'
import { ErrorNote } from '@/components/ui/TxError'
import { clientFor } from '@/lib/authority'
import { buildStep, type BatchStep } from '@/lib/safe-batch'
import {
  MAX_TWAP_WINDOW,
  MIN_TWAP_WINDOW,
  resolvePreset,
  SAFE_BATCH_PRESETS,
  type PresetChainResolution,
  type SafeBatchPreset,
} from '@/lib/safe-batch-presets'
import { chainName } from '@/lib/urn'

type ChainPlan = PresetChainResolution & { chainId: JBChainId; projectId: number }

/**
 * Presets resolved per chain from live reads: a chain checklist, the steps
 * each chain still needs, and an editable TWAP window per carried pool.
 * "Add N steps to batch" queues them; nothing here submits.
 */
export function SafeBatchPresetDialog({ onClose }: { onClose: () => void }) {
  const batch = useSafeBatch()
  const [presetId, setPresetId] = useState(SAFE_BATCH_PRESETS[0]?.id ?? '')
  const preset = SAFE_BATCH_PRESETS.find(candidate => candidate.id === presetId) ?? null
  if (!batch || !preset) return null
  return (
    <ModalShell title="Presets" subtitle={preset.description} onClose={onClose} maxWidth="max-w-xl">
      {SAFE_BATCH_PRESETS.length > 1 ? (
        <div className="mb-4 flex flex-wrap gap-2">
          {SAFE_BATCH_PRESETS.map(candidate => (
            <button
              key={candidate.id}
              type="button"
              onClick={() => setPresetId(candidate.id)}
              className={`chip ${
                candidate.id === presetId ? 'bg-bluebs-50 text-bluebs-700' : 'bg-smoke-100 text-smoke-700'
              }`}
            >
              {candidate.title}
            </button>
          ))}
        </div>
      ) : null}
      <PresetPlan
        key={preset.id}
        preset={preset}
        deployments={batch.deployments}
        onAdd={steps => {
          batch.queue(steps)
          onClose()
        }}
      />
    </ModalShell>
  )
}

function PresetPlan({
  preset,
  deployments,
  onAdd,
}: {
  preset: SafeBatchPreset
  deployments: { chainId: JBChainId; projectId: number }[]
  onAdd: (steps: BatchStep[]) => void
}) {
  const query = useQuery({
    queryKey: [
      'safeBatchPreset',
      preset.id,
      deployments.map(row => `${row.chainId}:${row.projectId}`).join(','),
    ],
    staleTime: 15_000,
    retry: 1,
    queryFn: () =>
      Promise.all(
        deployments.map(async (deployment): Promise<ChainPlan> => {
          try {
            const resolution = await resolvePreset(preset, {
              ...deployment,
              client: clientFor(deployment.chainId),
            })
            return { ...deployment, ...resolution }
          } catch (error) {
            return {
              ...deployment,
              status: 'unavailable',
              message: `Could not read ${chainName(deployment.chainId)}: ${
                error instanceof Error ? error.message.split('\n')[0] : 'unknown error'
              }`,
              steps: [],
            }
          }
        }),
      ),
  })
  const plans = query.data ?? []
  const [deselected, setDeselected] = useState<Set<number>>(() => new Set())
  const [windows, setWindows] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)

  const selectedPlans = plans.filter(
    plan => plan.status === 'ready' && !deselected.has(plan.chainId),
  )
  const total = selectedPlans.reduce((sum, plan) => sum + plan.steps.length, 0)

  const finalSteps = (): BatchStep[] => {
    const steps: BatchStep[] = []
    for (const plan of selectedPlans) {
      for (const step of plan.steps) {
        const edited = windows[step.id]
        if (step.kind !== 'setPoolFor' || edited === undefined) {
          steps.push(step)
          continue
        }
        if (!/^\d+$/.test(edited)) {
          throw new Error(`${chainName(plan.chainId)}: enter the TWAP window in whole seconds.`)
        }
        const window = BigInt(edited)
        if (window < MIN_TWAP_WINDOW || window > MAX_TWAP_WINDOW) {
          throw new Error(
            `${chainName(plan.chainId)}: the hook only accepts a TWAP window between ${MIN_TWAP_WINDOW} and ${MAX_TWAP_WINDOW} seconds.`,
          )
        }
        steps.push(
          buildStep({
            kind: step.kind,
            chainId: step.chainId,
            projectId: step.projectId,
            values: { ...step.values, twapWindow: window },
            note: window === step.values.twapWindow ? step.note : undefined,
          }),
        )
      }
    }
    return steps
  }

  const add = () => {
    setError(null)
    try {
      const steps = finalSteps()
      if (!steps.length) {
        setError('Select at least one chain with steps to add.')
        return
      }
      onAdd(steps)
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : 'Could not add the preset.')
    }
  }

  return (
    <div>
      <p className="text-sm font-medium text-ink">{preset.title}</p>
      {query.isLoading ? (
        <p className="mt-3 text-sm text-bluebs-700" role="status">
          Reading each chain…
        </p>
      ) : query.isError ? (
        <p className="mt-3 text-sm text-red-700">Could not resolve this preset.</p>
      ) : (
        <ul className="mt-3 space-y-2" aria-label="Preset chains">
          {plans.map(plan => {
            const ready = plan.status === 'ready'
            const checked = ready && !deselected.has(plan.chainId)
            return (
              <li key={plan.chainId} className="rounded-xl border border-smoke-200 p-3">
                <label className={`flex items-center gap-2 text-sm ${ready ? 'cursor-pointer' : 'opacity-70'}`}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!ready}
                    onChange={() =>
                      setDeselected(current => {
                        const next = new Set(current)
                        if (next.has(plan.chainId)) next.delete(plan.chainId)
                        else next.add(plan.chainId)
                        return next
                      })
                    }
                    className="accent-bluebs-600"
                  />
                  <ChainIcon chainId={plan.chainId} size={18} />
                  <span className="font-medium text-ink">{chainName(plan.chainId)}</span>
                  {ready ? (
                    <span className="text-xs text-smoke-500">
                      {plan.steps.length} step{plan.steps.length === 1 ? '' : 's'}
                    </span>
                  ) : null}
                </label>
                {plan.message ? (
                  <p className="mt-1.5 pl-6 text-xs text-smoke-600">{plan.message}</p>
                ) : null}
                {ready ? (
                  <ol className="mt-2 space-y-1.5 pl-6">
                    {plan.steps.map((step, index) => (
                      <li key={step.id} className="text-xs text-smoke-700">
                        <span className="font-medium text-ink">
                          {index + 1}. {step.label}
                        </span>{' '}
                        {step.detail}
                        {step.note ? (
                          <span className="block text-amber-700">{step.note}</span>
                        ) : null}
                        {step.kind === 'setPoolFor' ? (
                          <label className="mt-1 flex items-center gap-2">
                            <span className="text-smoke-500">TWAP window (seconds)</span>
                            <input
                              type="text"
                              inputMode="numeric"
                              aria-label={`TWAP window on ${chainName(plan.chainId)} for ${step.detail}`}
                              value={windows[step.id] ?? String(step.values.twapWindow)}
                              onChange={event =>
                                setWindows(current => ({
                                  ...current,
                                  [step.id]: event.target.value.replace(/[^0-9]/g, ''),
                                }))
                              }
                              className="input-well min-h-[32px] w-28 px-2 text-xs tabular-nums"
                            />
                          </label>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
      {error ? <ErrorNote message={error} /> : null}
      <button
        type="button"
        onClick={add}
        disabled={query.isLoading || !total}
        className="btn-primary mt-4 min-h-[44px] w-full text-sm"
      >
        Add {total} step{total === 1 ? '' : 's'} to batch
      </button>
    </div>
  )
}
