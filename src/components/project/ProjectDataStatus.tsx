'use client'

import { describeProjectDataStatus } from '@bananapus/nana-sdk-core/v6'
import { useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState, useTransition } from 'react'
import { isAddress } from 'viem'
import dynamic from 'next/dynamic'
import type { ProjectDiagnosticReport } from '@/lib/project-diagnostics'
import { refreshProjectDisplay } from '@/app/actions/project-display'

export type Deployment = { chainId: number; projectId: number; version: number; operator?: string | null }
const ProjectDeploymentDialog = dynamic(() => import('./ProjectDeploymentDialog'), {
  loading: () => <p role="status">Opening deployment check…</p>,
})

type Notice = 'not-indexed' | 'indexer-error' | 'partial'

const NOTICE: Record<Notice, string> = {
  'not-indexed': `This project exists onchain. ${describeProjectDataStatus('missing')} Stats and activity are unavailable.`,
  'indexer-error': `Some project details are unavailable. This project exists onchain. ${describeProjectDataStatus('unavailable')}`,
  partial: `Some project details are unavailable. ${describeProjectDataStatus('incomplete')}`,
}
/** The report and its contract reads only begin when someone asks for a check. */
function ProjectDataStatusContents({
  deployments,
  notice,
}: {
  deployments: Deployment[]
  notice?: Notice
}) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const [refreshing, startRefresh] = useTransition()
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState(0)
  const [operator, setOperator] = useState(deployments[0]?.operator ?? '')
  const [report, setReport] = useState<ProjectDiagnosticReport | null>(null)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'manual'>('idle')
  const activeRequest = useRef<AbortController | null>(null)
  useEffect(() => () => activeRequest.current?.abort(), [])

  async function check(index: number, operatorAddress = operator) {
    activeRequest.current?.abort()
    const controller = new AbortController()
    activeRequest.current = controller
    setSelected(index)
    setOperator(operatorAddress)
    setReport(null)
    setCopyState('idle')
    setError(null)
    const deployment = deployments[index]
    if (!deployment) {
      setChecking(false)
      setError('This deployment is no longer available. Close this check and retry the project page.')
      return
    }
    if (operatorAddress && !isAddress(operatorAddress)) {
      setChecking(false)
      setError('Enter a valid operator address, or leave it blank.')
      return
    }
    if (deployment.version !== 6) {
      setChecking(false)
      setError('This deployment checker supports Juicebox V6 projects.')
      return
    }
    setChecking(true)
    try {
      const params = new URLSearchParams({
        chainId: String(deployment.chainId),
        projectId: String(deployment.projectId),
        version: String(deployment.version),
        ...(operatorAddress ? { operator: operatorAddress } : {}),
      })
      const response = await fetch(`/api/project-diagnostics?${params}`, {
        cache: 'no-store',
        signal: controller.signal,
      })
      if (!response.ok) throw new Error('Deployment check unavailable')
      const result = await response.json() as ProjectDiagnosticReport
      if (!controller.signal.aborted) setReport(result)
    } catch {
      if (!controller.signal.aborted) {
        setError('Could not complete the deployment check. Retry shortly.')
      }
    } finally {
      if (!controller.signal.aborted) setChecking(false)
    }
  }

  const serialized = report ? JSON.stringify(report, null, 2) : ''
  return (
    <div className={notice ? 'my-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm' : 'mt-3 text-sm'}>
      {notice ? <p role="status" className="text-smoke-700">{NOTICE[notice]}</p> : null}
      <div className={`flex flex-wrap items-center gap-4 ${notice ? 'mt-2' : ''}`}>
        {notice ? (
          <button
            type="button"
            className="font-medium underline underline-offset-4 disabled:opacity-50"
            disabled={refreshing}
            onClick={() => startRefresh(async () => {
              await Promise.all(deployments.map(deployment =>
                refreshProjectDisplay(deployment.chainId, deployment.projectId),
              )).catch(() => undefined)
              await queryClient.invalidateQueries()
              router.refresh()
            })}
          >
            {refreshing ? 'Retrying…' : 'Retry'}
          </button>
        ) : null}
        <button
          type="button"
          className={notice ? 'text-smoke-700 underline underline-offset-4 hover:text-ink' : 'btn-secondary min-h-[40px] px-4 text-sm'}
          onClick={() => { setOpen(true); void check(selected) }}
        >
          Check deployment
        </button>
      </div>
      {open ? (
        <ProjectDeploymentDialog
          deployments={deployments}
          selected={selected}
          operator={operator}
          checking={checking}
          error={error}
          report={report}
          copyState={copyState}
          onClose={() => { activeRequest.current?.abort(); setOpen(false) }}
          onCheckAgain={() => void check(selected)}
          onSelect={index => void check(index, deployments[index].operator ?? '')}
          onOperatorChange={value => {
            activeRequest.current?.abort()
            setChecking(false)
            setOperator(value)
            setReport(null)
            setCopyState('idle')
          }}
          onCopy={async () => {
            try {
              await navigator.clipboard.writeText(serialized)
              setCopyState('copied')
            } catch {
              setCopyState('manual')
            }
          }}
        />
      ) : null}
    </div>
  )
}

export function ProjectDataStatus(props: { deployments: Deployment[]; notice?: Notice }) {
  // Route refreshes can add, remove or reorder linked deployments. Remount the
  // read session so an old report cannot be shown under a different identity.
  const identity = props.deployments.map(row => `${row.chainId}:${row.projectId}:${row.version}:${row.operator ?? ''}`).join(',')
  return <ProjectDataStatusContents key={identity} {...props} />
}
