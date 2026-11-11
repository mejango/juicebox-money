'use client'

import { useState } from 'react'
import type { ProjectDeploymentCheck } from '@bananapus/nana-sdk-core/v6'
import { ModalShell } from '@/components/ui/ModalShell'
import type { ProjectDiagnosticReport } from '@/lib/project-diagnostics'
import { chainName } from '@/lib/urn'
import type { Deployment } from './ProjectDataStatus'

const STATUS: Record<ProjectDeploymentCheck['status'], string> = {
  passed: 'Verified',
  mismatch: 'Mismatch',
  unsupported: 'Custom / unsupported',
  unavailable: 'Unavailable',
  info: 'Information',
}
const CATEGORIES = [
  ['project', 'Project contracts'],
  ['hook', 'Hook wiring'],
  ['pricing', 'Shop pricing'],
  ['permissions', 'Permissions'],
] as const

export default function ProjectDeploymentDialog({
  deployments, selected, operator, checking, error, report, copyState,
  onClose, onCheckAgain, onSelect, onOperatorChange, onCopy,
}: {
  deployments: Deployment[]
  selected: number
  operator: string
  checking: boolean
  error: string | null
  report: ProjectDiagnosticReport | null
  copyState: 'idle' | 'copied' | 'manual'
  onClose: () => void
  onCheckAgain: () => void
  onSelect: (index: number) => void
  onOperatorChange: (operator: string) => void
  onCopy: () => Promise<void>
}) {
  const serialized = report ? JSON.stringify(report, null, 2) : ''
  const [operatorOpen, setOperatorOpen] = useState(!!operator)
  return (
        <ModalShell
          title="Check deployment"
          subtitle="Read-only checks of the selected project and its data availability."
          onClose={onClose}
          footer={(
            <div className="flex flex-wrap gap-4">
              <button type="button" className="btn-secondary min-h-11 px-4 py-2 text-sm" disabled={checking} onClick={onCheckAgain}>
                {checking ? 'Checking…' : 'Check again'}
              </button>
              {report ? (
                <button type="button" className="btn-primary min-h-11 px-4 py-2 text-sm" onClick={onCopy}>
                  {copyState === 'copied' ? 'Copied' : 'Copy diagnostics'}
                </button>
              ) : null}
            </div>
          )}
        >
          <div className="space-y-5 text-sm">
            <label className="block">
              <span className="field-label">Deployment</span>
              <select className="input-well select-caret mt-1.5 min-h-11 w-auto max-w-full px-3 pr-9 text-sm" value={selected} onChange={event => onSelect(Number(event.target.value))}>
                {deployments.map((deployment, index) => (
                  <option key={`${deployment.chainId}:${deployment.projectId}:${deployment.version}`} value={index}>
                    {chainName(deployment.chainId)}, #{deployment.projectId}, V{deployment.version}
                  </option>
                ))}
              </select>
            </label>
            <div>
              <label className="flex items-center gap-2.5">
                <input type="checkbox" checked={operatorOpen || !!operator} onChange={event => { setOperatorOpen(event.target.checked); if (!event.target.checked && operator) onOperatorChange('') }} />
                Check an address&apos;s shop permissions
              </label>
              {operatorOpen || operator ? (
                <input value={operator} spellCheck={false} autoComplete="off" placeholder="0x…" aria-label="Operator address" className="input-well mt-2 min-h-11 w-full px-3 font-mono text-sm" onChange={event => onOperatorChange(event.target.value.trim())} />
              ) : null}
            </div>
            {checking ? <p role="status">Checking contracts and project data…</p> : null}
            {error ? <p role="alert">{error}</p> : null}
            {report ? (
              <>
                <p className="text-xs text-smoke-600">Checked {report.checkedAt}{report.deployment.checkedBlock ? `, Block ${report.deployment.checkedBlock}` : ''}</p>
                {report.deployment.operator ? <p className="break-all text-xs text-smoke-600">Checked operator: {report.deployment.operator}</p> : null}
                <section aria-label="Indexer availability" className="rounded-lg border border-smoke-200 p-3">
                  <h3 className="font-medium">Indexer availability</h3>
                  <p className="mt-1">{report.indexer.message}</p>
                </section>
                {CATEGORIES.map(([category, title]) => {
                  const checks = report.deployment.checks.filter(check => check.category === category)
                  if (!checks.length) return null
                  return (
                    <section key={category} aria-label={title}>
                      <h3 className="font-medium">{title}</h3>
                      <ul className="mt-2 space-y-3">
                        {checks.map(check => (
                          <li key={check.id} className="rounded-lg border border-smoke-200 p-3">
                            <p className="font-medium">{check.label} <span className={check.status === 'mismatch' ? 'text-red-700' : 'text-smoke-600'}>— {STATUS[check.status]}</span></p>
                            <p className="mt-1 text-smoke-700">{check.message}</p>
                            {check.actual !== undefined ? <p className="mt-1 break-all text-xs">Actual: {check.actual}</p> : null}
                            {check.expected !== undefined ? <p className="mt-1 break-all text-xs">Expected: {check.expected}</p> : null}
                            {check.action ? <p className="mt-1 text-smoke-700">{check.action}</p> : null}
                          </li>
                        ))}
                      </ul>
                    </section>
                  )
                })}
                {copyState === 'manual' ? (
                  <label className="block">
                    <span className="mb-2 block">Clipboard unavailable. Select and copy the diagnostics below.</span>
                    <textarea aria-label="Deployment diagnostics" readOnly value={serialized} rows={10} className="input-well w-full p-2 font-mono text-xs" onFocus={event => event.target.select()} />
                  </label>
                ) : null}
              </>
            ) : null}
          </div>
        </ModalShell>
  )
}
