'use client'

import { useParams } from 'next/navigation'
import { ProjectDataStatus } from '@/components/project/ProjectDataStatus'
import { isStaleDeploymentError } from '@/lib/deployment-errors'
import { parseUrn } from '@/lib/urn'

/** A failed identity read is unknown availability, never evidence of absence. */
export default function ProjectError({ error, retry }: { error: Error; retry: () => void }) {
  const params = useParams<{ urn: string }>()
  // Keep the outer boundary's existing one-time full reload for stale bundles.
  if (isStaleDeploymentError(error)) throw error
  const project = parseUrn(params.urn)
  return (
    <div className="mx-auto max-w-3xl px-4 py-12">
      <h1 className="font-agrandir text-2xl">Project details are unavailable</h1>
      <p className="mt-3 text-sm text-smoke-700">We couldn&apos;t verify this project&apos;s data. Its existence and configuration are unconfirmed.</p>
      <button type="button" className="btn-primary mt-5 min-h-11 px-4 py-2 text-sm" onClick={retry}>Retry</button>
      {project ? <ProjectDataStatus deployments={[{ ...project, version: 6 }]} /> : null}
    </div>
  )
}
