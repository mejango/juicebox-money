import { JB_CHAINS, type JBChainId } from '@bananapus/nana-sdk-core'
import {
  getProjectDeploymentDiagnostics,
  describeProjectDataStatus,
  type ProjectDeploymentDiagnostics,
} from '@bananapus/nana-sdk-core/v6'
import { createPublicClient, type Address } from 'viem'
import { getProject, getSuckerGroupProjects, projectGroupIsIncomplete } from '@/lib/bendystraw'
import { jbCenterRpcTransport } from '@/lib/jbcenter-rpc'

export type ProjectDiagnosticReport = {
  checkedAt: string
  deployment: ProjectDeploymentDiagnostics
  indexer: {
    status: 'available' | 'missing' | 'incomplete' | 'unavailable'
    message: string
    linkedProjectsStatus?: 'available' | 'incomplete' | 'unavailable'
  }
}

async function readProjectIndexStatus(chainId: JBChainId, projectId: number): Promise<ProjectDiagnosticReport['indexer']> {
  const project = await getProject(chainId, projectId, { policy: 'no-store' })
  if (!project) return { status: 'missing', message: describeProjectDataStatus('missing') }
  if (project.suckerGroupId) {
    try {
      const members = await getSuckerGroupProjects(project.suckerGroupId, chainId, { policy: 'no-store' })
      if (projectGroupIsIncomplete(project, members)) {
        return { status: 'incomplete', linkedProjectsStatus: 'incomplete', message: 'The project record is available, but its linked project records are incomplete. Cross-chain totals may be incomplete.' }
      }
    } catch {
      return { status: 'incomplete', linkedProjectsStatus: 'unavailable', message: 'The project record is available, but its linked project request failed. Cross-chain totals may be incomplete.' }
    }
  }
  return {
    status: 'available',
    ...(project.suckerGroupId ? { linkedProjectsStatus: 'available' as const } : {}),
    message: `${describeProjectDataStatus('available')} Individual stats and activity may have separate availability.`,
  }
}

/** Independent reads: an unavailable indexer is not evidence of broken wiring. */
export async function readProjectDiagnostics(
  chainId: JBChainId,
  projectId: number,
  operator?: Address,
): Promise<ProjectDiagnosticReport> {
  const checkedAt = new Date().toISOString()
  const client = createPublicClient({
    chain: JB_CHAINS[chainId].chain,
    transport: jbCenterRpcTransport(chainId, 4_000),
  })
  const [deployment, indexed] = await Promise.allSettled([
    getProjectDeploymentDiagnostics(client, { chainId, projectId: BigInt(projectId), ...(operator ? { operator } : {}) }),
    readProjectIndexStatus(chainId, projectId),
  ])
  return {
    checkedAt,
    deployment: deployment.status === 'fulfilled'
      ? deployment.value
      : {
          version: 6,
          chainId,
          projectId: String(projectId),
          kind: 'unknown',
          checkedAt,
          checkedBlock: null,
          checks: [{
            id: 'contract-read',
            category: 'project',
            status: 'unavailable',
            label: 'Contract reads',
            message: 'Could not read the deployment. Its configuration has not been verified.',
            action: 'Retry the check.',
          }],
        },
    indexer: indexed.status === 'rejected'
      ? {
          status: 'unavailable',
          message: describeProjectDataStatus('unavailable'),
        }
      : indexed.value,
  }
}
