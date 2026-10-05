'use client'

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
              <span className="mb-1 block font-medium">Deployment</span>
              <select className="min-h-11 w-full rounded border border-smoke-300 bg-white p-2" value={selected} onChange={event => onSelect(Number(event.target.value))}>
                {deployments.map((deployment, index) => (
                  <option key={`${deployment.chainId}:${deployment.projectId}:${deployment.version}`} value={index}>
                    {chainName(deployment.chainId)} · #{deployment.projectId} · V{deployment.version}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block font-medium">Operator address (optional)</span>
              <input value={operator} spellCheck={false} placeholder="0x…" className="min-h-11 w-full rounded border border-smoke-300 p-2" onChange={event => onOperatorChange(event.target.value.trim())} />
              <span className="mt-1 block text-xs text-smoke-600">Include an address to check its current shop permissions.</span>
            </label>
            {checking ? <p role="status">Checking contracts and project data…</p> : null}
            {error ? <p role="alert">{error}</p> : null}
            {report ? (
              <>
                <p className="text-xs text-smoke-600">Checked {report.checkedAt}{report.deployment.checkedBlock ? ` · Block ${report.deployment.checkedBlock}` : ''}</p>
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
                    <textarea aria-label="Deployment diagnostics" readOnly value={serialized} rows={10} className="w-full rounded border border-smoke-300 p-2 font-mono text-xs" onFocus={event => event.target.select()} />
                  </label>
                ) : null}
              </>
            ) : null}
          </div>
        </ModalShell>
  )
}
