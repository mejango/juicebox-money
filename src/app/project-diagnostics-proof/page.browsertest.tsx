'use client'

import { useEffect, useState } from 'react'
import { ProjectDataStatus } from '@/components/project/ProjectDataStatus'

/** Deterministic browser surface for outages, chain changes, and copying reports. */
export default function ProjectDiagnosticsProofPage() {
  const [ready, setReady] = useState(false)
  const [linked, setLinked] = useState(true)
  useEffect(() => setReady(true), [])
  const deployments = [
    { chainId: 84532, projectId: 45, version: 6 },
    ...(linked ? [{ chainId: 1, projectId: 9, version: 6 }] : []),
  ]
  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-10" data-diagnostics-ready={ready}>
      <h1 className="font-agrandir text-3xl">Project data recovery</h1>
      <section aria-label="Unavailable project">
        <h2 className="font-agrandir text-xl">SQUEEZE</h2>
        <ProjectDataStatus deployments={deployments} notice="indexer-error" />
      </section>
      <section aria-label="Missing project record">
        <h2 className="font-agrandir text-xl">Project record missing</h2>
        <ProjectDataStatus deployments={deployments} notice="not-indexed" />
      </section>
      <section aria-label="Healthy project">
        <h2 className="font-agrandir text-xl">Available project</h2>
        <ProjectDataStatus deployments={deployments} />
      </section>
      <button type="button" className="btn-secondary" onClick={() => setLinked(false)}>Refresh without linked chain</button>
    </div>
  )
}
